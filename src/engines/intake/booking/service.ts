// c67 — book a consultation with the right lawyer once the conflict check
// clears (database operations).
//
// Reminders and no-show checks run on the REAL clock (a meeting time is a
// fixed instant); the lawyer's "hold consult and record outcome" task runs on
// business hours. Client messages carry no case facts and use gated wording;
// texts only with SMS opt-in; nothing to a channel marked unsafe (the core's
// resolveClientAddress enforces the DV-safe address).

import { and, asc, eq, gt, inArray, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import { parties, users } from "@/db/schema";
import { calendarEvents } from "@/db/tables/foundation";
import { intakeBusyBlocks, intakeCalendarConnections, intakeConsultations, intakeOutOfOffice } from "@/db/tables/intake";
import type { TenantTx } from "@/tenancy/withTenant";
import { isApproved, legalCopy } from "@/compliance/approvals";
import { RULE_GATES, VENDOR_GATES } from "@/compliance/gates";
import { raiseFlag } from "@/core/flags";
import { cancelTask, completeTask, createTask } from "@/core/tasks";
import { tasks } from "@/db/tables/foundation";
import type { NotificationChannel } from "@/core/notify";
import type { Actor } from "@/core/audit";
import type { ScheduledTaskRow } from "@/worker/hooks";
import { ACCEPTANCE_GATES, BOOKING_COPY, BOOKING_RULE_GATES } from "../gates";
import { LAWYER_ROLES, requireStaff, resolveEscalationContacts, STAFF_ROLES, userActor, type StaffUser } from "../common/actors";
import { loadIntakeContext, type IntakeContext } from "../common/context";
import { IntakeNotFoundError, IntakeRuleError, IntakeValidationError, requireReason } from "../common/errors";
import { recordIntakeEvent } from "../common/events";
import { ensureProspectiveMatter } from "../common/matters";
import { notifyParty } from "../common/notify";
import { cancelScheduledTasks, INTAKE_TASK_TYPES, payloadString, scheduleTask } from "../common/scheduling";
import { getSessionBundle, type SessionBundle } from "../common/sessions";
import { addBusinessDays, addHours, addMinutes } from "../common/time";
import { getConflictStatusForSession } from "../adapters/conflictStatus";
import { calendarSyncApproved } from "../adapters/calendarSync";
import { previewAssignment, runAutoAssignment } from "../assignment/service";
import { safetySuppressed } from "../emergency/service";
import { systemMoveMatter } from "../pipeline/service";
import { INTAKE_ENGINE, type BookingFormat } from "../settings";
import {
  availabilitySource,
  bookingBlockReasons,
  canTransition,
  consultEventTitle,
  feeStepFor,
  freeSlots,
  meetingTypeFor,
  noShowAction,
  reminderTimes,
  stageForOutcome,
  CONSULT_OUTCOMES,
  type BookingBlockReason,
  type ConsultOutcome,
  type Interval,
} from "./slots";

export type ConsultationRow = typeof intakeConsultations.$inferSelect;

export const CONSULT_TASK_KIND = "intake.consult_hold_and_record";
export const ATTENDANCE_TASK_KIND = "intake.consult_attendance";

/** Consult statuses that occupy a lawyer's time. */
const BLOCKING_STATUSES = ["held", "booked", "on_hold"] as const;

export interface LawyerSlots {
  lawyerUserId: string;
  displayName: string;
  source: "internal" | "external";
  slots: Interval[];
}

export type BookingOptions =
  | { offered: false; reasons: BookingBlockReason[]; message: string }
  | {
      offered: true;
      matterId: string;
      meetingType: "initial_meeting" | "paid_consult";
      fee: { step: string; note: string | null; feeCents: number | null };
      formats: BookingFormat[];
      lawyers: LawyerSlots[];
      unavailable: Array<{ lawyerUserId: string; reason: string }>;
      /** No trustworthy availability: offer a request-a-callback path instead (c67 failure path). */
      callbackOffered: boolean;
      message: string | null;
    };

function matterTypeOf(bundle: SessionBundle): string | null {
  const c = (bundle.session.classifierOutput ?? {}) as Record<string, unknown>;
  return typeof c.practiceArea === "string" && c.practiceArea !== "unknown" ? c.practiceArea : null;
}

function feeFor(ctx: IntakeContext, bundle: SessionBundle) {
  const meetingType = meetingTypeFor(matterTypeOf(bundle), ctx.settings.booking.alwaysPaidConsultMatterTypes);
  const fee = feeStepFor({
    meetingType,
    feeCents: ctx.settings.booking.consultFeeCents,
    destination: ctx.settings.booking.consultFeeDestination,
    feeTermsApproved: isApproved(BOOKING_RULE_GATES.consultFeeTerms.key),
    processorApproved: isApproved(VENDOR_GATES.paymentProcessor.key),
    trustRulesApproved: isApproved(RULE_GATES.trustAccounting.key),
  });
  return { meetingType, fee };
}

async function blockReasonsFor(tx: TenantTx, tenantId: string, bundle: SessionBundle): Promise<BookingBlockReason[]> {
  const conflict = await getConflictStatusForSession(tx, tenantId, bundle.session.id);
  return bookingBlockReasons({
    conflict: conflict.state,
    fitOutcome: bundle.state.fitOutcome,
    safetySuppressed: safetySuppressed(bundle.state),
    terminalState: bundle.session.terminalState,
    status: bundle.state.status,
  });
}

/** The lawyers whose calendars may be offered (c48 eligibility, firm `lawyerChoice`). */
async function bookableLawyers(tx: TenantTx, ctx: IntakeContext, matterId: string, now: Date): Promise<string[]> {
  if (ctx.settings.booking.lawyerChoice === "any_eligible") {
    const decision = await previewAssignment(tx, ctx.tenantId, matterId, now);
    return decision.ranked.map((r) => r.userId);
  }
  const run = await runAutoAssignment(tx, { tenantId: ctx.tenantId, matterId, trigger: "booking", now });
  if (run.status === "assigned" || run.status === "already_assigned") return [run.assigneeUserId];
  return [];
}

async function busyFor(tx: TenantTx, tenantId: string, userId: string, from: Date, to: Date, now: Date, excludeConsultId?: string): Promise<Interval[]> {
  const consults = await tx
    .select({ start: intakeConsultations.startsAt, end: intakeConsultations.endsAt, status: intakeConsultations.status, holdExpiresAt: intakeConsultations.holdExpiresAt, id: intakeConsultations.id })
    .from(intakeConsultations)
    .where(
      and(
        eq(intakeConsultations.tenantId, tenantId),
        eq(intakeConsultations.lawyerUserId, userId),
        inArray(intakeConsultations.status, [...BLOCKING_STATUSES]),
        lt(intakeConsultations.startsAt, to),
        gt(intakeConsultations.endsAt, from)
      )
    );
  const events = await tx
    .select({ start: calendarEvents.startsAt, end: calendarEvents.endsAt, allDay: calendarEvents.allDay })
    .from(calendarEvents)
    .where(
      and(
        eq(calendarEvents.tenantId, tenantId),
        ne(calendarEvents.status, "cancelled"),
        sql`${userId} = any(${calendarEvents.assignedUserIds})`,
        lt(calendarEvents.startsAt, to),
        or(isNull(calendarEvents.endsAt), gt(calendarEvents.endsAt, from))
      )
    );
  const blocks = await tx
    .select({ start: intakeBusyBlocks.startsAt, end: intakeBusyBlocks.endsAt })
    .from(intakeBusyBlocks)
    .where(and(eq(intakeBusyBlocks.tenantId, tenantId), eq(intakeBusyBlocks.userId, userId), lt(intakeBusyBlocks.startsAt, to), gt(intakeBusyBlocks.endsAt, from)));
  const ooo = await tx
    .select({ start: intakeOutOfOffice.startsAt, end: intakeOutOfOffice.endsAt })
    .from(intakeOutOfOffice)
    .where(and(eq(intakeOutOfOffice.tenantId, tenantId), eq(intakeOutOfOffice.userId, userId), lt(intakeOutOfOffice.startsAt, to), gt(intakeOutOfOffice.endsAt, from)));
  return [
    ...consults
      .filter((c) => c.id !== excludeConsultId)
      .filter((c) => c.status !== "held" || !c.holdExpiresAt || c.holdExpiresAt.getTime() > now.getTime())
      .map((c) => ({ start: c.start, end: c.end })),
    // Events without an end (or all-day) block a sensible default span.
    ...events.map((e) => ({ start: e.start, end: e.end ?? addHours(e.start, e.allDay ? 24 : 1) })),
    ...blocks,
    ...ooo,
  ];
}

async function lawyerAvailability(
  tx: TenantTx,
  ctx: IntakeContext,
  userId: string,
  now: Date,
  excludeConsultId?: string
): Promise<{ usable: boolean; source: "internal" | "external"; reason: string | null; slots: Interval[] }> {
  const b = ctx.settings.booking;
  const conns = await tx
    .select({ lastSyncedAt: intakeCalendarConnections.lastSyncedAt })
    .from(intakeCalendarConnections)
    .where(and(eq(intakeCalendarConnections.tenantId, ctx.tenantId), eq(intakeCalendarConnections.userId, userId), eq(intakeCalendarConnections.active, true)));
  const oldest = conns.length === 0 ? null : conns.map((c) => c.lastSyncedAt).reduce<Date | null>((min, d) => (!d || !min ? null : d < min ? d : min), conns[0]!.lastSyncedAt);
  const src = availabilitySource({ hasConnection: conns.length > 0, lastSyncedAt: oldest, now, staleMinutes: b.calendarStaleMinutes, syncApproved: calendarSyncApproved() });
  if (!src.usable) return { ...src, slots: [] };
  const earliest = addHours(now, b.sameDayMinimumLeadHours);
  const horizonEnd = addHours(now, b.horizonDays * 24);
  const busy = await busyFor(tx, ctx.tenantId, userId, addHours(earliest, -24), addHours(horizonEnd, 24), now, excludeConsultId);
  const slots = freeSlots(ctx.calendar, busy, { durationMinutes: b.durationMinutes, bufferMinutes: b.bufferMinutes, stepMinutes: b.slotStepMinutes, earliest, horizonEnd });
  return { ...src, slots };
}

async function flagCalendarUnavailable(tx: TenantTx, ctx: IntakeContext, matterId: string, now: Date): Promise<void> {
  const { intakeManagers } = await resolveEscalationContacts(tx, ctx.tenantId, ctx.settings);
  if (intakeManagers.length === 0) return;
  await raiseFlag(
    tx,
    {
      tenantId: ctx.tenantId,
      type: "intake.booking_calendar_unavailable",
      severity: "warning",
      audience: "internal",
      title: "Booking could not show availability",
      summary: "No eligible lawyer had trustworthy calendar availability; the person was offered a callback. Please call them to book.",
      matterId,
      recipients: { userIds: intakeManagers },
      dedupeKey: `intake.booking_calendar_unavailable:${matterId}`,
      sourceCard: "c67",
      engine: INTAKE_ENGINE,
    },
    { now }
  );
}

/** What the person (or staff) may book right now. */
export async function getBookingOptions(tx: TenantTx, input: { tenantId: string; intakeSessionId: string; now?: Date }): Promise<BookingOptions> {
  const now = input.now ?? new Date();
  const ctx = await loadIntakeContext(tx, input.tenantId);
  const bundle = await getSessionBundle(tx, input.tenantId, input.intakeSessionId);
  const reasons = await blockReasonsFor(tx, input.tenantId, bundle);
  if (reasons.length > 0) {
    await recordIntakeEvent(tx, { tenantId: input.tenantId, intakeSessionId: bundle.session.id, eventType: "booking_not_offered", ruleName: "booking.requires_clear_conflict", payload: { reasons } });
    // No reason is given to the person (conflicts are confidential, Rule 1.05).
    return { offered: false, reasons, message: legalCopy(BOOKING_COPY.followUpLater.key) };
  }
  const matter = await ensureProspectiveMatter(tx, input.tenantId, bundle.session.id, now);
  const { meetingType, fee } = feeFor(ctx, bundle);
  const lawyerIds = await bookableLawyers(tx, ctx, matter.id, now);
  const names = lawyerIds.length
    ? await tx.select({ id: users.id, name: users.displayName }).from(users).where(and(eq(users.tenantId, input.tenantId), inArray(users.id, lawyerIds)))
    : [];
  const lawyers: LawyerSlots[] = [];
  const unavailable: Array<{ lawyerUserId: string; reason: string }> = [];
  for (const id of lawyerIds) {
    const a = await lawyerAvailability(tx, ctx, id, now);
    if (!a.usable) unavailable.push({ lawyerUserId: id, reason: a.reason ?? "unavailable" });
    else lawyers.push({ lawyerUserId: id, displayName: names.find((n) => n.id === id)?.name ?? "Lawyer", source: a.source, slots: a.slots });
  }
  const callbackOffered = lawyers.every((l) => l.slots.length === 0);
  if (callbackOffered) await flagCalendarUnavailable(tx, ctx, matter.id, now);
  return {
    offered: true,
    matterId: matter.id,
    meetingType,
    fee: { step: fee.step, note: fee.note, feeCents: meetingType === "paid_consult" ? ctx.settings.booking.consultFeeCents : null },
    formats: ctx.settings.booking.formats,
    lawyers,
    unavailable,
    callbackOffered,
    message: callbackOffered ? legalCopy(BOOKING_COPY.followUpLater.key) : null,
  };
}

async function getConsultation(tx: TenantTx, tenantId: string, id: string): Promise<ConsultationRow> {
  const [row] = await tx.select().from(intakeConsultations).where(and(eq(intakeConsultations.tenantId, tenantId), eq(intakeConsultations.id, id))).limit(1);
  if (!row) throw new IntakeNotFoundError("Consultation");
  return row;
}

async function setStatus(tx: TenantTx, row: ConsultationRow, to: string, patch: Partial<typeof intakeConsultations.$inferInsert> = {}): Promise<ConsultationRow> {
  if (!canTransition(row.status, to)) throw new IntakeRuleError(`A consultation that is '${row.status}' cannot become '${to}'.`);
  const [updated] = await tx
    .update(intakeConsultations)
    .set({ ...patch, status: to, updatedAt: new Date() })
    .where(and(eq(intakeConsultations.id, row.id), eq(intakeConsultations.status, row.status)))
    .returning();
  if (!updated) throw new IntakeRuleError("The consultation changed at the same time; reload and try again.");
  return updated;
}

/**
 * Hold a slot for `holdMinutes` while the person confirms (c67 §4 Book 1).
 * Re-checks the conflict gate, the lawyer and that the slot is still free.
 */
export async function holdSlot(
  tx: TenantTx,
  input: {
    tenantId: string;
    intakeSessionId: string;
    lawyerUserId: string;
    startsAt: Date;
    format: BookingFormat;
    bookedByUserId?: string | null;
    previousConsultationId?: string | null;
    now?: Date;
  }
): Promise<ConsultationRow> {
  const now = input.now ?? new Date();
  const ctx = await loadIntakeContext(tx, input.tenantId);
  if (input.bookedByUserId) await requireStaff(tx, input.tenantId, input.bookedByUserId, STAFF_ROLES, "book a consultation");
  if (!ctx.settings.booking.formats.includes(input.format)) throw new IntakeValidationError(`The firm does not offer '${input.format}' consultations.`);
  const bundle = await getSessionBundle(tx, input.tenantId, input.intakeSessionId);
  const reasons = await blockReasonsFor(tx, input.tenantId, bundle);
  if (reasons.length > 0) throw new IntakeRuleError("Booking is not available for this inquiry yet.", { reasons });
  const matter = await ensureProspectiveMatter(tx, input.tenantId, bundle.session.id, now);
  const allowed = await bookableLawyers(tx, ctx, matter.id, now);
  if (!allowed.includes(input.lawyerUserId)) throw new IntakeRuleError("That lawyer's calendar is not available for this consultation.");

  // Serialise holds per lawyer so two people cannot take the same slot.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`intake.booking:${input.tenantId}:${input.lawyerUserId}`}))`);
  const availability = await lawyerAvailability(tx, ctx, input.lawyerUserId, now, input.previousConsultationId ?? undefined);
  const slot = availability.slots.find((s) => s.start.getTime() === input.startsAt.getTime());
  if (!availability.usable || !slot) {
    throw new IntakeRuleError("That time is no longer available. Please choose another slot.", {
      nextSlots: availability.slots.slice(0, 5).map((s) => s.start.toISOString()),
    });
  }
  const { meetingType, fee } = feeFor(ctx, bundle);
  const [row] = await tx
    .insert(intakeConsultations)
    .values({
      tenantId: input.tenantId,
      intakeSessionId: bundle.session.id,
      matterId: matter.id,
      partyId: bundle.state.partyId,
      lawyerUserId: input.lawyerUserId,
      meetingType,
      format: input.format,
      startsAt: slot.start,
      endsAt: slot.end,
      status: "held",
      holdExpiresAt: addMinutes(now, ctx.settings.booking.holdMinutes),
      feeCents: meetingType === "paid_consult" ? ctx.settings.booking.consultFeeCents : null,
      paymentStatus: fee.step,
      previousConsultationId: input.previousConsultationId ?? null,
      bookedByType: input.bookedByUserId ? "user" : "client",
      bookedByUserId: input.bookedByUserId ?? null,
    })
    .returning();
  if (!row) throw new Error("holdSlot: insert failed.");
  await recordIntakeEvent(tx, {
    tenantId: input.tenantId,
    intakeSessionId: bundle.session.id,
    matterId: matter.id,
    eventType: "consult_slot_held",
    actor: input.bookedByUserId ? userActor(input.bookedByUserId) : bundle.state.partyId ? { type: "client", partyId: bundle.state.partyId } : undefined,
    entityType: "consultation",
    entityId: row.id,
    payload: { lawyerUserId: input.lawyerUserId, startsAt: slot.start.toISOString(), format: input.format, meetingType, feeStep: fee.step },
  });
  return row;
}

async function smsOptedIn(tx: TenantTx, tenantId: string, partyId: string | null): Promise<boolean> {
  if (!partyId) return false;
  const [p] = await tx.select({ safeContact: parties.safeContact }).from(parties).where(and(eq(parties.tenantId, tenantId), eq(parties.id, partyId))).limit(1);
  return Boolean(p?.safeContact?.smsConsentAt) && p?.safeContact?.smsAllowed !== false;
}

async function clientChannels(tx: TenantTx, tenantId: string, partyId: string | null): Promise<NotificationChannel[]> {
  return (await smsOptedIn(tx, tenantId, partyId)) ? ["in_app", "email", "sms"] : ["in_app", "email"];
}

/**
 * Confirm a held slot (c67 §4 Book 3–4): consult booked, matter stage moves
 * to consultation scheduled, calendar entry + lawyer task created (hand-off
 * to the Calendar & deadline engine), confirmation queued, reminders and the
 * no-show check scheduled on the real clock.
 */
export async function confirmBooking(tx: TenantTx, input: { tenantId: string; consultationId: string; byUserId?: string | null; now?: Date }): Promise<ConsultationRow> {
  const now = input.now ?? new Date();
  const ctx = await loadIntakeContext(tx, input.tenantId);
  let byUser: StaffUser | null = null;
  if (input.byUserId) byUser = await requireStaff(tx, input.tenantId, input.byUserId, STAFF_ROLES, "confirm a consultation");
  const consult = await getConsultation(tx, input.tenantId, input.consultationId);
  if (consult.status !== "held") throw new IntakeRuleError(`This consultation is '${consult.status}', not a held slot.`);
  if (consult.holdExpiresAt && consult.holdExpiresAt.getTime() < now.getTime()) {
    await setStatus(tx, consult, "expired");
    throw new IntakeRuleError("The hold on this time expired. Please choose a slot again.");
  }
  const bundle = await getSessionBundle(tx, input.tenantId, consult.intakeSessionId);
  const reasons = await blockReasonsFor(tx, input.tenantId, bundle);
  if (reasons.length > 0) throw new IntakeRuleError("Booking is not available for this inquiry.", { reasons });
  if (!consult.matterId) throw new IntakeRuleError("The consultation has no matter.");

  const [party] = bundle.state.partyId
    ? await tx.select({ fullName: parties.fullName }).from(parties).where(and(eq(parties.tenantId, input.tenantId), eq(parties.id, bundle.state.partyId))).limit(1)
    : [];
  const lawyerConfirms = byUser !== null && byUser.role === "attorney";
  const [event] = await tx
    .insert(calendarEvents)
    .values({
      tenantId: input.tenantId,
      matterId: consult.matterId,
      eventType: "consultation",
      title: consultEventTitle(party?.fullName ?? null),
      startsAt: consult.startsAt,
      endsAt: consult.endsAt,
      location: consult.format === "in_person" ? "Office" : null,
      source: "consult_booking",
      sourceRef: `intake_consultation:${consult.id}`,
      // Proposed until a lawyer confirms it on the calendar (the calendar engine owns confirmation).
      status: lawyerConfirms ? "confirmed" : "proposed",
      confirmedByUserId: lawyerConfirms ? byUser!.id : null,
      confirmedAt: lawyerConfirms ? now : null,
      createdByUserId: input.byUserId ?? null,
      assignedUserIds: [consult.lawyerUserId],
    })
    .returning();
  const booked = await setStatus(tx, consult, "booked", {
    calendarEventId: event?.id ?? null,
    holdExpiresAt: null,
    // Video links come from the video provider once its DPA is approved; until then staff add one.
    videoLink: null,
  });
  await systemMoveMatter(tx, { tenantId: input.tenantId, matterId: consult.matterId, systemStage: "consultation_scheduled", via: "system", reason: "Consultation booked" });
  await createTask(
    tx,
    {
      tenantId: input.tenantId,
      kind: CONSULT_TASK_KIND,
      title: "Hold the consultation and record the outcome",
      owner: { type: "user", userId: consult.lawyerUserId },
      due: { hours: ctx.settings.booking.consultHoldTaskBusinessHours, clock: "business", from: consult.endsAt },
      matterId: consult.matterId,
      intakeSessionId: consult.intakeSessionId,
      relatedCalendarEventId: event?.id ?? null,
      sourceCard: "c67",
      sourceRef: `intake_consultation:${consult.id}`,
      engine: INTAKE_ENGINE,
    },
    { now, calendar: ctx.calendar }
  );
  if (booked.partyId) {
    await notifyParty(
      tx,
      {
        tenantId: input.tenantId,
        partyId: booked.partyId,
        templateKey: BOOKING_COPY.confirmation.key,
        channels: await clientChannels(tx, input.tenantId, booked.partyId),
        matterId: booked.matterId,
        dedupeBase: `intake.consult_confirmation:${booked.id}`,
      },
      { now }
    );
  }
  await scheduleConsultTimers(tx, ctx, booked, now);
  await recordIntakeEvent(tx, {
    tenantId: input.tenantId,
    intakeSessionId: booked.intakeSessionId,
    matterId: booked.matterId,
    eventType: "consult_booked",
    actor: input.byUserId ? userActor(input.byUserId) : booked.partyId ? { type: "client", partyId: booked.partyId } : undefined,
    entityType: "consultation",
    entityId: booked.id,
    payload: {
      lawyerUserId: booked.lawyerUserId,
      startsAt: booked.startsAt.toISOString(),
      format: booked.format,
      paymentStatus: booked.paymentStatus,
      calendarEventStatus: event?.status ?? null,
      videoProviderApproved: isApproved(BOOKING_RULE_GATES.videoMeetings.key),
    },
  });
  return booked;
}

async function scheduleConsultTimers(tx: TenantTx, ctx: IntakeContext, consult: ConsultationRow, now: Date): Promise<void> {
  for (const r of reminderTimes(consult.startsAt, ctx.settings.booking.reminderOffsetsHours, now)) {
    await scheduleTask(tx, {
      tenantId: ctx.tenantId,
      taskType: INTAKE_TASK_TYPES.consultReminder,
      dueAt: r.at,
      intakeSessionId: consult.intakeSessionId,
      matterId: consult.matterId,
      payload: { consultationId: consult.id, offsetHours: r.offsetHours },
    });
  }
  await scheduleTask(tx, {
    tenantId: ctx.tenantId,
    taskType: INTAKE_TASK_TYPES.consultNoShowPrompt,
    dueAt: addMinutes(consult.startsAt, ctx.settings.booking.noShowGraceMinutes),
    intakeSessionId: consult.intakeSessionId,
    matterId: consult.matterId,
    payload: { consultationId: consult.id },
  });
}

async function cancelConsultTimers(tx: TenantTx, tenantId: string, consultId: string, at: Date): Promise<void> {
  for (const taskType of [INTAKE_TASK_TYPES.consultReminder, INTAKE_TASK_TYPES.consultNoShowPrompt]) {
    await cancelScheduledTasks(tx, { tenantId, taskType, payloadKey: "consultationId", payloadValue: consultId, at });
  }
}

async function closeConsultTasks(tx: TenantTx, tenantId: string, consultId: string, by: Actor, reason: string, complete: boolean, at: Date): Promise<void> {
  const open = await tx
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.tenantId, tenantId), inArray(tasks.kind, [CONSULT_TASK_KIND, ATTENDANCE_TASK_KIND]), eq(tasks.sourceRef, `intake_consultation:${consultId}`), eq(tasks.status, "open")));
  for (const t of open) {
    if (complete) await completeTask(tx, { tenantId, taskId: t.id, by, reason, engine: INTAKE_ENGINE, at });
    else await cancelTask(tx, { tenantId, taskId: t.id, by, reason, engine: INTAKE_ENGINE });
  }
}

