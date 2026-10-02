// The conflict rule table (c55's output, consumed by c3/c59). Pure.
//
// LEGAL-RULE LOGIC — GATED. The rows below are a DRAFT for the reviewing
// Texas attorney (Rules 1.06, 1.09, 1.10, 1.18), not settled law. The engine
// applies them only when the shared gate `rules.conflicts` is approved
// (see checks.ts / decisionService.ts). While it is pending:
//   - no result is ever upgraded to 'definite' by the table (every hit stays 'possible');
//   - no decision option is disabled or enabled on the table's say-so;
//   - the attorney's review screen shows the gate placeholder instead of rule references.
// Either way a human conflicts attorney decides every hit.

import type { ConflictHit } from "./types";

export type Situation =
  | "adverse_current_client"
  | "adverse_former_client"
  | "adverse_prospective_client"
  | "lateral_prior_matter"
  | "lawyer_personal_interest"
  | "related_party_only"
  | "same_side";

export type Waivability = "waivable_with_consent" | "screen_may_cure" | "not_waivable" | "attorney_judgment";

export interface RuleTableRow {
  id: string;
  situation: Situation;
  ruleRef: string;
  waivability: Waivability;
  /** When true, a hit in this situation makes the check 'definite' rather than 'possible'. */
  definite: boolean;
  summary: string;
}

/** DRAFT — pending attorney review under `rules.conflicts`. */
export const DRAFT_RULE_TABLE: readonly RuleTableRow[] = Object.freeze([
  {
    id: "tx-1.06-current-adverse",
    situation: "adverse_current_client",
    ruleRef: "Tex. Disciplinary R. Prof'l Conduct 1.06",
    waivability: "attorney_judgment",
    definite: true,
    summary: "New matter is adverse to a current client.",
  },
  {
    id: "tx-1.09-former-adverse",
    situation: "adverse_former_client",
    ruleRef: "Tex. Disciplinary R. Prof'l Conduct 1.09",
    waivability: "waivable_with_consent",
    definite: false,
    summary: "New matter is adverse to a former client; depends on whether it is the same or substantially related.",
  },
  {
    id: "tx-1.18-prospective",
    situation: "adverse_prospective_client",
    ruleRef: "Tex. Disciplinary R. Prof'l Conduct 1.18",
    waivability: "screen_may_cure",
    definite: false,
    summary: "A prior prospective client (declined or did not hire) is on the other side.",
  },
  {
    id: "tx-1.10-lateral",
    situation: "lateral_prior_matter",
    ruleRef: "Tex. Disciplinary R. Prof'l Conduct 1.09 / 1.10",
    waivability: "screen_may_cure",
    definite: false,
    summary: "A lawyer or staff member worked on a related matter at a former firm.",
  },
  {
    id: "tx-1.06b2-interest",
    situation: "lawyer_personal_interest",
    ruleRef: "Tex. Disciplinary R. Prof'l Conduct 1.06(b)(2), 1.08",
    waivability: "waivable_with_consent",
    definite: false,
    summary: "A lawyer's own business, family or financial interest is involved.",
  },
  {
    id: "related-party",
    situation: "related_party_only",
    ruleRef: "Attorney review",
    waivability: "attorney_judgment",
    definite: false,
    summary: "The name matched a related party (spouse, family member, business) of another matter.",
  },
  {
    id: "same-side",
    situation: "same_side",
    ruleRef: "Attorney review",
    waivability: "attorney_judgment",
    definite: false,
    summary: "The name matched someone on the same side (e.g. an existing client seeking new help).",
  },
]);

const CLIENT_ROLES = new Set(["client", "caller", "former_client", "co_party"]);
const ADVERSE_ROLES = new Set(["opposing_party", "opposing_counsel", "co_defendant", "insurer"]);

function isAdverseRole(role: string): boolean {
  return ADVERSE_ROLES.has(role);
}

/** Classify one hit into a rule-table situation. Pure. */
export function situationForHit(hit: ConflictHit): Situation {
  if (hit.sourceType === "lateral_list") return "lateral_prior_matter";
  if (hit.sourceType === "interest") return "lawyer_personal_interest";
  // Names from a new hire's prior-matter list (c61) matched against our index.
  if (hit.searchedRole.startsWith("lateral_")) return "lateral_prior_matter";
  // A lawyer's new disclosure (c97) matched against our index.
  if (hit.searchedRole === "lawyer_interest") return "lawyer_personal_interest";
  const searchedAdverse = isAdverseRole(hit.searchedRole);
  let best: Situation = "related_party_only";
  const rank: Record<Situation, number> = {
    adverse_current_client: 6,
    adverse_former_client: 5,
    adverse_prospective_client: 4,
    lateral_prior_matter: 3,
    lawyer_personal_interest: 3,
    same_side: 2,
    related_party_only: 1,
  };
  for (const inv of hit.involvements) {
    let s: Situation = "related_party_only";
    const hitIsClient = CLIENT_ROLES.has(inv.role) && inv.kind === "matter";
    const hitIsProspect = inv.kind === "inquiry" && inv.role === "prospective_client";
    const hitAdverse = isAdverseRole(inv.role) || inv.isAdverse === true;
    if (searchedAdverse && hitIsClient) {
      // The other side of the new matter is (or was) our client.
      s = inv.status === "current" ? "adverse_current_client" : "adverse_former_client";
    } else if (searchedAdverse && hitIsProspect) {
      s = "adverse_prospective_client";
    } else if (!searchedAdverse && hitAdverse) {
      // The new client was on the other side of one of our matters.
      s = inv.kind === "matter" && inv.status === "current" ? "adverse_current_client" : "adverse_former_client";
    } else if (!searchedAdverse && (hitIsClient || hitIsProspect)) {
      s = "same_side";
    }
    if (rank[s] > rank[best]) best = s;
  }
  return best;
}

export interface RuleAssessment {
  applied: boolean;
  rows: RuleTableRow[];
  /** True when any hit's situation is 'definite' under the table. */
  definite: boolean;
  /** 'not_waivable' disables "proceed with consent" (hard block unless the override gate is approved). */
  consent: "allowed" | "not_waivable" | "unknown";
}

export const UNAPPLIED_ASSESSMENT: RuleAssessment = Object.freeze({
  applied: false,
  rows: [],
  definite: false,
  consent: "unknown",
}) as RuleAssessment;

/**
 * Apply a rule table to a check's hits. Call ONLY after
 * requireApproval(RULE_GATES.conflictRules.key) succeeded; otherwise use
 * UNAPPLIED_ASSESSMENT. Pure.
 */
export function applyRuleTable(hits: readonly ConflictHit[], table: readonly RuleTableRow[]): RuleAssessment {
  const rows: RuleTableRow[] = [];
  for (const hit of hits) {
    const situation = situationForHit(hit);
    const row = table.find((r) => r.situation === situation);
    if (row && !rows.some((r) => r.id === row.id)) rows.push(row);
  }
  const consent = rows.some((r) => r.waivability === "not_waivable")
    ? "not_waivable"
    : rows.length > 0
      ? "allowed"
      : "unknown";
  return { applied: true, rows, definite: rows.some((r) => r.definite), consent };
}
