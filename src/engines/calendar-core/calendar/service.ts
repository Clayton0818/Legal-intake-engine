// c91 — matter calendar services on the shared calendar_events table.
// Every change is audited (engine 'calendar-core') and queued for external
// sync (vendor-gated). Deadline events confirmed by a lawyer get a
// deadline-critical follow-up task (real clock, no grace, critical).

import { and, asc, eq, gte, inArray, lte, ne, sql, type SQL } from "drizzle-orm";
import { calendarEvents, tasks } from "@/db/tables/foundation";
import { calendarEventParties } from "@/db/tables/calendar-core";
import type { TenantTx } from "@/tenancy/withTenant";
import { audit, cancelTask, changeTaskDue, createTask, getFirmSettings, type Actor } from "@/core";
import { actorOf, requireWriter, type Staff } from "../actors";
import { CalendarCoreError, conflict, forbidden, invalid, notFound } from "../errors";
import { getMatter } from "../matters";
import { ENGINE, readCalendarCoreSettings } from "../settings";
import {
  agendaByDay,
  canCancelAs,
  canConfirmAs,
  deadlineTaskOwner,
  initialStatus,
  isDeadlineType,
  planReschedule,
  validateEventDraft,
  type CalendarEventRow,
  type CalendarView,
  type EventDraft,
} from "./events";
import { queueEventSync } from "./sync";

export const DEADLINE_TASK_KIND = "calendar-core.deadline_due";
export const LIMITATION_SOURCE_PREFIX = "limitation:";

export const EVENT_PARTY_ROLES = ["client", "witness", "opposing_counsel", "opposing_party", "mediator", "judge", "expert", "other"] as const;
export type EventPartyRole = (typeof EVENT_PARTY_ROLES)[number];

function isManagedByLimitationTracker(e: Pick<CalendarEventRow, "sourceRef">): boolean {
  return e.sourceRef?.startsWith(LIMITATION_SOURCE_PREFIX) ?? false;
}

export async function getEvent(tx: TenantTx, tenantId: string, eventId: string): Promise<CalendarEventRow> {
  const [row] = await tx.select().from(calendarEvents).where(and(eq(calendarEvents.tenantId, tenantId), eq(calendarEvents.id, eventId))).limit(1);
  if (!row) throw notFound("Calendar event");
  return row;
}

/**
 * Insert an event (no permission checks — callers do those). Used by the
 * calendar screen, the deadline calculator (always 'proposed') and the
 * limitation tracker.
 */