async function cancelCalendarEvent(tx: TenantTx, tenantId: string, eventId: string | null, reason: string, at: Date): Promise<void> {
  if (!eventId) return;
  await tx
    .update(calendarEvents)
    .set({ status: "cancelled", cancelledAt: at, cancelReason: reason, updatedAt: at })
    .where(and(eq(calendarEvents.tenantId, tenantId), eq(calendarEvents.id, eventId)));
}

/**
 * Cancel a consultation (client or firm). Refund rules for paid consults
 * belong to the Billing & trust engine; nothing here touches money.
 */
export async function cancelConsultation(
  tx: TenantTx,
  input: { tenantId: string; consultationId: string; byUserId?: string | null; clientPartyId?: string | null; reason?: string | null; now?: Date }
): Promise<ConsultationRow> {
  const now = input.now ?? new Date();
  const consult = await getConsultation(tx, input.tenantId, input.consultationId);
  let by: Actor;
  if (input.byUserId) {
    await requireStaff(tx, input.tenantId, input.byUserId, STAFF_ROLES, "cancel a consultation");
    by = userActor(input.byUserId);
  } else if (input.clientPartyId && input.clientPartyId === consult.partyId) {
    by = { type: "client", partyId: input.clientPartyId };
  } else {
    throw new IntakeRuleError("Only the person who booked or a staff member can cancel this consultation.");
  }
  const reason = input.reason?.trim() || (input.byUserId ? "Cancelled by the firm" : "Cancelled by the client");
  const cancelled = await setStatus(tx, consult, "cancelled", { cancelReason: reason });
  await cancelConsultTimers(tx, input.tenantId, consult.id, now);
  await cancelCalendarEvent(tx, input.tenantId, consult.calendarEventId, reason, now);
  await closeConsultTasks(tx, input.tenantId, consult.id, by, `Consultation cancelled: ${reason}`, false, now);
  if (consult.matterId) {
    await systemMoveMatter(tx, { tenantId: input.tenantId, matterId: consult.matterId, systemStage: "prospective", via: "system", actor: by, reason: "Consultation cancelled" });
  }
  if (input.byUserId && consult.partyId) {
    // The firm cancelled: tell the person (no reason details).
    await notifyParty(
      tx,
      { tenantId: input.tenantId, partyId: consult.partyId, templateKey: BOOKING_COPY.changed.key, channels: await clientChannels(tx, input.tenantId, consult.partyId), matterId: consult.matterId, dedupeBase: `intake.consult_changed:${consult.id}` },
      { now }
    );
  }
  await recordIntakeEvent(tx, {
    tenantId: input.tenantId,
    intakeSessionId: consult.intakeSessionId,
    matterId: consult.matterId,
    eventType: "consult_cancelled",
    actor: by,
    reason,
    entityType: "consultation",
    entityId: consult.id,
    payload: { paymentStatus: consult.paymentStatus },
  });
  return cancelled;
}

