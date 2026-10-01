// c73 — each firm sets its own rules for which cases it takes (pure).
//
// Rules evaluate the confirmed classification and captured answers and
// return pass / fail / unknown. Outcome:
//   fit        every evaluated rule passes;
//   no_fit     a fail on a rule the firm allows to auto-decline, with high
//              classifier confidence, no unknown on that rule, no emergency,
//              no pending conflict, auto-decline switched on for the firm AND
//              the attorney/founder review of auto-decline approved;
//   borderline anything else — always a lawyer, never an automatic decline.
// Fit rules NEVER evaluate conflicts and NEVER judge legal merits.

export const FIT_RULE_KINDS = ["practice_area", "county", "language", "criteria", "capacity"] as const;
export type FitRuleKind = (typeof FIT_RULE_KINDS)[number];

export const FIT_OPERATORS = ["in", "not_in", "equals", "not_equals", "exists", "gte", "lte"] as const;
export type FitOperator = (typeof FIT_OPERATORS)[number];

/** Kinds a firm may mark as auto-decline (capacity never auto-declines, c73 rule 4). */
export const AUTO_DECLINE_KINDS: readonly FitRuleKind[] = ["practice_area", "county", "language", "criteria"];

export interface FitRule {
  /** Stable id within the firm's rule history, e.g. 'pa_offered'. */
  id: string;
  kind: FitRuleKind;
  /**
   * The fact the rule reads: 'practiceArea', 'matterType', 'county', 'language'
   * or 'answers.<field>' for firm-defined minimum criteria.
   */
  field: string;
  operator: FitOperator;
  value?: string | number | boolean | Array<string | number>;
  autoDeclineAllowed: boolean;
  /** Human description shown to staff and in the audit trail. */
  description: string;
  enabled?: boolean;
}

export interface FitFacts {
  practiceArea: string | null;
  matterType: string | null;
  county: string | null;
  language: string | null;
  answers: Record<string, unknown>;
  /** Firm practice areas switched on (c102). A switched-off area is a practice-area fail. */
  enabledPracticeAreas: readonly string[];
  /** null = not evaluated (no matter yet); false = every eligible lawyer is over capacity. */
  capacityAvailable: boolean | null;
}

export type RuleResultStatus = "pass" | "fail" | "unknown" | "skipped";

export interface RuleResult {
  ruleId: string;
  kind: FitRuleKind;
  status: RuleResultStatus;
  autoDeclineAllowed: boolean;
  description: string;
  field: string;
}

export type FitOutcome = "fit" | "borderline" | "no_fit";

export interface FitDecision {
  outcome: FitOutcome;
  reasons: string[];
  results: RuleResult[];
  /** The rule(s) that produced a no_fit (for the audit trail). */
  decliningRuleIds: string[];
}

const lower = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase() : v);

/** Read a fact by field name. Undefined / null / empty string = unknown. Pure. */
export function readFact(facts: FitFacts, field: string): unknown {
  let v: unknown;
  if (field.startsWith("answers.")) v = facts.answers[field.slice("answers.".length)];
  else if (field === "practiceArea") v = facts.practiceArea;
  else if (field === "matterType") v = facts.matterType;
  else if (field === "county") v = facts.county;
  else if (field === "language") v = facts.language;
  else if (field === "capacity") v = facts.capacityAvailable;
  else v = undefined;
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string" && v.trim() === "") return undefined;
  return v;
}

/** Evaluate one rule against the facts. Pure. */
export function evaluateRule(rule: FitRule, facts: FitFacts): RuleResultStatus {
  if (rule.enabled === false) return "skipped";
  if (rule.kind === "capacity") {
    if (facts.capacityAvailable === null) return "skipped";
    return facts.capacityAvailable ? "pass" : "fail";
  }
  // c102: a practice area switched off for the firm is a practice-area fail.
  if (rule.kind === "practice_area" && rule.field === "practiceArea" && facts.practiceArea) {
    const enabled = facts.enabledPracticeAreas.map((a) => String(lower(a)));
    if (!enabled.includes(String(lower(facts.practiceArea)))) return "fail";
  }
  const fact = readFact(facts, rule.field);
  if (rule.operator === "exists") return fact === undefined ? "fail" : "pass";
  if (fact === undefined) return "unknown";
  const list = Array.isArray(rule.value) ? rule.value.map(lower) : [lower(rule.value)];
  switch (rule.operator) {
    case "in":
      return list.includes(lower(fact)) ? "pass" : "fail";
    case "not_in":
      return list.includes(lower(fact)) ? "fail" : "pass";
    case "equals":
      return lower(fact) === lower(rule.value) ? "pass" : "fail";
    case "not_equals":
      return lower(fact) === lower(rule.value) ? "fail" : "pass";
    case "gte":
    case "lte": {
      const n = typeof fact === "number" ? fact : Number(fact);
      const target = Number(rule.value);
      if (!Number.isFinite(n) || !Number.isFinite(target)) return "unknown";
      return (rule.operator === "gte" ? n >= target : n <= target) ? "pass" : "fail";
    }
  }
}

