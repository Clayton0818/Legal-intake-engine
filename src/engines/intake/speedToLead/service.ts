// c69 — speed-to-lead (database operations).
//
// The "First human response" is a shared firm task (kind
// 'intake.first_response_due', business-hours clock). Its due-soon, overdue
// and escalation flags are raised here by scheduled checks; they are
// INTERNAL ONLY — the client is never told the firm is late.

import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import { intakeEvents } from "@/db/schema";
import { tasks } from "@/db/tables/foundation";
import { intakeSessionState } from "@/db/tables/intake";
import type { TenantTx } from "@/tenancy/withTenant";
import { addBusinessMinutes } from "@/core/businessHours";
import { cancelTask, completeTask, createTask, getTask } from "@/core/tasks";
import { escalateFlag, raiseFlag } from "@/core/flags";
import type { ScheduledTaskRow } from "@/worker/hooks";
import { HUMAN_CONTACT_ROLES, requireStaff, resolveEscalationContacts, STAFF_ROLES, userActor } from "../common/actors";
import { loadIntakeContext } from "../common/context";
import { requireReason } from "../common/errors";
import { recordIntakeEvent } from "../common/events";
import { INTAKE_TASK_TYPES, payloadString, scheduleTask } from "../common/scheduling";
import { getSessionBundle, updateState } from "../common/sessions";
import { INTAKE_ENGINE } from "../settings";
import { attemptsSatisfy, businessMinutesRemaining, computeDueSoonAt, computeResponseTarget, summarizeResponseTimes, type ResponseOutcome } from "./clock";

export const FIRST_RESPONSE_TASK_KIND = "intake.first_response_due";

/**
 * Start the clock at the first inbound message with usable contact details
 * (c69 §4.1). Idempotent. Not started for emergencies (they bypass the queue).
 */
export async function startResponseClock(tx: TenantTx, input: { tenantId: string; intakeSessionId: string; now?: Date }): Promise<{ started: boolean; targetAt: Date | null }> {
  const now = input.now ?? new Date();
  const { session, state } = await getSessionBundle(tx, input.tenantId, input.intakeSessionId);
  if (state.responseClockStartedAt || state.responseOutcome) return { started: false, targetAt: state.responseTargetAt };
  const ctx = await loadIntakeContext(tx, input.tenantId);
  const targetAt = computeResponseTarget(now, ctx.calendar, {
    inHoursMinutes: ctx.firm.newInquiryResponseMinutes,
    afterHoursMinutesAfterOpen: ctx.settings.speedToLead.afterHoursTargetMinutesAfterOpen,
  });
  const task = await createTask(
    tx,
    {
      tenantId: input.tenantId,
      kind: FIRST_RESPONSE_TASK_KIND,
      title: "First human response to a new inquiry",
      description: "Call or message the person yourself through a channel they consented to. The AI acknowledgement does not count.",
      owner: { type: "firm" },
      due: { at: targetAt, clock: "business" },
      intakeSessionId: session.id,
      matterId: session.matterId,
      sourceCard: "c69",
      sourceRef: `intake_session:${session.id}`,
      metadata: { channel: state.channel },
      engine: INTAKE_ENGINE,
    },
    { now, calendar: ctx.calendar }
  );
  await updateState(tx, input.tenantId, session.id, { responseClockStartedAt: now, responseTargetAt: targetAt, responseTaskId: task.id });
  const stl = ctx.settings.speedToLead;
  const checks: Array<{ stage: string; at: Date }> = [
    { stage: "due_soon", at: computeDueSoonAt(now, targetAt, stl.dueSoonFraction, ctx.calendar) },
    { stage: "overdue", at: targetAt },
    { stage: "escalate", at: addBusinessMinutes(targetAt, stl.graceBusinessMinutes, ctx.calendar) },
  ];
  for (const c of checks) {
    await scheduleTask(tx, {
      tenantId: input.tenantId,
      taskType: INTAKE_TASK_TYPES.speedToLeadCheck,
      dueAt: c.at,
      intakeSessionId: session.id,
      payload: { taskId: task.id, stage: c.stage },
    });
  }
  await recordIntakeEvent(tx, {
    tenantId: input.tenantId,
    intakeSessionId: session.id,
    eventType: "response_clock_started",
    ruleName: `speed_to_lead.${ctx.firm.newInquiryResponseMinutes}m`,
    firmConfigVersionId: session.firmConfigVersionId,
    payload: { targetAt: targetAt.toISOString(), taskId: task.id },
  });
  return { started: true, targetAt };
}