/** Reschedule: a fresh hold + confirm for the new time, the old consult marked rescheduled. */
export async function rescheduleConsultation(
  tx: TenantTx,
  input: { tenantId: string; consultationId: string; startsAt: Date; format?: BookingFormat; lawyerUserId?: string; byUserId?: string | null; clientPartyId?: string | null; reason?: string | null; now?: Date }
): Promise<ConsultationRow> {
  const now = input.now ?? new Date();
  const consult = await getConsultation(tx, input.tenantId, input.consultationId);
  if (!input.byUserId && (!input.clientPartyId || input.clientPartyId !== consult.partyId)) {
    throw new IntakeRuleError("Only the person who booked or a staff member can reschedule this consultation.");
  }
  if (!canTransition(consult.status, "rescheduled")) throw new IntakeRuleError(`A '${consult.status}' consultation cannot be rescheduled.`);
  const held = await holdSlot(tx, {
    tenantId: input.tenantId,
    intakeSessionId: consult.intakeSessionId,
    lawyerUserId: input.lawyerUserId ?? consult.lawyerUserId,
    startsAt: input.startsAt,
    format: input.format ?? (consult.format as BookingFormat),
    bookedByUserId: input.byUserId ?? null,
    previousConsultationId: consult.id,
    now,
  });
  const reason = input.reason?.trim() || "Rescheduled";
  await setStatus(tx, consult, "rescheduled", { cancelReason: reason });
  await cancelConsultTimers(tx, input.tenantId, consult.id, now);
  await cancelCalendarEvent(tx, input.tenantId, consult.calendarEventId, reason, now);
  await closeConsultTasks(tx, input.tenantId, consult.id, input.byUserId ? userActor(input.byUserId) : { type: "client", partyId: input.clientPartyId! }, `Consultation rescheduled: ${reason}`, false, now);
  const booked = await confirmBooking(tx, { tenantId: input.tenantId, consultationId: held.id, byUserId: input.byUserId ?? null, now });
  await recordIntakeEvent(tx, {
    tenantId: input.tenantId,
    intakeSessionId: consult.intakeSessionId,
    matterId: consult.matterId,
    eventType: "consult_rescheduled",
    actor: input.byUserId ? userActor(input.byUserId) : { type: "client", partyId: input.clientPartyId! },
    reason,
    entityType: "consultation",
    entityId: consult.id,
    payload: { newConsultationId: booked.id, startsAt: booked.startsAt.toISOString() },
  });
  return booked;
}

