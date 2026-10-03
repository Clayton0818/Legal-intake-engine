// c54 — client updates (database side).
//
//   createUpdate()        a lawyer/staff update sends at once; an AI or system
//                         draft waits for a lawyer (approval task, c45)
//   approveUpdate()       lawyer only; stale drafts refused; logged
//   discardUpdate()       with a reason
//   correctUpdate()       sent updates are never edited: a NEW update that
//                         points at the original (rule 5)
//   draftFromEvent()      system draft from a CONFIRMED calendar entry
//   setCadence()          per-matter rhythm → `client_update_due` firm task
//   listFirmUpdates() / listClientUpdates() / markUpdateRead()
//
// Delivery reuses c51: in-app always, minimal email notice (approved wording,
// ids only) to the client's safe address under the daily cap and quiet hours.

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { users } from "@/db/schema";
import { calendarEvents, notificationOutbox } from "@/db/tables/foundation";
import { clientUpdateCadences, clientUpdateReads, clientUpdates } from "@/db/tables/calendar-alerts";
import type { TenantTx } from "@/tenancy/withTenant";
import { NOTIFY_COPY_GATES } from "@/compliance/gates";
import { addBusinessHours } from "@/core/businessHours";
import { audit, type Actor } from "@/core/audit";
import { toBusinessCalendar } from "@/core/firmSettings";
import { cancelTask, completeTask, createTask, getTask } from "@/core/tasks";
import { AlertRuleError, getMatter, notifyClient, responsibleLawyer, type EngineContext, type Staff } from "../common";
import { TASK_KINDS } from "../kinds";
import { ENGINE } from "../settings";
import { assertClientOfMatter } from "../replyClock/service";
import { draftFromConfirmedEvent, reviewUpdateText, summariseDelivery, toClientHistory, type ClientUpdateView, type UpdateAuthorType } from "./model";

export type UpdateRow = typeof clientUpdates.$inferSelect;

/** One business day for cadence purposes (the default 09:00–17:00 day). */
export const BUSINESS_DAY_HOURS = 8;

const LANG = /^[a-z]{2}(-[A-Z]{2})?$/;

function actorOf(staff: Staff): Actor {
  return { type: "user", userId: staff.userId };
}

