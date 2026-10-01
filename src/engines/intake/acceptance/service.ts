// c73 — case acceptance rules (database operations).
//
// Rule sets are versioned (intake_fit_rule_sets, append-only). A session is
// always evaluated with the rule set that was in force when it started, and
// every evaluation stores the rule results, version and declining rule ids,
// so any decline traces to the rule that applied (c6).

import { and, desc, eq, inArray, isNull, lte } from "drizzle-orm";
import { intakeSessions } from "@/db/schema";
import { intakeEmergencyAlerts, intakeFitEvaluations, intakeFitRuleSets, intakeReferralDirectory } from "@/db/tables/intake";
import type { TenantTx } from "@/tenancy/withTenant";
import { isApproved } from "@/compliance/approvals";
import { enabledPracticeAreas } from "@/core/practiceAreas";
import { completeTask, createTask } from "@/core/tasks";
import { tasks } from "@/db/tables/foundation";
import { ACCEPTANCE_GATES } from "../gates";
import { LAWYER_ROLES, requireStaff, STAFF_ROLES, userActor } from "../common/actors";
import { loadIntakeContext, type IntakeContext } from "../common/context";
import { IntakeNotFoundError, IntakeRuleError, IntakeValidationError, requireReason } from "../common/errors";
import { recordIntakeEvent } from "../common/events";
import { practiceAreaFromClassifier } from "../common/matters";
import { notifyParty } from "../common/notify";
import { getSessionBundle, updateState, type SessionBundle } from "../common/sessions";
import { getConflictStatusForSession } from "../adapters/conflictStatus";
import { previewAssignment } from "../assignment/service";
import { systemMoveMatter } from "../pipeline/service";
import { closeClockForDecline } from "../speedToLead/service";
import { INTAKE_ENGINE } from "../settings";
import {
  compareRuleSets,
  decideFit,
  declineTerminalState,
  defaultFitRules,
  matchReferrals,
  validateFitRules,
  type FitDecision,
  type FitFacts,
  type FitGuards,
  type FitRule,
  type ReferralEntry,
} from "./rules";

export const FIT_REVIEW_TASK_KIND = "intake.fit_review";

export interface RuleSetView {
  id: string | null;
  version: number;
  rules: FitRule[];
  effectiveFrom: Date | null;
  persisted: boolean;
}

function defaultsFor(ctx: IntakeContext): FitRule[] {
  return defaultFitRules({ enabledPracticeAreas: enabledPracticeAreas(ctx.firm), counties: ctx.settings.acceptance.countiesServed });
}

/** The rule set in force at `at` (a session's start time pins its version, c73 §4 rule editing 3). */
export async function getRuleSetAt(tx: TenantTx, ctx: IntakeContext, at: Date): Promise<RuleSetView> {
  const [row] = await tx
    .select()
    .from(intakeFitRuleSets)
    .where(and(eq(intakeFitRuleSets.tenantId, ctx.tenantId), lte(intakeFitRuleSets.effectiveFrom, at)))
    .orderBy(desc(intakeFitRuleSets.version))
    .limit(1);
  if (!row) return { id: null, version: 0, rules: defaultsFor(ctx), effectiveFrom: null, persisted: false };
  return { id: row.id, version: row.version, rules: row.rules as unknown as FitRule[], effectiveFrom: row.effectiveFrom, persisted: true };
}

export async function getCurrentRuleSet(tx: TenantTx, tenantId: string): Promise<RuleSetView> {
  return getRuleSetAt(tx, await loadIntakeContext(tx, tenantId), new Date());
}

/** Save a new rule-set version (firm_admin). Optimistic concurrency on the version. */
export async function saveRuleSet(
  tx: TenantTx,
  input: { tenantId: string; byUserId: string; rules: FitRule[]; expectedVersion: number; now?: Date }
): Promise<RuleSetView> {
  await requireStaff(tx, input.tenantId, input.byUserId, ["firm_admin"], "edit case-acceptance rules");
  const now = input.now ?? new Date();
  const ctx = await loadIntakeContext(tx, input.tenantId);
  const current = await getRuleSetAt(tx, ctx, now);
  if (current.version !== input.expectedVersion) {
    throw new IntakeRuleError("The rules changed since you opened them. Reload to see the newer version.", { currentVersion: current.version });
  }
  const errors = validateFitRules(input.rules);
  if (errors.length > 0) throw new IntakeValidationError(errors.join(" "));
  const version = current.version + 1;
  const [row] = await tx
    .insert(intakeFitRuleSets)
    .values({ tenantId: input.tenantId, version, rules: input.rules as unknown as Record<string, unknown>[], effectiveFrom: now, createdByUserId: input.byUserId })
    .returning();
  await recordIntakeEvent(tx, {
    tenantId: input.tenantId,
    eventType: "fit_rules_saved",
    actor: userActor(input.byUserId),
    entityType: "fit_rule_set",
    entityId: row?.id ?? null,
    payload: { version, ruleIds: input.rules.map((r) => r.id) },
  });
  return { id: row?.id ?? null, version, rules: input.rules, effectiveFrom: now, persisted: true };
}