/**
 * The lawyer (or staff) marks a no-show (c67 §4 No-show): one re-book offer,
 * or — after a second no-show / when the firm offers none — an internal flag
 * to intake staff.
 */
export async function markNoShow(tx: TenantTx, input: { tenantId: string; consultationId: string; userId: string; now?: Date }): Promise<{ action: "offer_rebook" | "flag_staff" }> {
  const now = input.now ?? new Date();
  await requireStaff(tx, input.tenantId, input.userId, STAFF_ROLES, "mark a no-show");
  const ctx = await loadIntakeContext(tx, input.tenantId);
  const consult = await getConsultation(tx, input.tenantId, input.consultationId);
  if (now.getTime() < addMinutes(consult.startsAt, ctx.settings.booking.noShowGraceMinutes).getTime()) {
    throw new IntakeRuleError("A no-show can only be recorded after the start time plus the grace period.");
  }
  await setStatus(tx, consult, "no_show");
  await cancelConsultTimers(tx, input.tenantId, consult.id, now);
  await closeConsultTasks(tx, input.tenantId, consult.id, userActor(input.userId), "No-show recorded", true, now);
  let previousWasNoShow = false;
  if (consult.previousConsultationId) {
    const [prev] = await tx.select({ status: intakeConsultations.status }).from(intakeConsultations).where(and(eq(intakeConsultations.tenantId, input.tenantId), eq(intakeConsultations.id, consult.previousConsultationId))).limit(1);
    previousWasNoShow = prev?.status === "no_show";
  }
  const bundle = await getSessionBundle(tx, input.tenantId, consult.intakeSessionId);
  const action = safetySuppressed(bundle.state) ? "flag_staff" : noShowAction({ rebookOffers: ctx.settings.booking.rebookOffers, previousWasNoShow });
  if (action === "offer_rebook" && consult.partyId) {
    await notifyParty(
      tx,
      { tenantId: input.tenantId, partyId: consult.partyId, templateKey: BOOKING_COPY.rebookOffer.key, channels: await clientChannels(tx, input.tenantId, consult.partyId), matterId: consult.matterId, dedupeBase: `intake.consult_rebook:${consult.id}` },
      { now }
    );
    await tx.update(intakeConsultations).set({ rebookOfferedAt: now }).where(eq(intakeConsultations.id, consult.id));
    await scheduleTask(tx, {
      tenantId: input.tenantId,
      taskType: INTAKE_TASK_TYPES.consultRebookCheck,
      dueAt: addBusinessDays(now, ctx.settings.booking.rebookWindowBusinessDays, ctx.calendar),
      intakeSessionId: consult.intakeSessionId,
      matterId: consult.matterId,
      payload: { consultationId: consult.id },
    });
  } else {
    await flagNoShow(tx, ctx, consult, "The person missed their consultation again (or no re-book is offered). Internal only.", now);
  }
  await recordIntakeEvent(tx, {
    tenantId: input.tenantId,
    intakeSessionId: consult.intakeSessionId,
    matterId: consult.matterId,
    eventType: "consult_no_show",
    actor: userActor(input.userId),
    entityType: "consultation",
    entityId: consult.id,
    payload: { action, previousWasNoShow },
  });
  return { action };
}