export async function insertEvent(
  tx: TenantTx,
  input: {
    tenantId: string;
    draft: EventDraft;
    status: "proposed" | "confirmed";
    createdByUserId: string | null;
    actor: Actor;
    now?: Date;
  }
): Promise<CalendarEventRow> {
  const errors = validateEventDraft(input.draft);
  if (errors.length > 0) throw invalid("The event is not valid.", errors);
  const now = input.now ?? new Date();
  const d = input.draft;
  if (d.matterId) await getMatter(tx, input.tenantId, d.matterId);
  if (input.status === "confirmed" && !input.createdByUserId) throw forbidden("Only a lawyer can confirm a date.");
  const [row] = await tx
    .insert(calendarEvents)
    .values({
      tenantId: input.tenantId,
      matterId: d.matterId,
      eventType: d.eventType,
      title: d.title.trim(),
      description: d.description ?? null,
      startsAt: d.startsAt,
      endsAt: d.endsAt ?? null,
      allDay: d.allDay ?? false,
      location: d.location ?? null,
      courtName: d.courtName ?? null,
      causeNumber: d.causeNumber ?? null,
      isDeadline: d.isDeadline ?? isDeadlineType(d.eventType),
      source: d.source,
      sourceRef: d.sourceRef ?? null,
      status: input.status,
      confirmedByUserId: input.status === "confirmed" ? input.createdByUserId : null,
      confirmedAt: input.status === "confirmed" ? now : null,
      createdByUserId: input.createdByUserId,
      assignedUserIds: [...new Set(d.assignedUserIds ?? [])],
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!row) throw new Error("insertEvent: insert failed.");
  await audit(tx, {
    tenantId: input.tenantId,
    engine: ENGINE,
    action: "calendar.event_created",
    entityType: "calendar_event",
    entityId: row.id,
    matterId: row.matterId,
    actor: input.actor,
    payload: { eventType: row.eventType, status: row.status, source: row.source, isDeadline: row.isDeadline, startsAt: row.startsAt.toISOString() },
  });
  if (row.status === "confirmed") await onConfirmed(tx, input.tenantId, row, input.actor, now);
  await queueEventSync(tx, input.tenantId, row, now);
  return row;
}

/** A person adds an event from the calendar screen. Lawyers may confirm in the same step. */
export async function createEvent(
  tx: TenantTx,
  input: {
    tenantId: string;
    staff: Staff;
    draft: Omit<EventDraft, "source">;
    confirmNow?: boolean;
    parties?: Array<{ partyId: string; role: EventPartyRole }>;
    now?: Date;
  }
): Promise<CalendarEventRow> {
  requireWriter(input.staff);
  const source = input.staff.role === "attorney" ? "lawyer_entry" : "staff_entry";
  const draft: EventDraft = { ...input.draft, source };
  const status = initialStatus(draft, input.staff, input.confirmNow ?? false);
  const row = await insertEvent(tx, {
    tenantId: input.tenantId,
    draft,
    status,
    createdByUserId: input.staff.userId,
    actor: actorOf(input.staff),
    now: input.now,
  });
  for (const p of input.parties ?? []) {
    await attachParty(tx, { tenantId: input.tenantId, staff: input.staff, eventId: row.id, partyId: p.partyId, role: p.role });
  }
  return row;
}

/** A lawyer confirms a proposed event (AI suggestion, court notice, calculator result, staff entry). */
export async function confirmEvent(
  tx: TenantTx,
  input: { tenantId: string; staff: Staff; eventId: string; now?: Date; internal?: boolean }
): Promise<CalendarEventRow> {
  const now = input.now ?? new Date();
  const event = await getEvent(tx, input.tenantId, input.eventId);
  if (isManagedByLimitationTracker(event) && !input.internal) {
    throw conflict("A limitation date is confirmed through its independent verification, not from the calendar.");
  }
  const ok = canConfirmAs(input.staff, event);
  if (!ok.ok) throw forbidden(ok.reason);
  const [row] = await tx
    .update(calendarEvents)
    .set({ status: "confirmed", confirmedByUserId: input.staff.userId, confirmedAt: now, updatedAt: now })
    .where(and(eq(calendarEvents.tenantId, input.tenantId), eq(calendarEvents.id, event.id), eq(calendarEvents.status, "proposed")))
    .returning();
  if (!row) throw conflict("The event is no longer waiting for confirmation.");
  await audit(tx, {
    tenantId: input.tenantId,
    engine: ENGINE,
    action: "calendar.event_confirmed",
    entityType: "calendar_event",
    entityId: row.id,
    matterId: row.matterId,
    actor: actorOf(input.staff),
    payload: { eventType: row.eventType, source: row.source, startsAt: row.startsAt.toISOString(), isDeadline: row.isDeadline },
  });
  await onConfirmed(tx, input.tenantId, row, actorOf(input.staff), now);
  await queueEventSync(tx, input.tenantId, row, now);
  return row;
}

/** Deadline-critical follow-up task when a deadline is confirmed (once per event). */
async function onConfirmed(tx: TenantTx, tenantId: string, event: CalendarEventRow, actor: Actor, now: Date): Promise<void> {
  if (!event.isDeadline || !event.matterId) return;
  if (event.eventType === "limitation_date") return; // the limitation tracker owns its filing task
  const settings = readCalendarCoreSettings(await getFirmSettings(tx, tenantId));
  if (!settings.deadlineTaskOnConfirm) return;
  const [existing] = await tx
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.tenantId, tenantId), eq(tasks.relatedCalendarEventId, event.id), eq(tasks.status, "open")))
    .limit(1);
  if (existing) return;
  const matter = await getMatter(tx, tenantId, event.matterId);
  const owner = deadlineTaskOwner(event, matter.assignedUserId);
  await createTask(
    tx,
    {
      tenantId,
      kind: DEADLINE_TASK_KIND,
      title: `Deadline: ${event.title}`,
      description: event.courtName ? `${event.courtName}${event.causeNumber ? ` — ${event.causeNumber}` : ""}` : null,
      owner,
      due: { at: event.startsAt },
      matterId: event.matterId,
      supervisorUserId: matter.assignedUserId && (owner.type !== "user" || owner.userId !== matter.assignedUserId) ? matter.assignedUserId : null,
      deadlineCritical: true,
      sourceCard: "c91",
      sourceRef: `calendar_event:${event.id}`,
      relatedCalendarEventId: event.id,
      createdBy: actor,
      engine: ENGINE,
    },
    { now }
  );
}