/** Pure: the facts a session offers the fit rules. */
export function factsFromSession(
  session: Pick<SessionBundle["session"], "classifierOutput" | "collectedAnswers" | "language">,
  enabledAreas: readonly string[],
  capacityAvailable: boolean | null
): { facts: FitFacts; confidence: number | null } {
  const classifier = (session.classifierOutput ?? {}) as Record<string, unknown>;
  const answers = (session.collectedAnswers ?? {}) as Record<string, unknown>;
  const label = typeof classifier.practiceArea === "string" ? classifier.practiceArea : null;
  const confidence = typeof classifier.confidence === "number" ? classifier.confidence : null;
  const county = typeof answers.county === "string" && answers.county.trim() ? answers.county.trim().toLowerCase() : null;
  return {
    facts: {
      practiceArea: practiceAreaFromClassifier(session.classifierOutput),
      matterType: label && label !== "unknown" ? label : null,
      county,
      language: session.language ?? null,
      answers,
      enabledPracticeAreas: enabledAreas,
      capacityAvailable,
    },
    confidence,
  };
}

async function capacitySignal(tx: TenantTx, tenantId: string, matterId: string | null, now: Date): Promise<boolean | null> {
  if (!matterId) return null;
  const decision = await previewAssignment(tx, tenantId, matterId, now);
  return decision.winner !== null;
}

async function hasOpenEmergency(tx: TenantTx, tenantId: string, sessionId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: intakeEmergencyAlerts.id })
    .from(intakeEmergencyAlerts)
    .where(
      and(
        eq(intakeEmergencyAlerts.tenantId, tenantId),
        eq(intakeEmergencyAlerts.intakeSessionId, sessionId),
        inArray(intakeEmergencyAlerts.track, ["safety", "urgent_legal"]),
        isNull(intakeEmergencyAlerts.downgradedAt)
      )
    )
    .limit(1);
  return Boolean(row);
}

async function guardsFor(tx: TenantTx, ctx: IntakeContext, bundle: SessionBundle, confidence: number | null): Promise<FitGuards> {
  const conflict = await getConflictStatusForSession(tx, ctx.tenantId, bundle.session.id);
  return {
    confidence,
    confidenceThreshold: ctx.settings.acceptance.confidenceThreshold,
    autoDeclineEnabled: ctx.settings.acceptance.autoDeclineEnabled,
    autoDeclineApproved: isApproved(ACCEPTANCE_GATES.autoDecline.key),
    // An open emergency (acknowledged or not) keeps the decline waiting until staff release it (c73 acceptance 7).
    emergencyOpen: (await hasOpenEmergency(tx, ctx.tenantId, bundle.session.id)) || bundle.state.status === "paused_emergency",
    conflictPending: conflict.state === "possible_pending",
  };
}

export interface FitEvaluationResult {
  evaluationId: string;
  decision: FitDecision;
  ruleSetVersion: number;
  declineQueued: boolean;
}

/**
 * Evaluate the firm's fit rules for a session (after triage). Clear no-fit
 * declines automatically only when every guard allows it; borderline goes to
 * a lawyer review task.
 */