async function closeClock(
  tx: TenantTx,
  input: { tenantId: string; intakeSessionId: string; outcome: ResponseOutcome; by: ReturnType<typeof userActor> | { type: "system" }; reason: string; now: Date; complete: boolean }
): Promise<void> {
  const { state } = await getSessionBundle(tx, input.tenantId, input.intakeSessionId);
  if (state.responseTaskId) {
    const task = await getTask(tx, input.tenantId, state.responseTaskId);
    if (task && task.status === "open") {
      if (input.complete) await completeTask(tx, { tenantId: input.tenantId, taskId: task.id, by: input.by, reason: input.reason, engine: INTAKE_ENGINE, at: input.now });
      else await cancelTask(tx, { tenantId: input.tenantId, taskId: task.id, by: input.by, reason: input.reason, engine: INTAKE_ENGINE });
    }
  }
  await updateState(tx, input.tenantId, input.intakeSessionId, { responseOutcome: input.outcome });
}

/**
 * A real human contact (c69 §4.5): a connected call or a message written and
 * sent by a named attorney / intake staff / admin. Stops the clock.
 */
export async function recordHumanContact(
  tx: TenantTx,
  input: { tenantId: string; intakeSessionId: string; userId: string; method: "call_connected" | "message_sent" | "in_person"; now?: Date }
): Promise<void> {
  const now = input.now ?? new Date();
  await requireStaff(tx, input.tenantId, input.userId, HUMAN_CONTACT_ROLES, "record a first human contact");
  const { state } = await getSessionBundle(tx, input.tenantId, input.intakeSessionId);
  if (state.firstHumanContactAt) return;
  await updateState(tx, input.tenantId, input.intakeSessionId, { firstHumanContactAt: now, firstHumanContactByUserId: input.userId });
  if (!state.responseOutcome) {
    await closeClock(tx, { tenantId: input.tenantId, intakeSessionId: input.intakeSessionId, outcome: "contacted", by: userActor(input.userId), reason: `First human contact (${input.method})`, now, complete: true });
  }
  await recordIntakeEvent(tx, {
    tenantId: input.tenantId,
    intakeSessionId: input.intakeSessionId,
    eventType: "first_human_contact",
    actor: userActor(input.userId),
    payload: {
      method: input.method,
      targetAt: state.responseTargetAt?.toISOString() ?? null,
      metTarget: state.responseTargetAt ? now.getTime() <= state.responseTargetAt.getTime() : null,
    },
  });
}

/** An unanswered attempt (voicemail, no answer). Enough attempts complete the task as 'attempted'. */
export async function recordContactAttempt(
  tx: TenantTx,
  input: { tenantId: string; intakeSessionId: string; userId: string; channel: "phone" | "sms" | "email"; note?: string; now?: Date }
): Promise<{ completedAsAttempted: boolean }> {
  const now = input.now ?? new Date();
  await requireStaff(tx, input.tenantId, input.userId, HUMAN_CONTACT_ROLES, "log a contact attempt");
  await recordIntakeEvent(tx, {
    tenantId: input.tenantId,
    intakeSessionId: input.intakeSessionId,
    eventType: "contact_attempt",
    actor: userActor(input.userId),
    payload: { channel: input.channel, note: input.note ?? null },
    occurredAt: now,
  });
  const { state } = await getSessionBundle(tx, input.tenantId, input.intakeSessionId);
  if (state.responseOutcome) return { completedAsAttempted: false };
  const ctx = await loadIntakeContext(tx, input.tenantId);
  const rows = await tx
    .select({ at: intakeEvents.occurredAt, payload: intakeEvents.payload })
    .from(intakeEvents)
    .where(and(eq(intakeEvents.tenantId, input.tenantId), eq(intakeEvents.intakeSessionId, input.intakeSessionId), eq(intakeEvents.eventType, "contact_attempt")))
    .orderBy(asc(intakeEvents.occurredAt));
  const attempts = rows.map((r) => ({ at: r.at, channel: String((r.payload as Record<string, unknown>).channel ?? "unknown") }));
  const done = attemptsSatisfy(attempts, { needed: ctx.settings.speedToLead.attemptsNeeded, minSpacingMinutes: ctx.settings.speedToLead.attemptMinSpacingBusinessMinutes }, ctx.calendar);
  if (done) {
    await closeClock(tx, { tenantId: input.tenantId, intakeSessionId: input.intakeSessionId, outcome: "attempted", by: userActor(input.userId), reason: `${attempts.length} contact attempts logged`, now, complete: true });
  }
  return { completedAsAttempted: done };
}