async function openRelatedTasks(tx: TenantTx, tenantId: string, eventId: string) {
  return tx.select().from(tasks).where(and(eq(tasks.tenantId, tenantId), eq(tasks.relatedCalendarEventId, eventId), eq(tasks.status, "open")));
}

/** Move an event. Confirmed deadlines/court dates need a reason; non-lawyer moves send them back to 'proposed'. */
export async function rescheduleEvent(
  tx: TenantTx,
  input: {
    tenantId: string;
    staff: Staff;
    eventId: string;
    startsAt: Date;
    endsAt?: Date | null;
    allDay?: boolean;
    reason?: string | null;
    now?: Date;
    internal?: boolean;
  }
): Promise<CalendarEventRow> {
  requireWriter(input.staff);
  const now = input.now ?? new Date();
  const event = await getEvent(tx, input.tenantId, input.eventId);
  if (event.status === "cancelled") throw conflict("A cancelled event cannot be moved.");
  if (isManagedByLimitationTracker(event) && !input.internal) {
    throw conflict("A limitation date can only be changed by a lawyer through the limitation tracker, with a reason.");
  }
  if (input.endsAt && input.endsAt.getTime() < input.startsAt.getTime()) throw invalid("The event must end after it starts.");
  const plan = planReschedule(event, input.staff);
  const reason = input.reason?.trim() ?? "";
  if (plan.reasonRequired && !reason) throw invalid("A reason is required to move a confirmed date or a deadline; it is logged.");
  const [row] = await tx
    .update(calendarEvents)
    .set({
      startsAt: input.startsAt,
      endsAt: input.endsAt === undefined ? event.endsAt : input.endsAt,
      allDay: input.allDay ?? event.allDay,
      status: plan.status,
      confirmedByUserId: plan.confirmedByUserId,
      confirmedAt: plan.status === "confirmed" ? now : null,
      updatedAt: now,
    })
    .where(and(eq(calendarEvents.tenantId, input.tenantId), eq(calendarEvents.id, event.id)))
    .returning();
  if (!row) throw notFound("Calendar event");
  await audit(tx, {
    tenantId: input.tenantId,
    engine: ENGINE,
    action: "calendar.event_rescheduled",
    entityType: "calendar_event",
    entityId: row.id,
    matterId: row.matterId,
    actor: actorOf(input.staff),
    reason: reason || null,
    payload: { from: event.startsAt.toISOString(), to: row.startsAt.toISOString(), statusBefore: event.status, statusAfter: row.status },
  });
  // Keep the deadline task honest. If the change still needs a lawyer, keep
  // the EARLIER of the two times so a reminder can never slip later unconfirmed.
  for (const t of await openRelatedTasks(tx, input.tenantId, event.id)) {
    const target = row.status === "confirmed" ? row.startsAt : new Date(Math.min(row.startsAt.getTime(), t.dueAt.getTime()));
    if (target.getTime() === t.dueAt.getTime()) continue;
    await changeTaskDue(tx, {
      tenantId: input.tenantId,
      taskId: t.id,
      dueAt: target,
      by: actorOf(input.staff),
      reason: reason || "Calendar event moved",
      engine: ENGINE,
    });
  }
  await queueEventSync(tx, input.tenantId, row, now);
  return row;
}