async function flagNoShow(tx: TenantTx, ctx: IntakeContext, consult: ConsultationRow, summary: string, now: Date): Promise<void> {
  const { intakeManagers } = await resolveEscalationContacts(tx, ctx.tenantId, ctx.settings);
  if (intakeManagers.length === 0) return;
  await raiseFlag(
    tx,
    {
      tenantId: ctx.tenantId,
      type: "intake.consult_no_show",
      severity: "warning",
      audience: "internal",
      title: "Prospective client missed their consultation",
      summary,
      matterId: consult.matterId,
      recipients: { userIds: intakeManagers },
      dedupeKey: `intake.consult_no_show:${consult.intakeSessionId}`,
      sourceCard: "c67",
      engine: INTAKE_ENGINE,
    },
    { now }
  );
}

/** The lawyer records the consult outcome (c67 §4 After the consult). */
export async function recordConsultOutcome(
  tx: TenantTx,
  input: { tenantId: string; consultationId: string; userId: string; outcome: ConsultOutcome; note?: string | null; now?: Date }
): Promise<ConsultationRow> {
  const now = input.now ?? new Date();
  if (!(CONSULT_OUTCOMES as readonly string[]).includes(input.outcome)) throw new IntakeValidationError(`Unknown outcome '${input.outcome}'.`);
  await requireStaff(tx, input.tenantId, input.userId, LAWYER_ROLES, "record a consultation outcome");
  const consult = await getConsultation(tx, input.tenantId, input.consultationId);
  const done = await setStatus(tx, consult, "completed", { outcome: input.outcome, outcomeNote: input.note ?? null });
  await cancelConsultTimers(tx, input.tenantId, consult.id, now);
  await closeConsultTasks(tx, input.tenantId, consult.id, userActor(input.userId), `Outcome recorded: ${input.outcome}`, true, now);
  if (consult.matterId) {
    await systemMoveMatter(tx, { tenantId: input.tenantId, matterId: consult.matterId, systemStage: stageForOutcome(input.outcome), via: "system", actor: userActor(input.userId), reason: `Consult outcome: ${input.outcome}` });
  }
  if (input.outcome === "declined_by_firm" && consult.partyId) {
    // Lawyer-approved decline: the same neutral non-engagement notice as c62/c73.
    await notifyParty(
      tx,
      { tenantId: input.tenantId, partyId: consult.partyId, templateKey: ACCEPTANCE_GATES.declineNotice.key, channels: ["in_app", "email"], matterId: consult.matterId, dedupeBase: `intake.decline:${consult.intakeSessionId}` },
      { now }
    );
  }
  await recordIntakeEvent(tx, {
    tenantId: input.tenantId,
    intakeSessionId: consult.intakeSessionId,
    matterId: consult.matterId,
    eventType: "consult_outcome_recorded",
    actor: userActor(input.userId),
    entityType: "consultation",
    entityId: consult.id,
    payload: { outcome: input.outcome },
  });
  return done;
}