export async function createUpdate(
  tx: TenantTx,
  ctx: EngineContext,
  input: {
    tenantId: string;
    matterId: string;
    recipientPartyIds: string[];
    body: string;
    language?: string;
    author: { type: "user"; staff: Staff } | { type: "ai" | "system_draft"; sourceEventRef?: string | null; sourceVersion?: string | null };
    correctsUpdateId?: string | null;
    now: Date;
  }
): Promise<UpdateRow> {
  const body = input.body?.trim() ?? "";
  if (!body) throw new AlertRuleError("The update is empty.");
  const language = input.language ?? "en";
  if (!LANG.test(language)) throw new AlertRuleError("language must look like 'en' or 'es'.");
  const recipients = [...new Set(input.recipientPartyIds)];
  if (recipients.length === 0) throw new AlertRuleError("Choose at least one client to send the update to.");
  const matter = await getMatter(tx, input.tenantId, input.matterId);
  for (const p of recipients) await assertClientOfMatter(tx, input.tenantId, matter, p);
  if (input.author.type === "user" && input.author.staff.role === "read_only") throw new AlertRuleError("Your role cannot send client updates.", 403);

  let corrects: UpdateRow | null = null;
  if (input.correctsUpdateId) {
    corrects = await getUpdate(tx, input.tenantId, input.correctsUpdateId);
    if (corrects.matterId !== matter.id || corrects.status !== "sent") throw new AlertRuleError("Only a sent update on this matter can be corrected.", 409);
  }

  const findings = reviewUpdateText(body, input.author.type as UpdateAuthorType);
  if (input.author.type === "user" && findings.length > 0) {
    throw new AlertRuleError(`Updates never include internal notes, tasks, flags or health data. Remove: ${findings.join(", ")}.`, 422);
  }

  const human = input.author.type === "user";
  const [row] = await tx
    .insert(clientUpdates)
    .values({
      tenantId: input.tenantId,
      matterId: matter.id,
      recipientPartyIds: recipients,
      body,
      language,
      authorType: input.author.type,
      authorUserId: input.author.type === "user" ? input.author.staff.userId : null,
      status: human ? "sent" : "pending_approval",
      sentAt: human ? input.now : null,
      correctsUpdateId: corrects?.id ?? null,
      sourceEventRef: input.author.type !== "user" ? input.author.sourceEventRef ?? null : null,
      sourceVersion: input.author.type !== "user" ? input.author.sourceVersion ?? null : null,
      checkFindings: human ? [] : findings,
      createdAt: input.now,
    })
    .returning();
  const update = row!;
  await audit(tx, {
    tenantId: input.tenantId,
    engine: ENGINE,
    action: human ? "client_update.created" : "client_update.drafted",
    entityType: "client_update",
    entityId: update.id,
    matterId: matter.id,
    actor: input.author.type === "user" ? actorOf(input.author.staff) : input.author.type === "ai" ? { type: "ai" } : { type: "system" },
    payload: { recipients: recipients.length, correctsUpdateId: update.correctsUpdateId, findings },
  });

  if (human) {
    await deliver(tx, ctx, update, input.now);
    return update;
  }
  // AI/system drafts: an approval task for the responsible lawyer (it goes overdue like any task, c54 §4 edge case).
  const lawyer = await responsibleLawyer(tx, input.tenantId, matter);
  const task = await createTask(
    tx,
    {
      tenantId: input.tenantId,
      kind: TASK_KINDS.updateApproval,
      title: "Review a drafted client update",
      description: findings.length ? `The draft checker found: ${findings.join(", ")}. Edit before approving.` : "Approve, edit or discard. Nothing is sent until a lawyer approves it.",
      owner: lawyer ? { type: "user", userId: lawyer } : { type: "firm" },
      due: { hours: ctx.alerts.updateApprovalDueBusinessHours, clock: "business", from: input.now },
      matterId: matter.id,
      sourceCard: "c54",
      sourceRef: `client_update:${update.id}`,
      engine: ENGINE,
    },
    { now: input.now, calendar: toBusinessCalendar(ctx.firm) }
  );
  const [withTask] = await tx
    .update(clientUpdates)
    .set({ approvalTaskId: task.id })
    .where(and(eq(clientUpdates.tenantId, input.tenantId), eq(clientUpdates.id, update.id)))
    .returning();
  return withTask!;
}

export async function getUpdate(tx: TenantTx, tenantId: string, updateId: string): Promise<UpdateRow> {
  const [row] = await tx.select().from(clientUpdates).where(and(eq(clientUpdates.tenantId, tenantId), eq(clientUpdates.id, updateId))).limit(1);
  if (!row) throw new AlertRuleError("Update not found.", 404);
  return row;
}

/** Is the draft's source unchanged since it was drafted? (A moved hearing makes the draft stale.) */
async function isStale(tx: TenantTx, tenantId: string, u: UpdateRow): Promise<string | null> {
  if (!u.sourceEventRef?.startsWith("calendar_event:")) return null;
  const id = u.sourceEventRef.slice("calendar_event:".length);
  const [ev] = await tx
    .select({ updatedAt: calendarEvents.updatedAt, status: calendarEvents.status, cancelledAt: calendarEvents.cancelledAt })
    .from(calendarEvents)
    .where(and(eq(calendarEvents.tenantId, tenantId), eq(calendarEvents.id, id)))
    .limit(1);
  if (!ev || ev.cancelledAt || ev.status !== "confirmed") return "The calendar entry behind this draft was cancelled or is no longer confirmed.";
  if (u.sourceVersion && ev.updatedAt.toISOString() !== u.sourceVersion) return "The calendar entry changed after this draft was written. Regenerate or edit it.";
  return null;
}

