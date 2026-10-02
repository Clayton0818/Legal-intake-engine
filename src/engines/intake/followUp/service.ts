// c70 — follow-up sequences (database operations).
//
// Blocked end-to-end until the attorney barratry / advertising review
// ('rules.intake.follow_up_outreach') and each template's copy review are
// approved: enabling fails with 423, and every step re-checks the gates and
// skips (logged) if anything was revoked. Follow-ups are not flags and do
// not trigger c51 flag emails.

import { and, desc, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";
import { intakeMessages, intakeSessionState, intakeConsultations, intakeFollowUpRuns, intakeOpenGateEvidence } from "@/db/tables/intake";
import { intakeSessions, parties } from "@/db/schema";
import type { TenantTx } from "@/tenancy/withTenant";
import { isApproved, requireApproval } from "@/compliance/approvals";
import { resolveClientAddress } from "@/core/contacts";
import { updateEngineSettings } from "@/core/firmSettings";
import { createTask } from "@/core/tasks";
import type { NotificationChannel } from "@/core/notify";
import type { ScheduledTaskRow } from "@/worker/hooks";
import { FOLLOW_UP_GATES, FOLLOW_UP_TEMPLATES } from "../gates";
import { requireStaff, userActor } from "../common/actors";
import { loadIntakeContext, type IntakeContext } from "../common/context";
import { recordIntakeEvent } from "../common/events";
import { notifyParty } from "../common/notify";
import { cancelScheduledTasks, INTAKE_TASK_TYPES, payloadNumber, payloadString, scheduleTask } from "../common/scheduling";
import { getSessionBundle, updateState, type SessionBundle } from "../common/sessions";
import { getConflictStatusForSession } from "../adapters/conflictStatus";
import { safetySuppressed } from "../emergency/service";
import { FOLLOW_UP_TRIGGERS, INTAKE_ENGINE, validateFollowUpSequence, type FollowUpTrigger } from "../settings";
import { closingFor, followUpEligibility, stepDueAt, type FollowUpContext } from "./sequence";
import { practiceAreaForClassifierLabel } from "@/core/practiceAreas";
import { IntakeValidationError } from "../common/errors";

/**
 * Switch follow-ups on or off for the firm (firm_admin). Switching ON
 * requires the outreach review and every template's review (c70 rule 6);
 * a pending gate throws PendingApprovalError → HTTP 423 with the placeholder.
 */
export async function setFollowUpsEnabled(tx: TenantTx, input: { tenantId: string; byUserId: string; enabled: boolean }) {
  await requireStaff(tx, input.tenantId, input.byUserId, ["firm_admin"], "switch follow-up sequences on or off");
  const ctx = await loadIntakeContext(tx, input.tenantId);
  if (input.enabled) {
    requireApproval(FOLLOW_UP_GATES.outreach.key, { action: "intake.follow_up.enable", tenantId: input.tenantId });
    for (const trigger of FOLLOW_UP_TRIGGERS) {
      requireApproval(FOLLOW_UP_TEMPLATES[trigger].key, { action: "intake.follow_up.enable", tenantId: input.tenantId });
      const errors = validateFollowUpSequence(trigger, ctx.settings.followUp.sequences[trigger]);
      if (errors.length > 0) throw new IntakeValidationError(errors.join(" "));
    }
  }
  await updateEngineSettings(tx, input.tenantId, INTAKE_ENGINE, { followUp: { ...ctx.settings.followUp, enabled: input.enabled } }, userActor(input.byUserId));
  await recordIntakeEvent(tx, { tenantId: input.tenantId, eventType: input.enabled ? "follow_ups_enabled" : "follow_ups_disabled", actor: userActor(input.byUserId) });
  return { enabled: input.enabled };
}

async function deliverableChannels(tx: TenantTx, tenantId: string, partyId: string | null, wanted: readonly ("email" | "sms")[]): Promise<("email" | "sms")[]> {
  if (!partyId) return [];
  const [party] = await tx.select().from(parties).where(and(eq(parties.tenantId, tenantId), eq(parties.id, partyId))).limit(1);
  if (!party) return [];
  return wanted.filter((ch) => resolveClientAddress(party, ch).deliver);
}

async function buildContext(
  tx: TenantTx,
  ctx: IntakeContext,
  bundle: SessionBundle,
  trigger: FollowUpTrigger,
  since: Date
): Promise<FollowUpContext> {
  const { session, state } = bundle;
  const conflict = await getConflictStatusForSession(tx, ctx.tenantId, session.id);
  const consults = await tx
    .select({ status: intakeConsultations.status })
    .from(intakeConsultations)
    .where(and(eq(intakeConsultations.tenantId, ctx.tenantId), eq(intakeConsultations.intakeSessionId, session.id)));
  const booked = consults.some((c) => ["held", "booked", "completed"].includes(c.status));
  let signed = false;
  if (session.matterId) {
    const [ev] = await tx
      .select({ id: intakeOpenGateEvidence.id })
      .from(intakeOpenGateEvidence)
      .where(
        and(
          eq(intakeOpenGateEvidence.tenantId, ctx.tenantId),
          eq(intakeOpenGateEvidence.matterId, session.matterId),
          eq(intakeOpenGateEvidence.gate, "engagement_signed"),
          eq(intakeOpenGateEvidence.status, "met"),
          isNull(intakeOpenGateEvidence.supersededAt)
        )
      )
      .limit(1);
    signed = Boolean(ev);
  }
  const [lastInbound] = await tx
    .select({ at: intakeMessages.createdAt })
    .from(intakeMessages)
    .where(and(eq(intakeMessages.tenantId, ctx.tenantId), eq(intakeMessages.intakeSessionId, session.id), eq(intakeMessages.direction, "inbound"), gt(intakeMessages.createdAt, since)))
    .limit(1);
  const classifier = (session.classifierOutput ?? {}) as Record<string, unknown>;
  const practiceArea = practiceAreaForClassifierLabel(typeof classifier.practiceArea === "string" ? classifier.practiceArea : null);
  const seq = ctx.settings.followUp.sequences[trigger];
  const channels = await deliverableChannels(tx, ctx.tenantId, state.partyId, seq.channels);
  return {
    trigger,
    enabled: ctx.settings.followUp.enabled,
    outreachApproved: isApproved(FOLLOW_UP_GATES.outreach.key),
    templateApproved: isApproved(FOLLOW_UP_TEMPLATES[trigger].key),
    inboundFirst: state.channel !== "referral" || state.status !== "referral_awaiting_contact",
    stopped: Boolean(state.followUpStoppedAt),
    declined: state.fitOutcome === "no_fit" || ["not_eligible", "out_of_scope", "declined"].includes(session.terminalState ?? ""),
    conflict: conflict.state,
    safetySuppressed: safetySuppressed(state),
    represented: state.representedByOtherCounsel,
    practiceArea,
    personalInjuryApproved: isApproved(FOLLOW_UP_GATES.personalInjury.key),
    booked,
    signed,
    continued: Boolean(lastInbound),
    humanReplied: Boolean(state.firstHumanContactAt && state.firstHumanContactAt > since),
    hasChannel: channels.length > 0,
  };
}

/** Start a sequence for one lead (c70 §4.1). Returns why not, when not. */
export async function startFollowUp(
  tx: TenantTx,
  input: { tenantId: string; intakeSessionId: string; trigger: FollowUpTrigger; now?: Date }
): Promise<{ started: boolean; reason?: string }> {
  const now = input.now ?? new Date();
  const ctx = await loadIntakeContext(tx, input.tenantId);
  const bundle = await getSessionBundle(tx, input.tenantId, input.intakeSessionId);
  const [active] = await tx
    .select({ id: intakeFollowUpRuns.id })
    .from(intakeFollowUpRuns)
    .where(and(eq(intakeFollowUpRuns.tenantId, input.tenantId), eq(intakeFollowUpRuns.intakeSessionId, input.intakeSessionId), eq(intakeFollowUpRuns.status, "active")))
    .limit(1);
  if (active) return { started: false, reason: "already_active" };
  const [previous] = await tx
    .select({ id: intakeFollowUpRuns.id })
    .from(intakeFollowUpRuns)
    .where(and(eq(intakeFollowUpRuns.tenantId, input.tenantId), eq(intakeFollowUpRuns.intakeSessionId, input.intakeSessionId), eq(intakeFollowUpRuns.trigger, input.trigger)))
    .limit(1);
  if (previous) return { started: false, reason: "already_ran" };

  const check = followUpEligibility(await buildContext(tx, ctx, bundle, input.trigger, now));
  if (!check.eligible) {
    await recordIntakeEvent(tx, {
      tenantId: input.tenantId,
      intakeSessionId: input.intakeSessionId,
      eventType: "follow_up_not_started",
      ruleName: `follow_up.${input.trigger}`,
      payload: { reason: check.reason },
    });
    return { started: false, reason: check.reason };
  }
  const [run] = await tx
    .insert(intakeFollowUpRuns)
    .values({ tenantId: input.tenantId, intakeSessionId: input.intakeSessionId, trigger: input.trigger, startedAt: now })
    .onConflictDoNothing()
    .returning();
  if (!run) return { started: false, reason: "already_active" };
  const seq = ctx.settings.followUp.sequences[input.trigger];
  const due = stepDueAt(now, seq.dayOffsets, 0, ctx.calendar);
  if (due) {
    await scheduleTask(tx, {
      tenantId: input.tenantId,
      taskType: INTAKE_TASK_TYPES.followUpStep,
      dueAt: due,
      intakeSessionId: input.intakeSessionId,
      payload: { runId: run.id, step: 0 },
    });
  }
  await recordIntakeEvent(tx, {
    tenantId: input.tenantId,
    intakeSessionId: input.intakeSessionId,
    eventType: "follow_up_started",
    ruleName: `follow_up.${input.trigger}`,
    payload: { runId: run.id, steps: seq.dayOffsets.length },
  });
  return { started: true };
}

/** Scheduled step: re-check eligibility, send, schedule the next step or close. */
export async function handleFollowUpStep(tx: TenantTx, tenantId: string, task: ScheduledTaskRow, now: Date): Promise<void> {
  const runId = payloadString(task.payload, "runId");
  const step = payloadNumber(task.payload, "step");
  if (!runId || step === null) return;
  const [run] = await tx.select().from(intakeFollowUpRuns).where(and(eq(intakeFollowUpRuns.tenantId, tenantId), eq(intakeFollowUpRuns.id, runId))).limit(1);
  if (!run || run.status !== "active") return;
  const trigger = run.trigger as FollowUpTrigger;
  const ctx = await loadIntakeContext(tx, tenantId);
  const bundle = await getSessionBundle(tx, tenantId, run.intakeSessionId);
  const check = followUpEligibility(await buildContext(tx, ctx, bundle, trigger, run.startedAt));
  if (!check.eligible) {
    await tx.update(intakeFollowUpRuns).set({ status: "stopped", stoppedReason: check.reason, endedAt: now }).where(eq(intakeFollowUpRuns.id, run.id));
    await recordIntakeEvent(tx, {
      tenantId,
      intakeSessionId: run.intakeSessionId,
      eventType: "follow_up_skipped",
      ruleName: `follow_up.${trigger}`,
      payload: { runId: run.id, step, reason: check.reason },
    });
    return;
  }
  const seq = ctx.settings.followUp.sequences[trigger];
  const channels = await deliverableChannels(tx, tenantId, bundle.state.partyId, seq.channels);
  const results = await notifyParty(
    tx,
    {
      tenantId,
      partyId: bundle.state.partyId!,
      templateKey: FOLLOW_UP_TEMPLATES[trigger].key,
      channels: channels as NotificationChannel[],
      matterId: bundle.session.matterId,
      dedupeBase: `intake.follow_up:${run.id}:${step}`,
    },
    { now }
  );
  await tx.update(intakeFollowUpRuns).set({ stepsSent: step + 1 }).where(eq(intakeFollowUpRuns.id, run.id));
  await recordIntakeEvent(tx, {
    tenantId,
    intakeSessionId: run.intakeSessionId,
    eventType: "follow_up_sent",
    ruleName: `follow_up.${trigger}`,
    payload: { runId: run.id, step, templateKey: FOLLOW_UP_TEMPLATES[trigger].key, results },
  });
  const nextDue = stepDueAt(run.startedAt, seq.dayOffsets, step + 1, ctx.calendar);
  if (nextDue) {
    await scheduleTask(tx, {
      tenantId,
      taskType: INTAKE_TASK_TYPES.followUpStep,
      dueAt: nextDue.getTime() > now.getTime() ? nextDue : now,
      intakeSessionId: run.intakeSessionId,
      payload: { runId: run.id, step: step + 1 },
    });
    return;
  }
  // Last step sent: close the lead (c70 §4.6).
  await tx.update(intakeFollowUpRuns).set({ status: "completed", endedAt: now }).where(eq(intakeFollowUpRuns.id, run.id));
  const closing = closingFor(trigger);
  if (closing.terminalState && !bundle.session.terminalState) {
    await tx
      .update(intakeSessions)
      .set({ terminalState: closing.terminalState, completedAt: now })
      .where(and(eq(intakeSessions.tenantId, tenantId), eq(intakeSessions.id, run.intakeSessionId)));
  }
  if (closing.lawyerDecision) {
    await createTask(
      tx,
      {
        tenantId,
        kind: "intake.decide_non_engagement",
        title: "Unsigned agreement after follow-ups: decide whether to send a non-engagement letter",
        owner: { type: "firm" },
        due: { hours: 16, clock: "business" },
        intakeSessionId: run.intakeSessionId,
        matterId: bundle.session.matterId,
        sourceCard: "c70",
        engine: INTAKE_ENGINE,
      },
      { now, calendar: ctx.calendar }
    );
  }
  await recordIntakeEvent(tx, { tenantId, intakeSessionId: run.intakeSessionId, eventType: "follow_up_completed", ruleName: `follow_up.${trigger}`, payload: { runId: run.id } });
}

/**
 * STOP on any channel ends every follow-up on every channel, permanently for
 * this inquiry (c70 rule 7), and ends texting (c65 rule 7). Staff cannot
 * override it without a new written request from the person.
 */
export async function stopFollowUps(
  tx: TenantTx,
  input: { tenantId: string; intakeSessionId: string; channel: string; kind: "keyword" | "natural_language" | "staff_recorded"; now?: Date }
): Promise<void> {
  const now = input.now ?? new Date();
  const { state } = await getSessionBundle(tx, input.tenantId, input.intakeSessionId);
  const alreadyStopped = Boolean(state.followUpStoppedAt);
  await updateState(tx, input.tenantId, input.intakeSessionId, { followUpStoppedAt: state.followUpStoppedAt ?? now, followUpStopReason: `stop_${input.kind}` });
  await tx
    .update(intakeFollowUpRuns)
    .set({ status: "stopped", stoppedReason: "stop", endedAt: now })
    .where(and(eq(intakeFollowUpRuns.tenantId, input.tenantId), eq(intakeFollowUpRuns.intakeSessionId, input.intakeSessionId), eq(intakeFollowUpRuns.status, "active")));
  await cancelScheduledTasks(tx, { tenantId: input.tenantId, taskType: INTAKE_TASK_TYPES.followUpStep, intakeSessionId: input.intakeSessionId, at: now });
  // One stop confirmation, SMS only, once (c70 stop handling §3). Queued BEFORE texting is switched
  // off; the core holds it while the wording or the SMS vendor is pending review.
  if (!alreadyStopped && input.channel === "sms" && state.partyId) {
    await notifyParty(
      tx,
      {
        tenantId: input.tenantId,
        partyId: state.partyId,
        templateKey: FOLLOW_UP_GATES.stopConfirmation.key,
        channels: ["sms"],
        urgent: true,
        dedupeBase: `intake.stop_confirmation:${input.intakeSessionId}`,
      },
      { now }
    );
  }
  if (state.partyId && input.channel === "sms") {
    const [party] = await tx.select({ safeContact: parties.safeContact }).from(parties).where(and(eq(parties.tenantId, input.tenantId), eq(parties.id, state.partyId))).limit(1);
    if (party) {
      await tx
        .update(parties)
        .set({ safeContact: { ...(party.safeContact ?? {}), smsAllowed: false }, updatedAt: now })
        .where(and(eq(parties.tenantId, input.tenantId), eq(parties.id, state.partyId)));
    }
  }
  await recordIntakeEvent(tx, {
    tenantId: input.tenantId,
    intakeSessionId: input.intakeSessionId,
    eventType: "follow_up_stopped",
    payload: { channel: input.channel, kind: input.kind },
  });
}

/**
 * Tick hook: find leads that entered a trigger state and start sequences.
 * Does nothing while follow-ups are disabled (the default).
 */
export async function scanFollowUpTriggers(tx: TenantTx, tenantId: string, now: Date): Promise<{ started: number }> {
  const ctx = await loadIntakeContext(tx, tenantId);
  if (!ctx.settings.followUp.enabled) return { started: 0 };
  const dayAgo = new Date(now.getTime() - 86_400_000);
  const candidates = await tx
    .select({ sessionId: intakeSessionState.intakeSessionId, fit: intakeSessionState.fitOutcome, terminal: intakeSessions.terminalState })
    .from(intakeSessionState)
    .innerJoin(intakeSessions, and(eq(intakeSessions.id, intakeSessionState.intakeSessionId), eq(intakeSessions.tenantId, intakeSessionState.tenantId)))
    .where(
      and(
        eq(intakeSessionState.tenantId, tenantId),
        isNull(intakeSessionState.followUpStoppedAt),
        inArray(intakeSessionState.status, ["active", "interrupted"]),
        lt(intakeSessionState.updatedAt, dayAgo),
        sql`not exists (select 1 from ${intakeFollowUpRuns} r where r.intake_session_id = ${intakeSessionState.intakeSessionId})`
      )
    )
    .orderBy(desc(intakeSessionState.updatedAt))
    .limit(50);
  let started = 0;
  for (const c of candidates) {
    const trigger: FollowUpTrigger = c.fit === "fit" ? "not_booked" : "abandoned_chat";
    if (c.terminal) continue;
    const r = await startFollowUp(tx, { tenantId, intakeSessionId: c.sessionId, trigger, now });
    if (r.started) started++;
  }
  // not_signed: consult held, retainer offered, no signed agreement after 3 days.
  const threeDaysAgo = new Date(now.getTime() - 3 * 86_400_000);
  const offered = await tx
    .select({ sessionId: intakeConsultations.intakeSessionId })
    .from(intakeConsultations)
    .where(
      and(
        eq(intakeConsultations.tenantId, tenantId),
        eq(intakeConsultations.status, "completed"),
        eq(intakeConsultations.outcome, "retain_offered"),
        lt(intakeConsultations.updatedAt, threeDaysAgo),
        sql`not exists (select 1 from ${intakeFollowUpRuns} r where r.intake_session_id = ${intakeConsultations.intakeSessionId} and r.trigger = 'not_signed')`
      )
    )
    .limit(50);
  for (const o of offered) {
    const r = await startFollowUp(tx, { tenantId, intakeSessionId: o.sessionId, trigger: "not_signed", now });
    if (r.started) started++;
  }
  return { started };
}