/** Staff put a booking on hold (e.g. a new party needs a conflict re-check before the consult). */
export async function putConsultationOnHold(tx: TenantTx, input: { tenantId: string; consultationId: string; userId: string; reason: string; now?: Date }): Promise<ConsultationRow> {
  const reason = requireReason(input.reason, "Putting a consultation on hold");
  await requireStaff(tx, input.tenantId, input.userId, STAFF_ROLES, "put a consultation on hold");
  const now = input.now ?? new Date();
  const consult = await getConsultation(tx, input.tenantId, input.consultationId);
  const held = await setStatus(tx, consult, "on_hold", { cancelReason: reason });
  await cancelConsultTimers(tx, input.tenantId, consult.id, now);
  if (consult.partyId) {
    // The client is told the firm needs to reschedule, never why (c67 failure paths).
    await notifyParty(
      tx,
      { tenantId: input.tenantId, partyId: consult.partyId, templateKey: BOOKING_COPY.changed.key, channels: await clientChannels(tx, input.tenantId, consult.partyId), matterId: consult.matterId, dedupeBase: `intake.consult_on_hold:${consult.id}` },
      { now }
    );
  }
  await notifyStaffLawyer(tx, input.tenantId, consult, now);
  await recordIntakeEvent(tx, { tenantId: input.tenantId, intakeSessionId: consult.intakeSessionId, matterId: consult.matterId, eventType: "consult_on_hold", actor: userActor(input.userId), reason, entityType: "consultation", entityId: consult.id });
  return held;
}