/** Spam / vendor / wrong number / existing client: closed with a reason, excluded from metrics. */
export async function closeAsNotAnInquiry(tx: TenantTx, input: { tenantId: string; intakeSessionId: string; userId: string; reason: string; now?: Date }): Promise<void> {
  const reason = requireReason(input.reason, "Closing as not an inquiry");
  await requireStaff(tx, input.tenantId, input.userId, STAFF_ROLES, "close an inquiry");
  const now = input.now ?? new Date();
  await closeClock(tx, { tenantId: input.tenantId, intakeSessionId: input.intakeSessionId, outcome: "not_an_inquiry", by: userActor(input.userId), reason: `Not an inquiry: ${reason}`, now, complete: false });
  await updateState(tx, input.tenantId, input.intakeSessionId, { status: "not_an_inquiry", followUpStoppedAt: now, followUpStopReason: "not_an_inquiry" });
  await recordIntakeEvent(tx, { tenantId: input.tenantId, intakeSessionId: input.intakeSessionId, eventType: "closed_not_an_inquiry", actor: userActor(input.userId), reason });
}

/** Emergencies leave this queue and follow the real-clock path (c69 §4.8). */
export async function bypassSpeedToLeadForEmergency(tx: TenantTx, input: { tenantId: string; intakeSessionId: string; now?: Date }): Promise<void> {
  const now = input.now ?? new Date();
  const { state } = await getSessionBundle(tx, input.tenantId, input.intakeSessionId);
  if (state.responseOutcome) return;
  await closeClock(tx, { tenantId: input.tenantId, intakeSessionId: input.intakeSessionId, outcome: "bypassed_emergency", by: { type: "system" }, reason: "Emergency detected: handled on the real-clock emergency path (c66)", now, complete: false });
  await recordIntakeEvent(tx, { tenantId: input.tenantId, intakeSessionId: input.intakeSessionId, eventType: "response_clock_bypassed_emergency" });
}

/** Mark a lawyer-approved decline as the human response (c69 edge case: definite conflict). */
export async function closeClockForDecline(tx: TenantTx, input: { tenantId: string; intakeSessionId: string; userId: string | null; now?: Date }): Promise<void> {
  const { state } = await getSessionBundle(tx, input.tenantId, input.intakeSessionId);
  if (state.responseOutcome) return;
  await closeClock(tx, {
    tenantId: input.tenantId,
    intakeSessionId: input.intakeSessionId,
    outcome: "declined",
    by: input.userId ? userActor(input.userId) : { type: "system" },
    reason: input.userId ? "Lawyer-approved decline sent" : "Declined automatically under the firm's case-acceptance rules (c73)",
    now: input.now ?? new Date(),
    complete: true,
  });
}