export async function evaluateFit(tx: TenantTx, input: { tenantId: string; intakeSessionId: string; now?: Date }): Promise<FitEvaluationResult> {
  const now = input.now ?? new Date();
  const ctx = await loadIntakeContext(tx, input.tenantId);
  const bundle = await getSessionBundle(tx, input.tenantId, input.intakeSessionId);
  if (bundle.session.terminalState) throw new IntakeRuleError("This inquiry is already closed.");
  const ruleSet = await getRuleSetAt(tx, ctx, bundle.session.startedAt);
  const capacity = await capacitySignal(tx, input.tenantId, bundle.session.matterId, now);
  const { facts, confidence } = factsFromSession(bundle.session, enabledPracticeAreas(ctx.firm), capacity);
  const decision = decideFit(ruleSet.rules, facts, await guardsFor(tx, ctx, bundle, confidence));

  const [evaluation] = await tx
    .insert(intakeFitEvaluations)
    .values({
      tenantId: input.tenantId,
      intakeSessionId: bundle.session.id,
      outcome: decision.outcome,
      ruleResults: decision.results as unknown as Record<string, unknown>[],
      reasons: decision.reasons,
      confidence,
      ruleSetId: ruleSet.id,
      ruleSetVersion: ruleSet.version,
      createdAt: now,
    })
    .returning();
  if (!evaluation) throw new Error("evaluateFit: insert failed.");
  await updateState(tx, input.tenantId, bundle.session.id, { fitOutcome: decision.outcome });
  await recordIntakeEvent(tx, {
    tenantId: input.tenantId,
    intakeSessionId: bundle.session.id,
    matterId: bundle.session.matterId,
    eventType: "fit_evaluated",
    ruleName: `fit_rules.v${ruleSet.version}${decision.decliningRuleIds.length ? `:${decision.decliningRuleIds.join(",")}` : ""}`,
    firmConfigVersionId: bundle.session.firmConfigVersionId,
    entityType: "fit_evaluation",
    entityId: evaluation.id,
    payload: {
      outcome: decision.outcome,
      reasons: decision.reasons,
      ruleSetVersion: ruleSet.version,
      decliningRules: decision.results.filter((r) => decision.decliningRuleIds.includes(r.ruleId)).map((r) => ({ id: r.ruleId, text: r.description })),
    },
  });

  let declineQueued = false;
  if (decision.outcome === "no_fit") {
    await sendDecline(tx, ctx, bundle, evaluation.id, facts, decision, null, now);
    declineQueued = true;
  } else if (decision.outcome === "borderline") {
    await createTask(
      tx,
      {
        tenantId: input.tenantId,
        kind: FIT_REVIEW_TASK_KIND,
        title: "Review a borderline inquiry: accept, decline or ask for more information",
        description: `Rule results need a lawyer's decision (${decision.reasons.slice(0, 5).join("; ")}).`,
        owner: { type: "firm" },
        due: { hours: ctx.settings.acceptance.reviewBusinessHours, clock: "business" },
        intakeSessionId: bundle.session.id,
        matterId: bundle.session.matterId,
        sourceCard: "c73",
        sourceRef: `fit_evaluation:${evaluation.id}`,
        engine: INTAKE_ENGINE,
      },
      { now, calendar: ctx.calendar }
    );
  }
  return { evaluationId: evaluation.id, decision, ruleSetVersion: ruleSet.version, declineQueued };
}

/**
 * Send the neutral non-engagement notice (c62 letter, gated wording) and
 * optional referrals from the firm's own list, and close the inquiry.
 * `decidedByUserId` null = automatic decline under an approved rule.
 */
async function sendDecline(
  tx: TenantTx,
  ctx: IntakeContext,
  bundle: SessionBundle,
  evaluationId: string,
  facts: FitFacts,
  decision: Pick<FitDecision, "results">,
  decidedByUserId: string | null,
  now: Date
): Promise<void> {
  const { session, state } = bundle;
  let referrals: ReferralEntry[] = [];
  if (ctx.settings.acceptance.referralsEnabled && isApproved(ACCEPTANCE_GATES.referralList.key)) {
    const rows = await tx.select().from(intakeReferralDirectory).where(and(eq(intakeReferralDirectory.tenantId, ctx.tenantId), eq(intakeReferralDirectory.active, true)));
    referrals = matchReferrals(rows, facts.practiceArea, facts.county);
  }
  if (state.partyId) {
    await notifyParty(
      tx,
      { tenantId: ctx.tenantId, partyId: state.partyId, templateKey: ACCEPTANCE_GATES.declineNotice.key, channels: ["in_app", "email"], dedupeBase: `intake.decline:${session.id}` },
      { now }
    );
  }
  await tx
    .update(intakeFitEvaluations)
    .set({ declineSentAt: now, referralsShown: referrals.map((r) => ({ id: r.id, name: r.name })) })
    .where(eq(intakeFitEvaluations.id, evaluationId));
  await tx
    .update(intakeSessions)
    .set({ terminalState: declineTerminalState(decision.results), completedAt: now })
    .where(and(eq(intakeSessions.tenantId, ctx.tenantId), eq(intakeSessions.id, session.id)));
  // Declined prospects are never followed up (c70); their names stay in the party index (c62).
  await updateState(tx, ctx.tenantId, session.id, { status: "closed", followUpStoppedAt: state.followUpStoppedAt ?? now, followUpStopReason: "declined" });
  await closeClockForDecline(tx, { tenantId: ctx.tenantId, intakeSessionId: session.id, userId: decidedByUserId, now });
  if (session.matterId) {
    await systemMoveMatter(tx, {
      tenantId: ctx.tenantId,
      matterId: session.matterId,
      systemStage: "did_not_hire_referred_out",
      via: "system",
      actor: decidedByUserId ? userActor(decidedByUserId) : undefined,
      reason: "Declined under the firm's case-acceptance rules",
    });
  }
  await recordIntakeEvent(tx, {
    tenantId: ctx.tenantId,
    intakeSessionId: session.id,
    matterId: session.matterId,
    eventType: "decline_sent",
    ruleName: decidedByUserId ? "fit.lawyer_decline" : "fit.auto_decline",
    actor: decidedByUserId ? userActor(decidedByUserId) : undefined,
    entityType: "fit_evaluation",
    entityId: evaluationId,
    payload: { referralIds: referrals.map((r) => r.id), noticeGate: ACCEPTANCE_GATES.declineNotice.key, wordingApproved: isApproved(ACCEPTANCE_GATES.declineNotice.key) },
  });
}