async function notifyStaffLawyer(tx: TenantTx, tenantId: string, consult: ConsultationRow, now: Date): Promise<void> {
  await raiseFlag(
    tx,
    {
      tenantId,
      type: "intake.consult_on_hold",
      severity: "warning",
      audience: "internal",
      title: "A booked consultation was put on hold",
      summary: "Please review the inquiry before the consultation goes ahead.",
      matterId: consult.matterId,
      recipients: { userIds: [consult.lawyerUserId] },
      dedupeKey: `intake.consult_on_hold:${consult.id}`,
      sourceCard: "c67",
      engine: INTAKE_ENGINE,
    },
    { now }
  );
}

// ---------------------------------------------------------------------------
// Worker handlers (idempotent: they re-read state and do nothing when moot)
// ---------------------------------------------------------------------------

export async function handleConsultReminder(tx: TenantTx, tenantId: string, task: ScheduledTaskRow, now: Date): Promise<void> {
  const id = payloadString(task.payload, "consultationId");
  if (!id) return;
  const [consult] = await tx.select().from(intakeConsultations).where(and(eq(intakeConsultations.tenantId, tenantId), eq(intakeConsultations.id, id))).limit(1);
  if (!consult || consult.status !== "booked" || !consult.partyId) return;
  if (consult.startsAt.getTime() <= now.getTime()) return;
  const bundle = await getSessionBundle(tx, tenantId, consult.intakeSessionId);
  if (safetySuppressed(bundle.state)) return;
  await notifyParty(
    tx,
    {
      tenantId,
      partyId: consult.partyId,
      templateKey: BOOKING_COPY.reminder.key,
      channels: await clientChannels(tx, tenantId, consult.partyId),
      matterId: consult.matterId,
      dedupeBase: `intake.consult_reminder:${consult.id}:${task.id}`,
    },
    { now }
  );
  await recordIntakeEvent(tx, { tenantId, intakeSessionId: consult.intakeSessionId, matterId: consult.matterId, eventType: "consult_reminder_queued", entityType: "consultation", entityId: consult.id, payload: { offsetHours: task.payload && (task.payload as Record<string, unknown>).offsetHours } });
}

