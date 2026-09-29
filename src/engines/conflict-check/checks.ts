// Running a conflict check, opening the attorney's decision task (c59
// §4.1), and maintaining the conflict gate (c59 §4.5).
//
// The check is c3 (core check, coreCheck.ts) over c57 (near-miss matching,
// matching.ts): any hit, any unnamed party, or a firm whose history import
// (c96) is not confirmed produces 'possible'; 'definite' only ever comes from
// the attorney-approved rule table or role matrix (`rules.conflicts`).
// Nothing here clears a conflict.

import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { conflictChecks, conflictDecisions, conflictGates, conflictScreens, conflictWaivers } from "@/db/tables/conflict-check";
import { firms } from "@/db/schema";
import {
  audit,
  auditBlocked,
  createTask,
  getFirmSettings,
  raiseFlag,
  toBusinessCalendar,
  addBusinessHours,
  SYSTEM_ACTOR,
  type Actor,
} from "@/core";
import { legalCopy, PendingApprovalError, requireApproval } from "@/compliance/approvals";
import { RULE_GATES } from "@/compliance/gates";
import type { TenantTx } from "@/tenancy/withTenant";
import { listConflictAttorneys, listFirmAdmins, pickReviewer } from "./access";
import { classifyOutcome, combineGates, computeCheckGate, interestOwners, type GateResult, type GatedAction } from "./decisions";
import { CONFLICT_COPY_GATES } from "./gates";
import { expandOrgLinkHits, matchIndex } from "./matching";
import { loadIndexEntries, loadOrgLinks } from "./partyIndex";
import { applyRuleTable, DRAFT_RULE_TABLE, UNAPPLIED_ASSESSMENT, type RuleAssessment } from "./ruleTable";
import { evaluateRoleMatrix, intakeDirective, type IntakeDirective, type RoleEvaluation } from "./coreCheck";
import { ENGINE, readConflictSettings } from "./settings";
import type { CheckTrigger, ConflictHit, Decision, GateSubject, IndexSourceType, SearchedName } from "./types";

export type ConflictCheckRow = typeof conflictChecks.$inferSelect;
export type ConflictDecisionRow = typeof conflictDecisions.$inferSelect;

// ---------------------------------------------------------------------------
// Rule table (gated)
// ---------------------------------------------------------------------------

/**
 * Apply the c55 rule table to hits — only when `rules.conflicts` is approved.
 * When it is pending the attempt is logged (approval.blocked) and the
 * UNAPPLIED assessment is returned: nothing upgraded, nothing disabled.
 */
export async function assessHits(
  tx: TenantTx,
  tenantId: string,
  hits: readonly ConflictHit[],
  ctx: { checkId?: string | null; matterId?: string | null; intakeSessionId?: string | null; actor?: Actor } = {}
): Promise<RuleAssessment> {
  if (hits.length === 0) return UNAPPLIED_ASSESSMENT;
  try {
    requireApproval(RULE_GATES.conflictRules.key, { action: "conflict-check.apply_rule_table", tenantId });
  } catch (err) {
    if (!(err instanceof PendingApprovalError)) throw err;
    await auditBlocked(tx, err, {
      tenantId,
      engine: ENGINE,
      entityType: ctx.checkId ? "conflict_check" : undefined,
      entityId: ctx.checkId ?? null,
      matterId: ctx.matterId ?? null,
      intakeSessionId: ctx.intakeSessionId ?? null,
      actor: ctx.actor ?? SYSTEM_ACTOR,
    });
    return UNAPPLIED_ASSESSMENT;
  }
  return applyRuleTable(hits, DRAFT_RULE_TABLE);
}

// ---------------------------------------------------------------------------
// Running a check
// ---------------------------------------------------------------------------

export interface RunCheckInput {
  tenantId: string;
  trigger: CheckTrigger;
  subject?: GateSubject | null;
  searched: SearchedName[];
  roleSought?: string | null;
  triggeredBy?: Actor;
  legacyResultId?: string | null;
  lateralCheckId?: string | null;
  interestDisclosureId?: string | null;
  /** The index write for this intake failed repeatedly (c56 §4.7): never 'clear'. */
  indexWriteFailed?: boolean;
  /** Which stores to search (default: all three). */
  sources?: IndexSourceType[];
  /** For interest checks: open matters whose gates close for new actions until decided. */
  affectedMatterIds?: string[];
  /** c97 §4.3: close the gate of every CURRENT matter a hit involves (a lawyer's new interest). */
  closeAffectedMatters?: boolean;
  /** c97: the lawyer whose disclosure is being checked (never reviews it; recorded on each hit). */
  interestOwnerUserId?: string | null;
  now?: Date;
}