/** A lawyer decides a borderline case (c73 §4.5). A reason is required and logged. */
export async function decideBorderline(
  tx: TenantTx,
  input: { tenantId: string; evaluationId: string; userId: string; decision: "accept" | "decline" | "more_info"; reason: string; now?: Date }
): Promise<{ outcome: string }> {
  const reason = requireReason(input.reason, "A borderline decision");
  await requireStaff(tx, input.tenantId, input.userId, LAWYER_ROLES, "decide a borderline inquiry");
  const now = input.now ?? new Date();
  const [evaluation] = await tx
    .select()
    .from(intakeFitEvaluations)
    .where(and(eq(intakeFitEvaluations.tenantId, input.tenantId), eq(intakeFitEvaluations.id, input.evaluationId)))
    .limit(1);
  if (!evaluation) throw new IntakeNotFoundError("Fit evaluation");
  if (evaluation.outcome !== "borderline") throw new IntakeRuleError("Only borderline evaluations need a lawyer's decision.");
  if (evaluation.decision && evaluation.decision !== "more_info") throw new IntakeRuleError("This evaluation was already decided.");
  const ctx = await loadIntakeContext(tx, input.tenantId);
  const bundle = await getSessionBundle(tx, input.tenantId, evaluation.intakeSessionId);
  if (input.decision === "decline" && bundle.state.status === "paused_emergency") {
    throw new IntakeRuleError("An emergency on this inquiry must be handled before any decline is sent (c66 runs first).");
  }
  await tx
    .update(intakeFitEvaluations)
    .set({ decision: input.decision, decidedByUserId: input.userId, decisionReason: reason })
    .where(eq(intakeFitEvaluations.id, evaluation.id));

  if (input.decision === "accept") {
    await updateState(tx, input.tenantId, bundle.session.id, { fitOutcome: "fit" });
  } else if (input.decision === "decline") {
    const { facts } = factsFromSession(bundle.session, enabledPracticeAreas(ctx.firm), null);
    const results = (evaluation.ruleResults ?? []) as unknown as FitDecision["results"];
    await sendDecline(tx, ctx, bundle, evaluation.id, facts, { results }, input.userId, now);
  } else {
    await createTask(
      tx,
      {
        tenantId: input.tenantId,
        kind: "intake.fit_more_info",
        title: "Collect more information for a lawyer's case-acceptance decision",
        description: reason,
        owner: { type: "firm" },
        due: { hours: ctx.settings.acceptance.reviewBusinessHours, clock: "business" },
        intakeSessionId: bundle.session.id,
        matterId: bundle.session.matterId,
        sourceCard: "c73",
        sourceRef: `fit_evaluation:${evaluation.id}`,
        engine: INTAKE_ENGINE,
      },
      { now, calendar: ctx.calendar }
    );
  }
  // Close the review task for this evaluation.
  const [reviewTask] = await tx
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.tenantId, input.tenantId), eq(tasks.kind, FIT_REVIEW_TASK_KIND), eq(tasks.sourceRef, `fit_evaluation:${evaluation.id}`), eq(tasks.status, "open")))
    .limit(1);
  if (reviewTask) {
    await completeTask(tx, { tenantId: input.tenantId, taskId: reviewTask.id, by: userActor(input.userId), reason: `Lawyer decision: ${input.decision}`, engine: INTAKE_ENGINE, at: now });
  }
  await recordIntakeEvent(tx, {
    tenantId: input.tenantId,
    intakeSessionId: bundle.session.id,
    matterId: bundle.session.matterId,
    eventType: "fit_borderline_decided",
    ruleName: `fit_rules.v${evaluation.ruleSetVersion ?? 0}`,
    actor: userActor(input.userId),
    reason,
    entityType: "fit_evaluation",
    entityId: evaluation.id,
    payload: { decision: input.decision },
  });
  return { outcome: input.decision === "accept" ? "fit" : input.decision === "decline" ? "no_fit" : "borderline" };
}