/** Scheduled check: due-soon warning, overdue flag to the intake manager, escalation to owner/admin. */
export async function handleSpeedToLeadCheck(tx: TenantTx, tenantId: string, task: ScheduledTaskRow, now: Date): Promise<void> {
  const taskId = payloadString(task.payload, "taskId");
  const stage = payloadString(task.payload, "stage");
  if (!taskId || !stage) return;
  const t = await getTask(tx, tenantId, taskId);
  if (!t || t.status !== "open") return;
  const ctx = await loadIntakeContext(tx, tenantId);
  const { intakeManagers, owners } = await resolveEscalationContacts(tx, tenantId, ctx.settings);
  const dedupeKey = `intake.speed_to_lead:${t.id}`;
  if (stage === "due_soon") {
    if (intakeManagers.length === 0) return;
    await raiseFlag(
      tx,
      {
        tenantId,
        type: "intake.speed_to_lead_due_soon",
        severity: "info",
        audience: "internal",
        title: "New inquiry: first human response due soon",
        summary: `Due ${t.dueAt.toISOString()}.`,
        taskId: t.id,
        recipients: { userIds: intakeManagers },
        dedupeKey: `intake.speed_to_lead_due_soon:${t.id}`,
        channels: ["in_app"],
        sourceCard: "c69",
        engine: INTAKE_ENGINE,
      },
      { now }
    );
    return;
  }
  if (stage === "overdue") {
    if (intakeManagers.length === 0) return;
    await raiseFlag(
      tx,
      {
        tenantId,
        type: "intake.speed_to_lead_overdue",
        severity: "warning",
        audience: "internal",
        title: "New inquiry missed the response target",
        summary: "No staff member or lawyer has contacted this person yet. Internal only — the person is never told.",
        taskId: t.id,
        recipients: { userIds: intakeManagers },
        dedupeKey,
        sourceCard: "c69",
        engine: INTAKE_ENGINE,
      },
      { now }
    );
    return;
  }
  if (stage === "escalate") {
    const { flag } = await raiseFlag(
      tx,
      {
        tenantId,
        type: "intake.speed_to_lead_overdue",
        severity: "warning",
        audience: "internal",
        title: "New inquiry missed the response target",
        summary: "No staff member or lawyer has contacted this person yet.",
        taskId: t.id,
        recipients: { userIds: intakeManagers.length > 0 ? intakeManagers : owners },
        dedupeKey,
        sourceCard: "c69",
        engine: INTAKE_ENGINE,
      },
      { now }
    );
    await escalateFlag(tx, {
      tenantId,
      flagId: flag.id,
      addUserIds: owners,
      severity: "high",
      note: `Still no human contact ${ctx.settings.speedToLead.graceBusinessMinutes} business minutes after the target.`,
      engine: INTAKE_ENGINE,
      at: now,
    });
  }
}

/** Staff queue sorted by business time remaining (c69 §4.4). */
export async function listSpeedToLeadQueue(tx: TenantTx, tenantId: string, now = new Date()) {
  const ctx = await loadIntakeContext(tx, tenantId);
  const rows = await tx
    .select({ task: tasks, state: intakeSessionState })
    .from(tasks)
    .leftJoin(intakeSessionState, and(eq(intakeSessionState.intakeSessionId, tasks.intakeSessionId), eq(intakeSessionState.tenantId, tasks.tenantId)))
    .where(and(eq(tasks.tenantId, tenantId), eq(tasks.kind, FIRST_RESPONSE_TASK_KIND), eq(tasks.status, "open")))
    .orderBy(asc(tasks.dueAt))
    .limit(200);
  return rows.map(({ task, state }) => ({
    taskId: task.id,
    intakeSessionId: task.intakeSessionId,
    channel: state?.channel ?? null,
    dueAt: task.dueAt,
    businessMinutesRemaining: businessMinutesRemaining(now, task.dueAt, ctx.calendar),
    // c69 edge case: a safety-flagged person may only be contacted on a confirmed safe channel.
    contactOnlyViaSafeChannel: Boolean(state?.safetyFlagged && !state.safeContactConfirmedAt),
  }));
}

/** Aggregated response-time metrics by channel (for c33 / c74). */
export async function responseTimeMetrics(tx: TenantTx, tenantId: string, since: Date) {
  const ctx = await loadIntakeContext(tx, tenantId);
  const rows = await tx
    .select()
    .from(intakeSessionState)
    .where(and(eq(intakeSessionState.tenantId, tenantId), isNotNull(intakeSessionState.responseClockStartedAt), inArray(intakeSessionState.status, ["active", "closed", "interrupted", "paused_emergency"])));
  return summarizeResponseTimes(
    rows
      .filter((r) => r.responseClockStartedAt! >= since)
      .map((r) => ({
        channel: r.channel,
        startedAt: r.responseClockStartedAt!,
        targetAt: r.responseTargetAt ?? r.responseClockStartedAt!,
        firstHumanContactAt: r.firstHumanContactAt,
        outcome: r.responseOutcome as ResponseOutcome | null,
      })),
    ctx.calendar
  );
}
