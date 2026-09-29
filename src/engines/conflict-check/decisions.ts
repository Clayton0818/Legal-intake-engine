// Pure business rules for c3/c59: check outcome, decision validation, the
// conflict gate, and waiver timers. No database imports.
//
// Founder rule: the AI and the system NEVER clear a conflict. Nothing in this
// file produces a 'cleared' decision; it only validates one a human entered.

import type { ConflictHit, ConflictOutcome, Decision, GateClosedReason, GateState, SearchedName, CheckTrigger } from "./types";
import type { RuleAssessment } from "./ruleTable";
import type { RoleEvaluation } from "./coreCheck";

// ---------------------------------------------------------------------------
// Outcome (c3 / c56 rules 7 and 9)
// ---------------------------------------------------------------------------

export type OutcomeReason = "hits" | "name_unknown" | "history_not_loaded" | "index_write_failed";

export interface OutcomeInput {
  hits: readonly ConflictHit[];
  searched: readonly SearchedName[];
  trigger: CheckTrigger;
  /** False until the firm confirms its history import (c96); no clear result without an attorney then. */
  historyImportConfirmed: boolean;
  indexWriteFailed?: boolean;
  /** Only an APPLIED rule table (rules.conflicts approved) can make a result 'definite'. */
  assessment: RuleAssessment;
  /** c3 role-matrix evaluation; only an APPLIED one (rules.conflicts approved) can make a result 'definite'. */
  roleEvaluation?: RoleEvaluation | null;
}

export function classifyOutcome(input: OutcomeInput): { outcome: ConflictOutcome; reasons: OutcomeReason[] } {
  const reasons: OutcomeReason[] = [];
  if (input.hits.length > 0) reasons.push("hits");
  if (input.searched.some((s) => s.nameUnknown)) reasons.push("name_unknown");
  if (!input.historyImportConfirmed) reasons.push("history_not_loaded");
  if (input.indexWriteFailed) reasons.push("index_write_failed");
  if (reasons.length === 0) return { outcome: "clear", reasons };
  const byTable = input.assessment.applied && input.assessment.definite;
  const byRole = !!input.roleEvaluation?.applied && input.roleEvaluation.barred;
  const definite = input.hits.length > 0 && (byTable || byRole);
  return { outcome: definite ? "definite" : "possible", reasons };
}

/** Users whose OWN interests a check's hits concern (c97): either direction of the match. Pure. */
export function interestOwners(hits: readonly ConflictHit[]): string[] {
  const ids = hits
    .filter((h) => (h.sourceType === "interest" || h.searchedRole === "lawyer_interest") && h.ownerUserId)
    .map((h) => h.ownerUserId!);
  return [...new Set(ids)];
}

// ---------------------------------------------------------------------------
// Decisions (c59 §4.3, business rules 1–4)
// ---------------------------------------------------------------------------

export const REASON_CODES: Readonly<Record<Decision, readonly string[]>> = Object.freeze({
  cleared: ["false_positive_different_person", "not_adverse", "unrelated_matter", "history_acknowledged", "other"],
  proceed_with_consent: ["consent_permitted", "other"],
  proceed_with_screen: ["prospective_client_contact", "lateral_hire", "lawyer_interest", "other"],
  declined: ["conflict_not_waivable", "consent_refused", "firm_choice", "other"],
});

export const MIN_EXPLANATION_CHARS = 20;

export interface DecisionInput {
  decision: Decision;
  reasonCode: string;
  reasonText?: string | null;
  consentPartyIds?: readonly string[];
  screenedUserIds?: readonly string[];
  /** "The rule table does not fit these facts" (c59 §4.3.5). */
  overrideRuleTable?: boolean;
  supersedesDecisionId?: string | null;
}

export interface DecisionContext {
  check: { outcome: ConflictOutcome; status: string; hits: readonly ConflictHit[] };
  decider: { userId: string; canDecide: boolean };
  assessment: RuleAssessment;
  /** `rules.conflict-check.rule_table_override` approved? Otherwise a not-waivable result is a hard block. */
  overrideGateApproved: boolean;
  /** Another conflicts attorney exists who could decide instead (for own-interest hits, c59 §4.7). */
  otherDecidersAvailable: boolean;
  /** The decision being superseded belongs to this check. */
  supersedesValid?: boolean;
}