/** Lawyer approval of an AI/system draft (c54 rule 3). An edit is the lawyer's own wording. */
export async function approveUpdate(
  tx: TenantTx,
  ctx: EngineContext,
  input: { tenantId: string; updateId: string; staff: Staff; editedBody?: string | null; now: Date }
): Promise<UpdateRow> {
  if (input.staff.role !== "attorney") throw new AlertRuleError("Only a lawyer can approve a drafted client update.", 403);
  const u = await getUpdate(tx, input.tenantId, input.updateId);
  if (u.status !== "pending_approval") throw new AlertRuleError(`This update is ${u.status}.`, 409);
  const edited = input.editedBody?.trim() || null;
  if (!edited) {
    const stale = await isStale(tx, input.tenantId, u);
    if (stale) throw new AlertRuleError(stale, 409);
  }
  const body = edited ?? u.body;
  const findings = reviewUpdateText(body, u.authorType as UpdateAuthorType, Boolean(edited));
  if (findings.length > 0) throw new AlertRuleError(`Edit the draft before approving; it contains: ${findings.join(", ")}.`, 422);
  const [row] = await tx
    .update(clientUpdates)
    .set({ status: "sent", body, approvedByUserId: input.staff.userId, approvedAt: input.now, sentAt: input.now, checkFindings: [] })
    .where(and(eq(clientUpdates.tenantId, input.tenantId), eq(clientUpdates.id, u.id), eq(clientUpdates.status, "pending_approval")))
    .returning();
  if (!row) throw new AlertRuleError("This update changed meanwhile; reload it.", 409);
  if (u.approvalTaskId) {
    const t = await getTask(tx, input.tenantId, u.approvalTaskId);
    if (t?.status === "open") await completeTask(tx, { tenantId: input.tenantId, taskId: t.id, by: actorOf(input.staff), reason: "Draft approved and sent", engine: ENGINE, at: input.now });
  }
  await audit(tx, { tenantId: input.tenantId, engine: ENGINE, action: "client_update.approved", entityType: "client_update", entityId: u.id, matterId: u.matterId, actor: actorOf(input.staff), payload: { edited: Boolean(edited) } });
  await deliver(tx, ctx, row, input.now);
  return row;
}

export async function discardUpdate(tx: TenantTx, input: { tenantId: string; updateId: string; staff: Staff; reason: string; now: Date }): Promise<UpdateRow> {
  const reason = input.reason?.trim();
  if (!reason) throw new AlertRuleError("A reason is required to discard a draft.");
  const u = await getUpdate(tx, input.tenantId, input.updateId);
  if (u.status !== "pending_approval" && u.status !== "draft") throw new AlertRuleError("Only an unsent draft can be discarded; send a correction instead.", 409);
  const [row] = await tx
    .update(clientUpdates)
    .set({ status: "discarded", discardedReason: reason })
    .where(and(eq(clientUpdates.tenantId, input.tenantId), eq(clientUpdates.id, u.id)))
    .returning();
  if (u.approvalTaskId) {
    const t = await getTask(tx, input.tenantId, u.approvalTaskId);
    if (t?.status === "open") await cancelTask(tx, { tenantId: input.tenantId, taskId: t.id, by: actorOf(input.staff), reason: `Draft discarded: ${reason}`, engine: ENGINE });
  }
  await audit(tx, { tenantId: input.tenantId, engine: ENGINE, action: "client_update.discarded", entityType: "client_update", entityId: u.id, matterId: u.matterId, actor: actorOf(input.staff), reason });
  return row!;
}