export async function handleConsultNoShowPrompt(tx: TenantTx, tenantId: string, task: ScheduledTaskRow, now: Date): Promise<void> {
  const id = payloadString(task.payload, "consultationId");
  if (!id) return;
  const [consult] = await tx.select().from(intakeConsultations).where(and(eq(intakeConsultations.tenantId, tenantId), eq(intakeConsultations.id, id))).limit(1);
  if (!consult || consult.status !== "booked") return;
  const ctx = await loadIntakeContext(tx, tenantId);
  await createTask(
    tx,
    {
      tenantId,
      kind: ATTENDANCE_TASK_KIND,
      title: "Did the consultation happen? Record the outcome or mark a no-show",
      owner: { type: "user", userId: consult.lawyerUserId },
      due: { hours: 4, clock: "business" },
      matterId: consult.matterId,
      intakeSessionId: consult.intakeSessionId,
      sourceCard: "c67",
      sourceRef: `intake_consultation:${consult.id}`,
      engine: INTAKE_ENGINE,
    },
    { now, calendar: ctx.calendar }
  );
}

export async function handleConsultRebookCheck(tx: TenantTx, tenantId: string, task: ScheduledTaskRow, now: Date): Promise<void> {
  const id = payloadString(task.payload, "consultationId");
  if (!id) return;
  const [consult] = await tx.select().from(intakeConsultations).where(and(eq(intakeConsultations.tenantId, tenantId), eq(intakeConsultations.id, id))).limit(1);
  if (!consult) return;
  const [rebooked] = await tx
    .select({ id: intakeConsultations.id })
    .from(intakeConsultations)
    .where(and(eq(intakeConsultations.tenantId, tenantId), eq(intakeConsultations.intakeSessionId, consult.intakeSessionId), gt(intakeConsultations.createdAt, consult.updatedAt), inArray(intakeConsultations.status, ["booked", "completed", "held"])))
    .limit(1);
  if (rebooked) return;
  const ctx = await loadIntakeContext(tx, tenantId);
  await flagNoShow(tx, ctx, consult, "The person did not re-book within the re-book window after a missed consultation. Internal only.", now);
}

/** Tick hook: release slot holds that were never confirmed. */
export async function expireSlotHolds(tx: TenantTx, tenantId: string, now: Date): Promise<{ expired: number }> {
  const rows = await tx
    .update(intakeConsultations)
    .set({ status: "expired", updatedAt: now })
    .where(and(eq(intakeConsultations.tenantId, tenantId), eq(intakeConsultations.status, "held"), lte(intakeConsultations.holdExpiresAt, now)))
    .returning({ id: intakeConsultations.id });
  return { expired: rows.length };
}

/** Staff view of consultations (internal). */
export async function listConsultations(tx: TenantTx, tenantId: string, opts: { intakeSessionId?: string; lawyerUserId?: string; from?: Date } = {}) {
  const conds = [eq(intakeConsultations.tenantId, tenantId)];
  if (opts.intakeSessionId) conds.push(eq(intakeConsultations.intakeSessionId, opts.intakeSessionId));
  if (opts.lawyerUserId) conds.push(eq(intakeConsultations.lawyerUserId, opts.lawyerUserId));
  if (opts.from) conds.push(gt(intakeConsultations.startsAt, opts.from));
  return tx.select().from(intakeConsultations).where(and(...conds)).orderBy(asc(intakeConsultations.startsAt)).limit(200);
}