/** Cancel an event with a logged reason. Its open deadline tasks are cancelled with the same reason. */
export async function cancelEvent(
  tx: TenantTx,
  input: { tenantId: string; staff: Staff; eventId: string; reason: string; now?: Date; internal?: boolean }
): Promise<CalendarEventRow> {
  requireWriter(input.staff);
  const now = input.now ?? new Date();
  const reason = input.reason?.trim();
  if (!reason) throw invalid("A reason is required to cancel an event; it is logged.");
  const event = await getEvent(tx, input.tenantId, input.eventId);
  if (isManagedByLimitationTracker(event) && !input.internal) {
    throw conflict("A limitation date is closed through the limitation tracker (satisfied or withdrawn, with a reason).");
  }
  const ok = canCancelAs(input.staff, event);
  if (!ok.ok) throw forbidden(ok.reason);
  const [row] = await tx
    .update(calendarEvents)
    .set({ status: "cancelled", cancelledAt: now, cancelReason: reason, updatedAt: now })
    .where(and(eq(calendarEvents.tenantId, input.tenantId), eq(calendarEvents.id, event.id), ne(calendarEvents.status, "cancelled")))
    .returning();
  if (!row) throw conflict("The event is already cancelled.");
  await audit(tx, {
    tenantId: input.tenantId,
    engine: ENGINE,
    action: "calendar.event_cancelled",
    entityType: "calendar_event",
    entityId: row.id,
    matterId: row.matterId,
    actor: actorOf(input.staff),
    reason,
    payload: { eventType: row.eventType, statusBefore: event.status },
  });
  for (const t of await openRelatedTasks(tx, input.tenantId, event.id)) {
    await cancelTask(tx, { tenantId: input.tenantId, taskId: t.id, by: actorOf(input.staff), reason: `Calendar event cancelled: ${reason}`, engine: ENGINE });
  }
  await queueEventSync(tx, input.tenantId, row, now);
  return row;
}

export interface EventDetailsPatch {
  title?: string;
  description?: string | null;
  location?: string | null;
  courtName?: string | null;
  causeNumber?: string | null;
  assignedUserIds?: string[];
}

/** Edit non-date details (who, where, what). Dates go through rescheduleEvent. */
export async function updateEventDetails(
  tx: TenantTx,
  input: { tenantId: string; staff: Staff; eventId: string; patch: EventDetailsPatch; now?: Date }
): Promise<CalendarEventRow> {
  requireWriter(input.staff);
  const now = input.now ?? new Date();
  const event = await getEvent(tx, input.tenantId, input.eventId);
  if (event.status === "cancelled") throw conflict("A cancelled event cannot be edited.");
  const p = input.patch;
  if (p.title !== undefined && (!p.title.trim() || p.title.length > 200)) throw invalid("The title must be 1–200 characters.");
  const [row] = await tx
    .update(calendarEvents)
    .set({
      ...(p.title !== undefined ? { title: p.title.trim() } : {}),
      ...(p.description !== undefined ? { description: p.description } : {}),
      ...(p.location !== undefined ? { location: p.location } : {}),
      ...(p.courtName !== undefined ? { courtName: p.courtName } : {}),
      ...(p.causeNumber !== undefined ? { causeNumber: p.causeNumber } : {}),
      ...(p.assignedUserIds !== undefined ? { assignedUserIds: [...new Set(p.assignedUserIds)] } : {}),
      updatedAt: now,
    })
    .where(and(eq(calendarEvents.tenantId, input.tenantId), eq(calendarEvents.id, event.id)))
    .returning();
  if (!row) throw notFound("Calendar event");
  await audit(tx, {
    tenantId: input.tenantId,
    engine: ENGINE,
    action: "calendar.event_updated",
    entityType: "calendar_event",
    entityId: row.id,
    matterId: row.matterId,
    actor: actorOf(input.staff),
    payload: { changed: Object.keys(p) },
  });
  await queueEventSync(tx, input.tenantId, row, now);
  return row;
}

export async function attachParty(
  tx: TenantTx,
  input: { tenantId: string; staff: Staff; eventId: string; partyId: string; role: EventPartyRole }
): Promise<void> {
  requireWriter(input.staff);
  if (!(EVENT_PARTY_ROLES as readonly string[]).includes(input.role)) throw invalid(`Unknown role '${input.role}'.`);
  const event = await getEvent(tx, input.tenantId, input.eventId);
  await tx
    .insert(calendarEventParties)
    .values({ tenantId: input.tenantId, eventId: event.id, partyId: input.partyId, role: input.role, addedByUserId: input.staff.userId })
    .onConflictDoUpdate({
      target: [calendarEventParties.tenantId, calendarEventParties.eventId, calendarEventParties.partyId],
      set: { role: input.role },
    });
  await audit(tx, {
    tenantId: input.tenantId,
    engine: ENGINE,
    action: "calendar.party_attached",
    entityType: "calendar_event",
    entityId: event.id,
    matterId: event.matterId,
    actor: actorOf(input.staff),
    payload: { partyId: input.partyId, role: input.role },
  });
}