export interface RunCheckResult {
  check: ConflictCheckRow;
  gate: GateResult | null;
  /** c3: what the intake flow does next (proceed / pause and escalate / stop with a neutral referral). */
  directive: IntakeDirective;
}

export async function runConflictCheck(tx: TenantTx, input: RunCheckInput): Promise<RunCheckResult> {
  const now = input.now ?? new Date();
  const actor = input.triggeredBy ?? SYSTEM_ACTOR;
  const firmSettings = await getFirmSettings(tx, input.tenantId);
  const settings = readConflictSettings(firmSettings);
  const subject = input.subject ?? null;

  const entries = await loadIndexEntries(tx, {
    tenantId: input.tenantId,
    names: input.searched.filter((s) => !s.nameUnknown).map((s) => s.name),
    emails: input.searched.map((s) => s.email ?? "").filter(Boolean),
    phones: input.searched.map((s) => s.phone ?? "").filter(Boolean),
    sources: input.sources,
  });
  const exclude = subject ? { kind: subject.type === "matter" ? ("matter" as const) : ("inquiry" as const), id: subject.id } : null;
  let hits = matchIndex(input.searched, entries, { exclude });

  if (settings.orgLinkDepth > 0 && hits.some((h) => h.sourceType === "party")) {
    const links = await loadOrgLinks(tx, input.tenantId);
    if (links.length > 0) {
      const neighbourIds = links.flatMap((l) => [l.parentPartyId, l.childPartyId]);
      const neighbours = await loadIndexEntries(tx, { tenantId: input.tenantId, names: [], sources: ["party"], extraPartyIds: neighbourIds });
      const byParty = new Map(
        neighbours
          .map((e) => ({ ...e, involvements: exclude ? e.involvements.filter((i) => !(i.kind === exclude.kind && i.id === exclude.id)) : e.involvements }))
          .map((e) => [e.partyId!, e] as const)
      );
      hits = expandOrgLinkHits(hits, links, byParty, settings.orgLinkDepth);
    }
  }

  if (input.interestOwnerUserId) hits = hits.map((h) => ({ ...h, ownerUserId: input.interestOwnerUserId! }));
  const affectedMatterIds = [
    ...new Set([
      ...(input.affectedMatterIds ?? []),
      ...(input.closeAffectedMatters
        ? hits.flatMap((h) => h.involvements.filter((i) => i.kind === "matter" && i.status === "current").map((i) => i.id))
        : []),
    ]),
  ];

  const assessment = await assessHits(tx, input.tenantId, hits, {
    matterId: subject?.type === "matter" ? subject.id : null,
    intakeSessionId: subject?.type === "intake_session" ? subject.id : null,
    actor,
  });
  // c3: evaluate hits against the role being sought. Always recorded for the
  // reviewer; it can only make the result 'definite' when rules.conflicts is
  // approved (the same approval that lets the rule table apply).
  const roleEvaluation: RoleEvaluation = evaluateRoleMatrix({
    hits,
    roleSought: input.roleSought,
    matrix: settings.roleMatrix,
    sources: settings.conflictSources,
    definiteMinStrength: settings.definiteMinStrength,
    applied: assessment.applied,
  });
  const { outcome, reasons } = classifyOutcome({
    hits,
    searched: input.searched,
    trigger: input.trigger,
    historyImportConfirmed: settings.historyImportConfirmedAt !== null,
    indexWriteFailed: input.indexWriteFailed,
    assessment,
    roleEvaluation,
  });

  const [check] = await tx
    .insert(conflictChecks)
    .values({
      tenantId: input.tenantId,
      trigger: input.trigger,
      intakeSessionId: subject?.type === "intake_session" ? subject.id : null,
      matterId: subject?.type === "matter" ? subject.id : null,
      lateralCheckId: input.lateralCheckId ?? null,
      interestDisclosureId: input.interestDisclosureId ?? null,
      affectedMatterIds,
      legacyResultId: input.legacyResultId ?? null,
      triggeredByUserId: actor.type === "user" ? actor.userId : null,
      roleSought: input.roleSought ?? null,
      searchedNames: input.searched.map((s) => ({ name: s.name, role: s.role, nameUnknown: !!s.nameUnknown, completeness: s.completeness ?? "full" })),
      hits,
      outcome,
      outcomeReasons: reasons,
      ruleTableApplied: assessment.applied,
      roleEvaluation: roleEvaluation as unknown as Record<string, unknown>,
      status: outcome === "clear" ? "not_required" : "open",
      createdAt: now,
      closedAt: outcome === "clear" ? now : null,
    })
    .returning();

  await audit(tx, {
    tenantId: input.tenantId,
    engine: ENGINE,
    action: "check.completed",
    entityType: "conflict_check",
    entityId: check!.id,
    matterId: check!.matterId,
    intakeSessionId: check!.intakeSessionId,
    actor,
    // Counts only: names and hit details stay on the restricted check record.
    payload: {
      trigger: input.trigger,
      outcome,
      reasons,
      hitCount: hits.length,
      searchedCount: input.searched.length,
      roleSought: roleEvaluation.roleSought,
      roleFindings: roleEvaluation.findings.length,
      roleMatrixApplied: roleEvaluation.applied,
    },
  });

  let row = check!;
  if (outcome !== "clear") row = await openDecisionTask(tx, row, { now, firmSettings });

  const gate = await refreshGatesForCheck(tx, row, now);
  const directive = intakeDirective(outcome, {
    pendingCopyKey: CONFLICT_COPY_GATES.pendingReview.key,
    definiteCopyKey: CONFLICT_COPY_GATES.definiteReferral.key,
    referral: settings.referralSources.find((r) => !r.practiceArea) ?? settings.referralSources[0] ?? null,
    referralDestination: settings.definiteReferralDestination,
  });
  return { check: row, gate, directive };
}