export interface FitGuards {
  /** Classifier confidence for the practice-area classification (0–1), null = none. */
  confidence: number | null;
  confidenceThreshold: number;
  /** Firm switch (c73 rule 5). */
  autoDeclineEnabled: boolean;
  /** Attorney + founder review of automatic declines ('rules.intake.auto_decline'). */
  autoDeclineApproved: boolean;
  /** An open safety / urgent emergency on the session (c66 runs first). */
  emergencyOpen: boolean;
  /** A possible conflict is waiting for the conflicts attorney. */
  conflictPending: boolean;
}

/** Evaluate every rule and decide the outcome. Pure. */
export function decideFit(rules: readonly FitRule[], facts: FitFacts, guards: FitGuards): FitDecision {
  const results: RuleResult[] = rules.map((r) => ({
    ruleId: r.id,
    kind: r.kind,
    status: evaluateRule(r, facts),
    autoDeclineAllowed: r.autoDeclineAllowed && AUTO_DECLINE_KINDS.includes(r.kind),
    description: r.description,
    field: r.field,
  }));
  const fails = results.filter((r) => r.status === "fail");
  const unknowns = results.filter((r) => r.status === "unknown");
  if (fails.length === 0 && unknowns.length === 0) {
    return { outcome: "fit", reasons: [], results, decliningRuleIds: [] };
  }

  const reasons: string[] = [];
  for (const f of fails) reasons.push(f.kind === "capacity" ? "capacity" : `rule_failed:${f.ruleId}`);
  for (const u of unknowns) reasons.push(`rule_unknown:${u.ruleId}`);

  const autoFails = fails.filter((f) => f.autoDeclineAllowed);
  const blockers: string[] = [];
  if (autoFails.length === 0) blockers.push("no_auto_decline_rule_failed");
  if (guards.confidence === null || guards.confidence < guards.confidenceThreshold) blockers.push("low_confidence");
  if (!guards.autoDeclineEnabled) blockers.push("auto_decline_disabled");
  if (!guards.autoDeclineApproved) blockers.push("auto_decline_pending_review");
  if (guards.emergencyOpen) blockers.push("emergency_open");
  if (guards.conflictPending) blockers.push("conflict_pending");
  // A capacity shortfall anywhere keeps the case with a lawyer (c73 rule 4).
  if (fails.some((f) => f.kind === "capacity")) blockers.push("capacity");

  if (blockers.length === 0) {
    return { outcome: "no_fit", reasons, results, decliningRuleIds: autoFails.map((f) => f.ruleId) };
  }
  return { outcome: "borderline", reasons: [...reasons, ...blockers.map((b) => `borderline:${b}`)], results, decliningRuleIds: [] };
}

const RULE_ID_RE = /^[a-z][a-z0-9_]{0,47}$/;
const FIELD_RE = /^(practiceArea|matterType|county|language|capacity|answers\.[a-zA-Z0-9_]{1,64})$/;