/** A correction is a new update pointing at the original; the original stays visible (rule 5). */
export async function correctUpdate(
  tx: TenantTx,
  ctx: EngineContext,
  input: { tenantId: string; updateId: string; staff: Staff; body: string; now: Date }
): Promise<UpdateRow> {
  const original = await getUpdate(tx, input.tenantId, input.updateId);
  return createUpdate(tx, ctx, {
    tenantId: input.tenantId,
    matterId: original.matterId,
    recipientPartyIds: original.recipientPartyIds,
    body: input.body,
    language: original.language,
    author: { type: "user", staff: input.staff },
    correctsUpdateId: original.id,
    now: input.now,
  });
}

async function deliver(tx: TenantTx, ctx: EngineContext, u: UpdateRow, now: Date): Promise<void> {
  for (const partyId of u.recipientPartyIds) {
    await notifyClient(tx, ctx, {
      tenantId: u.tenantId,
      partyId,
      matterId: u.matterId,
      templateKey: NOTIFY_COPY_GATES.genericUpdate.key,
      payload: { updateId: u.id },
      dedupeKey: `calendar-alerts.update:${u.id}:${partyId}`,
      now,
    });
  }
  await audit(tx, { tenantId: u.tenantId, engine: ENGINE, action: "client_update.sent", entityType: "client_update", entityId: u.id, matterId: u.matterId, payload: { recipients: u.recipientPartyIds.length, correctsUpdateId: u.correctsUpdateId } });
  await refreshCadence(tx, ctx, u.tenantId, u.matterId, now);
}

/** System draft from a confirmed calendar entry, addressed to the matter's primary client. */
export async function draftFromEvent(tx: TenantTx, ctx: EngineContext, input: { tenantId: string; calendarEventId: string; now: Date }): Promise<UpdateRow> {
  const [ev] = await tx.select().from(calendarEvents).where(and(eq(calendarEvents.tenantId, input.tenantId), eq(calendarEvents.id, input.calendarEventId))).limit(1);
  if (!ev || !ev.matterId) throw new AlertRuleError("Calendar entry not found on a matter.", 404);
  const draft = draftFromConfirmedEvent(ev, ctx.firm.timeZone);
  if ("refused" in draft) throw new AlertRuleError(draft.refused, 422);
  const matter = await getMatter(tx, input.tenantId, ev.matterId);
  return createUpdate(tx, ctx, {
    tenantId: input.tenantId,
    matterId: matter.id,
    recipientPartyIds: [matter.primaryPartyId],
    body: draft.body,
    author: { type: "system_draft", sourceEventRef: `calendar_event:${ev.id}`, sourceVersion: ev.updatedAt.toISOString() },
    now: input.now,
  });
}

// ---------------------------------------------------------------------------
// Cadence (c54 §4.8; firm default off)
// ---------------------------------------------------------------------------