/**
 * What the caller is told for a directive — approval-gated wording only
 * (a visible placeholder until an attorney approves it), never a name, the
 * other matter, or the word 'conflict'.
 */
export async function directiveMessage(tx: TenantTx, tenantId: string, directive: IntakeDirective): Promise<string | null> {
  if (!directive.clientCopyKey) return null;
  const [firm] = await tx.select({ name: firms.name }).from(firms).where(eq(firms.id, tenantId)).limit(1);
  return legalCopy(directive.clientCopyKey, {
    firmName: firm?.name ?? "the firm",
    // Firms set their referral sources in settings; this fallback names no organisation.
    referralName: directive.referral?.name ?? "a lawyer referral service",
    referralContact: directive.referral?.contact ?? "your local bar association",
  });
}

/** Subjects whose gate this check affects. */
export function subjectsOf(check: Pick<ConflictCheckRow, "intakeSessionId" | "matterId" | "affectedMatterIds">): GateSubject[] {
  const out: GateSubject[] = [];
  if (check.intakeSessionId) out.push({ type: "intake_session", id: check.intakeSessionId });
  if (check.matterId) out.push({ type: "matter", id: check.matterId });
  for (const id of check.affectedMatterIds ?? []) if (id !== check.matterId) out.push({ type: "matter", id });
  return out;
}

async function refreshGatesForCheck(tx: TenantTx, check: ConflictCheckRow, now: Date): Promise<GateResult | null> {
  let first: GateResult | null = null;
  for (const subject of subjectsOf(check)) {
    const g = await refreshGate(tx, check.tenantId, subject, now);
    first ??= g;
  }
  return first;
}

// ---------------------------------------------------------------------------
// Decision task (c59 §4.1)
// ---------------------------------------------------------------------------