/** The rule editor's test panel: run draft rules over the last 50 inquiries (outcomes only, nothing sent). */
export async function testDraftRules(tx: TenantTx, input: { tenantId: string; byUserId: string; rules: FitRule[] }) {
  await requireStaff(tx, input.tenantId, input.byUserId, ["firm_admin"], "test case-acceptance rules");
  const errors = validateFitRules(input.rules);
  if (errors.length > 0) throw new IntakeValidationError(errors.join(" "));
  const ctx = await loadIntakeContext(tx, input.tenantId);
  const current = await getRuleSetAt(tx, ctx, new Date());
  const sessions = await tx
    .select()
    .from(intakeSessions)
    .where(eq(intakeSessions.tenantId, input.tenantId))
    .orderBy(desc(intakeSessions.startedAt))
    .limit(50);
  const areas = enabledPracticeAreas(ctx.firm);
  const samples = sessions.map((s) => {
    const { facts, confidence } = factsFromSession(s, areas, null);
    const guards: FitGuards = {
      confidence,
      confidenceThreshold: ctx.settings.acceptance.confidenceThreshold,
      autoDeclineEnabled: ctx.settings.acceptance.autoDeclineEnabled,
      autoDeclineApproved: isApproved(ACCEPTANCE_GATES.autoDecline.key),
      emergencyOpen: false,
      conflictPending: false,
    };
    return { id: s.id, facts, guards };
  });
  const changes = compareRuleSets(samples, current.rules, input.rules);
  return { sampled: samples.length, changed: changes.length, changes };
}

export async function listFitEvaluations(tx: TenantTx, tenantId: string, intakeSessionId: string) {
  return tx
    .select()
    .from(intakeFitEvaluations)
    .where(and(eq(intakeFitEvaluations.tenantId, tenantId), eq(intakeFitEvaluations.intakeSessionId, intakeSessionId)))
    .orderBy(desc(intakeFitEvaluations.createdAt));
}

// ---------------------------------------------------------------------------
// Referral directory (the firm's own list; nothing about referral fees, Rule 1.04)
// ---------------------------------------------------------------------------

export async function listReferralDirectory(tx: TenantTx, tenantId: string) {
  return tx.select().from(intakeReferralDirectory).where(eq(intakeReferralDirectory.tenantId, tenantId));
}

export async function addReferralEntry(
  tx: TenantTx,
  input: { tenantId: string; byUserId: string; name: string; contact: string; practiceAreas?: string[]; counties?: string[] }
) {
  await requireStaff(tx, input.tenantId, input.byUserId, ["firm_admin"], "edit the referral list");
  if (!input.name.trim() || !input.contact.trim()) throw new IntakeValidationError("A referral entry needs a name and contact details.");
  const clean = (xs: string[] = []) => [...new Set(xs.map((x) => x.trim().toLowerCase()).filter(Boolean))];
  const [row] = await tx
    .insert(intakeReferralDirectory)
    .values({ tenantId: input.tenantId, name: input.name.trim(), contact: input.contact.trim(), practiceAreas: clean(input.practiceAreas), counties: clean(input.counties) })
    .returning();
  await recordIntakeEvent(tx, { tenantId: input.tenantId, eventType: "referral_entry_added", actor: userActor(input.byUserId), entityType: "referral_entry", entityId: row?.id ?? null });
  return row;
}

export async function deactivateReferralEntry(tx: TenantTx, input: { tenantId: string; byUserId: string; entryId: string }) {
  await requireStaff(tx, input.tenantId, input.byUserId, ["firm_admin"], "edit the referral list");
  await tx.update(intakeReferralDirectory).set({ active: false }).where(and(eq(intakeReferralDirectory.tenantId, input.tenantId), eq(intakeReferralDirectory.id, input.entryId)));
  await recordIntakeEvent(tx, { tenantId: input.tenantId, eventType: "referral_entry_removed", actor: userActor(input.byUserId), entityType: "referral_entry", entityId: input.entryId });
}

/** Staff-only guard used by routes that show evaluations. */
export async function requireIntakeStaff(tx: TenantTx, tenantId: string, userId: string): Promise<void> {
  await requireStaff(tx, tenantId, userId, STAFF_ROLES, "view intake records");
}