/** Validation errors for a rule set (empty = valid). Pure. */
export function validateFitRules(rules: readonly FitRule[]): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  if (rules.length > 100) errors.push("At most 100 rules.");
  for (const r of rules) {
    if (!RULE_ID_RE.test(r.id)) errors.push(`Rule id '${r.id}' must be lowercase letters, digits or _.`);
    if (ids.has(r.id)) errors.push(`Rule id '${r.id}' is used twice.`);
    ids.add(r.id);
    if (!(FIT_RULE_KINDS as readonly string[]).includes(r.kind)) errors.push(`Rule '${r.id}': unknown kind '${r.kind}'.`);
    if (!(FIT_OPERATORS as readonly string[]).includes(r.operator)) errors.push(`Rule '${r.id}': unknown operator '${r.operator}'.`);
    if (!FIELD_RE.test(r.field)) errors.push(`Rule '${r.id}': field '${r.field}' is not supported.`);
    if (!r.description?.trim()) errors.push(`Rule '${r.id}' needs a description.`);
    if (r.operator !== "exists" && r.kind !== "capacity" && r.value === undefined) errors.push(`Rule '${r.id}' needs a value.`);
    if (r.kind === "capacity" && r.autoDeclineAllowed) errors.push(`Rule '${r.id}': capacity can never decline automatically.`);
    if (/conflict/i.test(r.field) || /conflict/i.test(r.id)) errors.push(`Rule '${r.id}': conflicts are never a fit rule (c73 rule 1).`);
  }
  return errors;
}

/**
 * Pilot defaults (c73 rule 2): practice areas the firm offers and counties it
 * serves may auto-decline; everything else goes to a lawyer. Counties are
 * only added when the firm lists them.
 */
export function defaultFitRules(input: { enabledPracticeAreas: readonly string[]; counties?: readonly string[]; languages?: readonly string[] }): FitRule[] {
  const rules: FitRule[] = [
    {
      id: "practice_area_offered",
      kind: "practice_area",
      field: "practiceArea",
      operator: "in",
      value: [...input.enabledPracticeAreas],
      autoDeclineAllowed: true,
      description: "The firm offers this practice area.",
    },
  ];
  if (input.counties && input.counties.length > 0) {
    rules.push({
      id: "county_served",
      kind: "county",
      field: "county",
      operator: "in",
      value: [...input.counties],
      autoDeclineAllowed: true,
      description: "The firm serves this county.",
    });
  }
  if (input.languages && input.languages.length > 0) {
    rules.push({
      id: "language_supported",
      kind: "language",
      field: "language",
      operator: "in",
      value: [...input.languages],
      autoDeclineAllowed: false,
      description: "The firm can work in this language.",
    });
  }
  rules.push({
    id: "capacity",
    kind: "capacity",
    field: "capacity",
    operator: "exists",
    autoDeclineAllowed: false,
    description: "At least one eligible lawyer has capacity.",
  });
  return rules;
}

export interface ReferralEntry {
  id: string;
  name: string;
  practiceAreas: readonly string[];
  counties: readonly string[];
  contact: string;
  active: boolean;
}

/** Referral options from the firm's own list for this inquiry (empty lists match anything). Pure. */
export function matchReferrals(entries: readonly ReferralEntry[], practiceArea: string | null, county: string | null, max = 3): ReferralEntry[] {
  const l = (s: string) => s.trim().toLowerCase();
  return entries
    .filter((e) => e.active)
    .filter((e) => e.practiceAreas.length === 0 || (practiceArea !== null && e.practiceAreas.map(l).includes(l(practiceArea))))
    .filter((e) => e.counties.length === 0 || (county !== null && e.counties.map(l).includes(l(county))))
    .sort((a, b) => b.practiceAreas.length + b.counties.length - (a.practiceAreas.length + a.counties.length) || a.name.localeCompare(b.name))
    .slice(0, max);
}

/** Session terminal state for a decline (existing terminals). Pure. */
export function declineTerminalState(results: readonly RuleResult[]): "out_of_scope" | "not_eligible" {
  return results.some((r) => r.status === "fail" && r.kind === "practice_area") ? "out_of_scope" : "not_eligible";
}

/**
 * What would change if the draft rules replaced the current ones (the rule
 * editor's test panel, c73 §4 "Rule editing"). Outcomes only. Pure.
 */
export function compareRuleSets(
  samples: ReadonlyArray<{ id: string; facts: FitFacts; guards: FitGuards }>,
  current: readonly FitRule[],
  draft: readonly FitRule[]
): Array<{ id: string; before: FitOutcome; after: FitOutcome }> {
  return samples
    .map((s) => ({ id: s.id, before: decideFit(current, s.facts, s.guards).outcome, after: decideFit(draft, s.facts, s.guards).outcome }))
    .filter((r) => r.before !== r.after);
}