export type DecisionValidation = { ok: true; overrideFlag: boolean } | { ok: false; errors: string[] };

export function validateDecision(input: DecisionInput, ctx: DecisionContext): DecisionValidation {
  const errors: string[] = [];
  let overrideFlag = false;
  const text = input.reasonText?.trim() ?? "";

  if (!ctx.decider.canDecide) errors.push("Only a user holding the conflicts-attorney role can record a decision.");

  if (input.supersedesDecisionId) {
    if (!ctx.supersedesValid) errors.push("The decision being corrected does not belong to this check.");
  } else if (ctx.check.status !== "open") {
    errors.push("This check already has a decision. Record a correcting decision that supersedes it instead of editing it.");
  }
  if (ctx.check.outcome === "clear") errors.push("A clear check needs no decision.");

  const codes = REASON_CODES[input.decision];
  if (!codes) errors.push(`Unknown decision '${input.decision}'.`);
  else if (!codes.includes(input.reasonCode)) errors.push(`Reason '${input.reasonCode}' is not valid for '${input.decision}'.`);
  if (input.reasonCode === "other" && text.length === 0) errors.push("Explain the reason when choosing 'other'.");

  // An attorney who is the subject of an own-interest hit may not decide it when someone else can (c59 §4.7, c97 §4.4).
  const ownInterest = interestOwners(ctx.check.hits).includes(ctx.decider.userId);
  if (ownInterest && ctx.otherDecidersAvailable) {
    errors.push("This hit concerns your own interests; the backup conflicts attorney must decide it.");
  }

  // A 'definite' result can only be declined, or cleared with a written explanation (flagged to the owner).
  if (ctx.check.outcome === "definite") {
    if (input.decision !== "declined" && input.decision !== "cleared") {
      errors.push("A definite conflict can only be declined, or cleared with a written explanation.");
    }
    if (input.decision === "cleared") {
      if (text.length < MIN_EXPLANATION_CHARS) errors.push(`Clearing a definite result needs a written explanation (${MIN_EXPLANATION_CHARS}+ characters).`);
      overrideFlag = true;
    }
  }

  if (input.decision === "proceed_with_consent") {
    if (!input.consentPartyIds || input.consentPartyIds.length === 0) {
      errors.push("Choose every client who must consent in writing.");
    }
    if (ctx.assessment.applied && ctx.assessment.consent === "not_waivable") {
      const refs = ctx.assessment.rows.filter((r) => r.waivability === "not_waivable").map((r) => r.ruleRef);
      if (!input.overrideRuleTable) {
        errors.push(`Consent is not available: the rule table marks this as not waivable (${refs.join("; ")}).`);
      } else if (!ctx.overrideGateApproved) {
        errors.push("Overriding the rule table is not allowed until the override policy is approved (hard block).");
      } else {
        if (text.length < MIN_EXPLANATION_CHARS) errors.push(`Explain why the rule table does not fit these facts (${MIN_EXPLANATION_CHARS}+ characters).`);
        overrideFlag = true;
      }
    }
  } else if (input.consentPartyIds && input.consentPartyIds.length > 0) {
    errors.push("Only 'proceed with written consent' collects consents.");
  }

  if (input.decision === "proceed_with_screen" && (!input.screenedUserIds || input.screenedUserIds.length === 0)) {
    errors.push("Choose who is screened.");
  }
  if ((input.decision === "cleared" || input.decision === "declined") && (input.screenedUserIds?.length ?? 0) > 0) {
    errors.push("Screens can only be requested with 'proceed with a screen' or 'proceed with written consent'.");
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, overrideFlag };
}

// ---------------------------------------------------------------------------
// The conflict gate (c59 §4.5)
// ---------------------------------------------------------------------------

export interface CheckGateInput {
  outcome: ConflictOutcome;
  status: string;
  /** Lateral-hire and lawyer-interest checks concern a PERSON, not the matter's client. */
  trigger?: string;
  /** The latest non-superseded decision on the check, if any. */
  decision: { decision: Decision } | null;
  waivers: ReadonlyArray<{ status: string; countersignRequired: boolean; countersignedAt: Date | null }>;
  screens: ReadonlyArray<{ status: string }>;
}