export async function detachParty(tx: TenantTx, input: { tenantId: string; staff: Staff; eventId: string; partyId: string }): Promise<void> {
  requireWriter(input.staff);
  const event = await getEvent(tx, input.tenantId, input.eventId);
  await tx
    .delete(calendarEventParties)
    .where(
      and(
        eq(calendarEventParties.tenantId, input.tenantId),
        eq(calendarEventParties.eventId, event.id),
        eq(calendarEventParties.partyId, input.partyId)
      )
    );
  await audit(tx, {
    tenantId: input.tenantId,
    engine: ENGINE,
    action: "calendar.party_detached",
    entityType: "calendar_event",
    entityId: event.id,
    matterId: event.matterId,
    actor: actorOf(input.staff),
    payload: { partyId: input.partyId },
  });
}

export async function getEventDetail(tx: TenantTx, tenantId: string, eventId: string) {
  const event = await getEvent(tx, tenantId, eventId);
  const parties = await tx
    .select({ partyId: calendarEventParties.partyId, role: calendarEventParties.role })
    .from(calendarEventParties)
    .where(and(eq(calendarEventParties.tenantId, tenantId), eq(calendarEventParties.eventId, eventId)));
  return { event, parties };
}

/** Firm-wide, per-lawyer or per-matter events in [from, to), soonest first. */
export async function listEvents(
  tx: TenantTx,
  tenantId: string,
  filter: { view: CalendarView; from: Date; to: Date; includeCancelled?: boolean; deadlinesOnly?: boolean; proposedOnly?: boolean; limit?: number }
): Promise<CalendarEventRow[]> {
  if (filter.to.getTime() <= filter.from.getTime()) throw new CalendarCoreError("'to' must be after 'from'.", 422);
  if (filter.to.getTime() - filter.from.getTime() > 400 * 86_400_000) throw new CalendarCoreError("Ask for at most 400 days at a time.", 422);
  const conds: SQL[] = [eq(calendarEvents.tenantId, tenantId), gte(calendarEvents.startsAt, filter.from), lte(calendarEvents.startsAt, filter.to)];
  if (!filter.includeCancelled) conds.push(ne(calendarEvents.status, "cancelled"));
  if (filter.deadlinesOnly) conds.push(eq(calendarEvents.isDeadline, true));
  if (filter.proposedOnly) conds.push(eq(calendarEvents.status, "proposed"));
  if (filter.view.kind === "matter") conds.push(eq(calendarEvents.matterId, filter.view.matterId));
  if (filter.view.kind === "lawyer") conds.push(sql`${filter.view.userId}::uuid = any(${calendarEvents.assignedUserIds})`);
  return tx
    .select()
    .from(calendarEvents)
    .where(and(...conds))
    .orderBy(asc(calendarEvents.startsAt))
    .limit(filter.limit ?? 1000);
}

/** The same, grouped into days in the firm's time zone. */
export async function agenda(tx: TenantTx, tenantId: string, filter: Parameters<typeof listEvents>[2]) {
  const settings = await getFirmSettings(tx, tenantId);
  const events = await listEvents(tx, tenantId, filter);
  return { timeZone: settings.timeZone, days: agendaByDay(events, settings.timeZone) };
}

/** Proposed events waiting for a lawyer, oldest first (the lawyer's confirmation queue). */
export async function listAwaitingConfirmation(tx: TenantTx, tenantId: string, filter: { matterIds?: string[]; limit?: number } = {}) {
  const conds: SQL[] = [eq(calendarEvents.tenantId, tenantId), eq(calendarEvents.status, "proposed")];
  if (filter.matterIds && filter.matterIds.length > 0) conds.push(inArray(calendarEvents.matterId, filter.matterIds));
  return tx
    .select()
    .from(calendarEvents)
    .where(and(...conds))
    .orderBy(asc(calendarEvents.startsAt))
    .limit(filter.limit ?? 200);
}