export async function setCadence(
  tx: TenantTx,
  ctx: EngineContext,
  input: { tenantId: string; matterId: string; everyBusinessDays: number | null; staff: Staff; now: Date }
): Promise<{ everyBusinessDays: number | null; taskId: string | null }> {
  if (input.staff.role !== "attorney" && input.staff.role !== "firm_admin") throw new AlertRuleError("Only a lawyer or firm admin can set the update cadence.", 403);
  const matter = await getMatter(tx, input.tenantId, input.matterId);
  const [current] = await tx.select().from(clientUpdateCadences).where(and(eq(clientUpdateCadences.tenantId, input.tenantId), eq(clientUpdateCadences.matterId, matter.id))).limit(1);
  const by = actorOf(input.staff);
  if (current?.currentTaskId) {
    const t = await getTask(tx, input.tenantId, current.currentTaskId);
    if (t?.status === "open") await cancelTask(tx, { tenantId: input.tenantId, taskId: t.id, by, reason: "Update cadence changed", engine: ENGINE });
  }
  if (input.everyBusinessDays === null) {
    if (current) await tx.delete(clientUpdateCadences).where(and(eq(clientUpdateCadences.tenantId, input.tenantId), eq(clientUpdateCadences.id, current.id)));
    await audit(tx, { tenantId: input.tenantId, engine: ENGINE, action: "client_update.cadence_off", entityType: "matter", entityId: matter.id, matterId: matter.id, actor: by });
    return { everyBusinessDays: null, taskId: null };
  }
  if (!Number.isInteger(input.everyBusinessDays) || input.everyBusinessDays < 1 || input.everyBusinessDays > 260) {
    throw new AlertRuleError("everyBusinessDays must be a whole number from 1 to 260.");
  }
  await tx
    .insert(clientUpdateCadences)
    .values({ tenantId: input.tenantId, matterId: matter.id, everyBusinessDays: input.everyBusinessDays, setByUserId: input.staff.userId, updatedAt: input.now })
    .onConflictDoUpdate({ target: [clientUpdateCadences.tenantId, clientUpdateCadences.matterId], set: { everyBusinessDays: input.everyBusinessDays, setByUserId: input.staff.userId, updatedAt: input.now, currentTaskId: null } });
  await audit(tx, { tenantId: input.tenantId, engine: ENGINE, action: "client_update.cadence_set", entityType: "matter", entityId: matter.id, matterId: matter.id, actor: by, payload: { everyBusinessDays: input.everyBusinessDays } });
  const taskId = await refreshCadence(tx, ctx, input.tenantId, matter.id, input.now);
  return { everyBusinessDays: input.everyBusinessDays, taskId };
}