export async function openDecisionTask(
  tx: TenantTx,
  check: ConflictCheckRow,
  opts: { now: Date; firmSettings?: Awaited<ReturnType<typeof getFirmSettings>> }
): Promise<ConflictCheckRow> {
  const firmSettings = opts.firmSettings ?? (await getFirmSettings(tx, check.tenantId));
  const settings = readConflictSettings(firmSettings);
  const calendar = toBusinessCalendar(firmSettings);
  const [attorneys, admins] = await Promise.all([listConflictAttorneys(tx, check.tenantId), listFirmAdmins(tx, check.tenantId)]);
  // A lawyer who is the subject of an interest hit never reviews it (c59 §4.7).
  const exclude = interestOwners(check.hits as ConflictHit[]);
  const reviewer = pickReviewer(attorneys, admins, exclude.length > 0 && attorneys.all.some((id) => !exclude.includes(id)) ? exclude : []);

  const hours = check.trigger === "intake" ? settings.decisionDueBusinessHoursIntake : settings.decisionDueBusinessHoursMatter;
  const dueAt = addBusinessHours(opts.now, hours, calendar);
  const task = await createTask(
    tx,
    {
      tenantId: check.tenantId,
      kind: "conflict-check.decision_due",
      // No names anywhere a non-conflicts user could see (task lists, emails).
      title: "Conflicts review waiting",
      description: "A conflict check needs a decision by the conflicts attorney. Open the conflicts queue to review it.",
      owner: reviewer.userId ? { type: "user", userId: reviewer.userId } : { type: "firm" },
      supervisorUserId: reviewer.supervisorUserId,
      due: { at: dueAt, clock: "business" },
      matterId: check.matterId,
      intakeSessionId: check.intakeSessionId,
      sourceCard: "c59",
      sourceRef: `conflict_check:${check.id}`,
      metadata: { checkId: check.id, outcome: check.outcome, trigger: check.trigger },
      engine: ENGINE,
    },
    { now: opts.now, calendar }
  );

  if (reviewer.userId) {
    await raiseFlag(
      tx,
      {
        tenantId: check.tenantId,
        type: "conflict-check.review_waiting",
        severity: check.outcome === "definite" ? "high" : "warning",
        audience: "internal",
        title: "A conflicts review is waiting",
        summary: "Open the conflicts queue to review it.",
        details: { checkId: check.id, dueAt: dueAt.toISOString() },
        matterId: check.matterId,
        taskId: task.id,
        recipients: { userIds: [reviewer.userId] },
        dedupeKey: `conflict-check.review:${check.id}`,
        sourceCard: "c59",
        engine: ENGINE,
      },
      { now: opts.now }
    );
  }
  if (reviewer.fallback === "admin" || reviewer.fallback === "unassigned") {
    // c59 §4.7: no conflicts attorney designated. The gate stays closed.
    await raiseFlag(
      tx,
      {
        tenantId: check.tenantId,
        type: "conflict-check.no_conflicts_attorney",
        severity: "high",
        audience: "internal",
        title: "No conflicts attorney is designated",
        summary: "Conflict reviews are going to the firm admin until a conflicts attorney is designated.",
        recipients: { userIds: admins },
        dedupeKey: "conflict-check.no_conflicts_attorney",
        sourceCard: "c59",
        engine: ENGINE,
      },
      { now: opts.now }
    );
  }

  const [updated] = await tx
    .update(conflictChecks)
    .set({ decisionTaskId: task.id, assignedUserId: reviewer.userId, dueAt })
    .where(eq(conflictChecks.id, check.id))
    .returning();
  return updated!;
}

// ---------------------------------------------------------------------------
// Gate (c59 §4.5)
// ---------------------------------------------------------------------------

function subjectCondition(subject: GateSubject) {
  return subject.type === "intake_session"
    ? eq(conflictChecks.intakeSessionId, subject.id)
    : or(eq(conflictChecks.matterId, subject.id), sql`${subject.id} = any(${conflictChecks.affectedMatterIds})`);
}

/** The latest non-superseded decision per check. */
export async function latestDecisions(tx: TenantTx, tenantId: string, checkIds: string[]): Promise<Map<string, ConflictDecisionRow>> {
  if (checkIds.length === 0) return new Map();
  const rows = await tx
    .select()
    .from(conflictDecisions)
    .where(and(eq(conflictDecisions.tenantId, tenantId), inArray(conflictDecisions.checkId, checkIds)))
    .orderBy(desc(conflictDecisions.decidedAt));
  const superseded = new Set(rows.map((r) => r.supersedesDecisionId).filter((x): x is string => !!x));
  const out = new Map<string, ConflictDecisionRow>();
  for (const r of rows) if (!superseded.has(r.id) && !out.has(r.checkId)) out.set(r.checkId, r);
  return out;
}

/** Gate contribution of each check (decision + waivers + screens). */
export async function evaluateChecks(tx: TenantTx, tenantId: string, checks: readonly ConflictCheckRow[]): Promise<GateResult[]> {
  const ids = checks.map((c) => c.id);
  const [decisions, waivers, screens] = await Promise.all([
    latestDecisions(tx, tenantId, ids),
    ids.length ? tx.select().from(conflictWaivers).where(and(eq(conflictWaivers.tenantId, tenantId), inArray(conflictWaivers.checkId, ids))) : [],
    ids.length ? tx.select().from(conflictScreens).where(and(eq(conflictScreens.tenantId, tenantId), inArray(conflictScreens.checkId, ids))) : [],
  ]);
  return checks.map((c) => {
    const d = decisions.get(c.id) ?? null;
    return computeCheckGate({
      outcome: c.outcome as "clear" | "possible" | "definite",
      status: c.status,
      trigger: c.trigger,
      decision: d ? { decision: d.decision as Decision } : null,
      waivers: waivers.filter((w) => d && w.decisionId === d.id),
      screens: screens.filter((s) => d && s.decisionId === d.id),
    });
  });
}