export interface GateResult {
  state: GateState;
  closedReason: GateClosedReason | null;
}

const OPEN: GateResult = Object.freeze({ state: "open", closedReason: null }) as GateResult;
const closed = (closedReason: GateClosedReason): GateResult => ({ state: "closed", closedReason });

const PERSON_TRIGGERS = new Set(["lateral_hire", "interest"]);

/** Gate contribution of one check. Pure. */
export function computeCheckGate(input: CheckGateInput): GateResult {
  if (input.status === "superseded") return OPEN; // replaced by a newer check, which is evaluated instead
  if (input.outcome === "clear") return OPEN;
  if (!input.decision) return closed("pending_review");
  switch (input.decision.decision) {
    case "declined":
      // For a new hire or a lawyer's own interest, "declined" means that person may not work on
      // the affected matters (an exclusion screen is recorded); the client's matter itself goes on.
      return PERSON_TRIGGERS.has(input.trigger ?? "") ? OPEN : closed("declined");
    case "cleared":
      return OPEN;
    case "proceed_with_consent": {
      const live = input.waivers.filter((w) => w.status !== "cancelled");
      const allSigned =
        live.length > 0 &&
        live.every((w) => w.status === "signed" && (!w.countersignRequired || w.countersignedAt !== null));
      if (!allSigned) return closed("awaiting_consent");
      return screensActive(input.screens) ? OPEN : closed("awaiting_screen");
    }
    case "proceed_with_screen":
      return input.screens.length > 0 && screensActive(input.screens) ? OPEN : closed("awaiting_screen");
  }
}

function screensActive(screens: CheckGateInput["screens"]): boolean {
  return screens.filter((s) => s.status !== "lifted").every((s) => s.status === "active");
}

/** A subject's gate is open only when EVERY one of its checks is (and at least one check ran). Pure. */
export function combineGates(results: readonly GateResult[]): GateResult {
  if (results.length === 0) return closed("no_check");
  const priority: GateClosedReason[] = ["declined", "pending_review", "awaiting_consent", "awaiting_screen", "no_check"];
  for (const reason of priority) {
    if (results.some((r) => r.state === "closed" && r.closedReason === reason)) return closed(reason);
  }
  return OPEN;
}

/** Downstream actions the gate blocks (c59 §4.5). */
export const GATED_ACTIONS = [
  "engagement_agreement",
  "assignment",
  "scheduling",
  "trust_deposit",
  "payment",
  "matter_opening",
] as const;
export type GatedAction = (typeof GATED_ACTIONS)[number];

// ---------------------------------------------------------------------------
// Waiver timers (c59 §4.4 steps 4–6)
// ---------------------------------------------------------------------------

export type WaiverTimerAction = "none" | "remind" | "outer_limit";

export function waiverTimerAction(
  w: { status: string; sentAt: Date | null; lastReminderAt: Date | null; outerLimitAt: Date | null },
  now: Date,
  nextReminderAt: (from: Date) => Date
): WaiverTimerAction {
  if (w.status !== "sent" || !w.sentAt) return "none";
  if (w.outerLimitAt && now.getTime() >= w.outerLimitAt.getTime()) return "outer_limit";
  const from = w.lastReminderAt ?? w.sentAt;
  return now.getTime() >= nextReminderAt(from).getTime() ? "remind" : "none";
}

/**
 * Matters a screen or exclusion for a person should cover: the check's own
 * matter(s), else every open or prospective matter the hits involve (a
 * lateral hire's or a lawyer's hits have no matter of their own). Pure.
 */
export function matterIdsForPersonScreens(check: {
  matterId: string | null;
  affectedMatterIds: readonly string[];
  hits: readonly ConflictHit[];
}): string[] {
  const ids = new Set<string>();
  if (check.matterId) ids.add(check.matterId);
  for (const id of check.affectedMatterIds) ids.add(id);
  if (ids.size === 0) {
    for (const h of check.hits) {
      for (const i of h.involvements) if (i.kind === "matter" && i.status !== "former") ids.add(i.id);
    }
  }
  return [...ids];
}