/** After a sent update (or a cadence change): close the current cadence task and open the next one. */
async function refreshCadence(tx: TenantTx, ctx: EngineContext, tenantId: string, matterId: string, now: Date): Promise<string | null> {
  const [cad] = await tx.select().from(clientUpdateCadences).where(and(eq(clientUpdateCadences.tenantId, tenantId), eq(clientUpdateCadences.matterId, matterId))).limit(1);
  if (!cad) return null;
  if (cad.currentTaskId) {
    const t = await getTask(tx, tenantId, cad.currentTaskId);
    if (t?.status === "open") await completeTask(tx, { tenantId, taskId: t.id, by: { type: "system" }, reason: "Client update sent", engine: ENGINE, at: now });
  }
  const [last] = await tx
    .select({ sentAt: clientUpdates.sentAt })
    .from(clientUpdates)
    .where(and(eq(clientUpdates.tenantId, tenantId), eq(clientUpdates.matterId, matterId), eq(clientUpdates.status, "sent")))
    .orderBy(desc(clientUpdates.sentAt))
    .limit(1);
  const from = last?.sentAt ?? now;
  const cal = toBusinessCalendar(ctx.firm);
  const dueAt = addBusinessHours(from, cad.everyBusinessDays * BUSINESS_DAY_HOURS, cal);
  const matter = await getMatter(tx, tenantId, matterId);
  const lawyer = await responsibleLawyer(tx, tenantId, matter);
  const task = await createTask(
    tx,
    {
      tenantId,
      kind: TASK_KINDS.clientUpdateDue,
      title: "Send the client their regular update",
      description: `This matter has a client update rhythm of every ${cad.everyBusinessDays} business days.`,
      owner: lawyer ? { type: "user", userId: lawyer } : { type: "firm" },
      due: { at: dueAt, clock: "business" },
      matterId,
      sourceCard: "c54",
      sourceRef: `client_update_cadence:${cad.id}`,
      engine: ENGINE,
    },
    { now, calendar: cal }
  );
  await tx.update(clientUpdateCadences).set({ currentTaskId: task.id, updatedAt: now }).where(and(eq(clientUpdateCadences.tenantId, tenantId), eq(clientUpdateCadences.id, cad.id)));
  return task.id;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Firm-side history with delivery and first-read status per recipient (c54 §4.5). */
export async function listFirmUpdates(tx: TenantTx, tenantId: string, matterId: string) {
  const rows = await tx.select().from(clientUpdates).where(and(eq(clientUpdates.tenantId, tenantId), eq(clientUpdates.matterId, matterId))).orderBy(desc(clientUpdates.createdAt)).limit(500);
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const outbox = await tx
    .select({ updateId: sql<string>`${notificationOutbox.payload}->>'updateId'`, channel: notificationOutbox.channel, status: notificationOutbox.status, recipientPartyId: notificationOutbox.recipientPartyId, lastError: notificationOutbox.lastError })
    .from(notificationOutbox)
    .where(and(eq(notificationOutbox.tenantId, tenantId), eq(notificationOutbox.matterId, matterId), inArray(sql<string>`${notificationOutbox.payload}->>'updateId'`, ids)));
  const reads = await tx.select().from(clientUpdateReads).where(and(eq(clientUpdateReads.tenantId, tenantId), inArray(clientUpdateReads.updateId, ids)));
  const authorIds = [...new Set(rows.flatMap((r) => [r.authorUserId, r.approvedByUserId]).filter((x): x is string => Boolean(x)))];
  const names = authorIds.length ? new Map((await tx.select({ id: users.id, name: users.displayName }).from(users).where(and(eq(users.tenantId, tenantId), inArray(users.id, authorIds)))).map((u) => [u.id, u.name])) : new Map<string, string>();
  return rows.map((u) => ({
    ...u,
    authorName: u.authorUserId ? names.get(u.authorUserId) ?? null : u.authorType === "ai" ? "AI draft" : "System draft",
    approvedByName: u.approvedByUserId ? names.get(u.approvedByUserId) ?? null : null,
    delivery: summariseDelivery(outbox.filter((o) => o.updateId === u.id)),
    reads: reads.filter((r) => r.updateId === u.id).map((r) => ({ partyId: r.partyId, firstOpenedAt: r.firstOpenedAt })),
  }));
}

/** The client's own history (portal): sent updates addressed to them, newest first, searchable. */
export async function listClientUpdates(tx: TenantTx, tenantId: string, partyId: string, filter: { matterId?: string; search?: string | null } = {}): Promise<ClientUpdateView[]> {
  const conds = [eq(clientUpdates.tenantId, tenantId), eq(clientUpdates.status, "sent"), sql`${partyId}::uuid = any(${clientUpdates.recipientPartyIds})`];
  if (filter.matterId) conds.push(eq(clientUpdates.matterId, filter.matterId));
  const rows = await tx.select().from(clientUpdates).where(and(...conds)).limit(1000);
  return toClientHistory(rows, partyId, filter.search);
}

/** First time the client opened an update (idempotent; logged once). */
export async function markUpdateRead(tx: TenantTx, input: { tenantId: string; updateId: string; partyId: string; now: Date }): Promise<void> {
  const u = await getUpdate(tx, input.tenantId, input.updateId);
  if (u.status !== "sent" || !u.recipientPartyIds.includes(input.partyId)) throw new AlertRuleError("Update not found.", 404);
  const [row] = await tx.insert(clientUpdateReads).values({ tenantId: input.tenantId, updateId: u.id, partyId: input.partyId, firstOpenedAt: input.now }).onConflictDoNothing().returning();
  if (row) await audit(tx, { tenantId: input.tenantId, engine: ENGINE, action: "client_update.opened", entityType: "client_update", entityId: u.id, matterId: u.matterId, actor: { type: "client", partyId: input.partyId } });
}

/** Pending drafts awaiting lawyer approval (the approval queue). */
export async function listPendingDrafts(tx: TenantTx, tenantId: string): Promise<UpdateRow[]> {
  return tx.select().from(clientUpdates).where(and(eq(clientUpdates.tenantId, tenantId), eq(clientUpdates.status, "pending_approval"))).orderBy(desc(clientUpdates.createdAt)).limit(200);
}