/** Recompute and store a subject's gate from all its checks. Logs every change. */
export async function refreshGate(tx: TenantTx, tenantId: string, subject: GateSubject, now = new Date()): Promise<GateResult> {
  const checks = await tx
    .select()
    .from(conflictChecks)
    .where(and(eq(conflictChecks.tenantId, tenantId), subjectCondition(subject)));
  const results = await evaluateChecks(tx, tenantId, checks);
  const gate = combineGates(results);
  const latestCheckId = checks.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]?.id ?? null;

  const [previous] = await tx
    .select()
    .from(conflictGates)
    .where(and(eq(conflictGates.tenantId, tenantId), eq(conflictGates.subjectType, subject.type), eq(conflictGates.subjectId, subject.id)))
    .limit(1);
  await tx
    .insert(conflictGates)
    .values({ tenantId, subjectType: subject.type, subjectId: subject.id, state: gate.state, closedReason: gate.closedReason, checkId: latestCheckId, updatedAt: now })
    .onConflictDoUpdate({
      target: [conflictGates.tenantId, conflictGates.subjectType, conflictGates.subjectId],
      set: { state: gate.state, closedReason: gate.closedReason, checkId: latestCheckId, updatedAt: now },
    });
  if (!previous || previous.state !== gate.state || previous.closedReason !== gate.closedReason) {
    await audit(tx, {
      tenantId,
      engine: ENGINE,
      action: "gate.changed",
      entityType: "conflict_gate",
      entityId: subject.id,
      matterId: subject.type === "matter" ? subject.id : null,
      intakeSessionId: subject.type === "intake_session" ? subject.id : null,
      payload: { from: previous?.state ?? null, to: gate.state, closedReason: gate.closedReason },
    });
  }
  return gate;
}

/** The stored gate; a subject with no gate row is CLOSED (no check has run). */
export async function getGate(tx: TenantTx, tenantId: string, subject: GateSubject): Promise<GateResult> {
  const [row] = await tx
    .select()
    .from(conflictGates)
    .where(and(eq(conflictGates.tenantId, tenantId), eq(conflictGates.subjectType, subject.type), eq(conflictGates.subjectId, subject.id)))
    .limit(1);
  if (!row) return { state: "closed", closedReason: "no_check" };
  return { state: row.state as GateResult["state"], closedReason: (row.closedReason ?? null) as GateResult["closedReason"] };
}

/**
 * Server-side gate check for downstream actions (engagement agreement,
 * assignment, scheduling, trust deposit, payment, matter opening). Returns a
 * result rather than throwing so the refusal is committed to the audit trail
 * (c59 acceptance 2). Callers MUST NOT proceed when `allowed` is false.
 */
export async function checkConflictGate(
  tx: TenantTx,
  input: { tenantId: string; subject: GateSubject; action: GatedAction; actor?: Actor }
): Promise<{ allowed: boolean; state: GateResult["state"]; closedReason: GateResult["closedReason"] }> {
  const gate = await getGate(tx, input.tenantId, input.subject);
  if (gate.state !== "open") {
    await audit(tx, {
      tenantId: input.tenantId,
      engine: ENGINE,
      action: "gate.action_refused",
      entityType: "conflict_gate",
      entityId: input.subject.id,
      matterId: input.subject.type === "matter" ? input.subject.id : null,
      intakeSessionId: input.subject.type === "intake_session" ? input.subject.id : null,
      actor: input.actor ?? SYSTEM_ACTOR,
      payload: { attemptedAction: input.action, closedReason: gate.closedReason },
    });
  }
  return { allowed: gate.state === "open", ...gate };
}

/**
 * What a prospective client may be told (c59 §4.1.4, business rule 6):
 * never a name, never the other matter, never an overdue status; wording
 * only from the attorney-reviewed gate.
 */
export async function clientConflictStatus(
  tx: TenantTx,
  tenantId: string,
  subject: GateSubject
): Promise<{ status: "ready" | "pending_review" | "not_proceeding"; message: string | null }> {
  const gate = await getGate(tx, tenantId, subject);
  if (gate.state === "open") return { status: "ready", message: null };
  if (gate.closedReason === "declined") return { status: "not_proceeding", message: null };
  const [firm] = await tx.select({ name: firms.name }).from(firms).where(eq(firms.id, tenantId)).limit(1);
  return {
    status: "pending_review",
    message: legalCopy(CONFLICT_COPY_GATES.pendingReview.key, { firmName: firm?.name ?? "the firm" }),
  };
}

export async function getCheck(tx: TenantTx, tenantId: string, checkId: string): Promise<ConflictCheckRow | undefined> {
  const [row] = await tx
    .select()
    .from(conflictChecks)
    .where(and(eq(conflictChecks.tenantId, tenantId), eq(conflictChecks.id, checkId)))
    .limit(1);
  return row;
}
