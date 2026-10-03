// Approval gates owned by the All-engines engine (c99, c102, c103).
//
// Nothing here is approved. Until a reviewer's sign-off is recorded
// (`npm run compliance -- approve …`):
//  - every client-facing sentence of a practice-area pack renders as a visible
//    "[PENDING ATTORNEY REVIEW …]" placeholder via legalCopy();
//  - every Texas family-law rule reference blocks (requireApproval throws
//    PendingApprovalError) in whichever engine tries to apply it.
// Drafts are proposals for the reviewer, not approved wording and not legal
// advice. Shared gates (rules.court_deadlines, rules.limitation_periods,
// rules.fee_agreement_terms, rules.trust_accounting) are reused, not redefined.

import { defineGate, type Gate } from "@/compliance/approvals";
import { RULE_GATES } from "@/compliance/gates";
import { listPacks } from "./packs/registry";
import { uniqueCopyItems } from "./packs/copy";
import { FAMILY_RULE_KEYS } from "./packs/family";

export { RULE_GATES };

const ATTORNEY = ["attorney"] as const;

/** Texas family-law rule gates (c103). Values never live in code; these gate their use. */
export const FAMILY_RULE_GATES = {
  packContent: defineGate({
    key: FAMILY_RULE_KEYS.packContent,
    cardIds: ["c103"],
    reviewers: [...ATTORNEY],
    description: "Family Law pack as a whole (matter types, questions, party roles, checklists, stages, task lists) reviewed by a Texas family-law attorney",
  }),
  starterTemplates: defineGate({
    key: FAMILY_RULE_KEYS.starterTemplates,
    cardIds: ["c103", "c85", "c39"],
    reviewers: [...ATTORNEY],
    description: "Family Law starter templates (petitions, parenting plan, inventory, disclosures, final orders): content and licensing",
  }),
  divorceWaitingPeriod: defineGate({
    key: FAMILY_RULE_KEYS.divorceWaitingPeriod,
    cardIds: ["c103", "c92"],
    reviewers: [...ATTORNEY],
    description: "Texas waiting period before a divorce can be granted, and its exceptions (lawyer tool only)",
  }),
  residencyVenue: defineGate({
    key: FAMILY_RULE_KEYS.residencyVenue,
    cardIds: ["c103", "c73"],
    reviewers: [...ATTORNEY],
    description: "Texas residency and venue requirements for family cases (lawyer tool only; never an automatic decline)",
  }),
  childSupportGuidelines: defineGate({
    key: FAMILY_RULE_KEYS.childSupportGuidelines,
    cardIds: ["c103"],
    reviewers: [...ATTORNEY],
    description: "Texas child-support guideline calculation: percentages, income definitions, caps (lawyer worksheet only)",
  }),
  possessionSchedule: defineGate({
    key: FAMILY_RULE_KEYS.possessionSchedule,
    cardIds: ["c103", "c91"],
    reviewers: [...ATTORNEY],
    description: "Texas standard parenting-time (possession) schedule rules used to draft a calendar for the lawyer",
  }),
  protectiveOrderTiming: defineGate({
    key: FAMILY_RULE_KEYS.protectiveOrderTiming,
    cardIds: ["c103", "c66", "c92"],
    reviewers: [...ATTORNEY],
    description: "Protective-order hearing timing and temporary-order duration (real clock; lawyer tool only)",
  }),
  modificationEligibility: defineGate({
    key: FAMILY_RULE_KEYS.modificationEligibility,
    cardIds: ["c103"],
    reviewers: [...ATTORNEY],
    description: "When and on what grounds a custody/support order may be modified (prompts for the lawyer; the product never decides)",
  }),
  statutoryForms: defineGate({
    key: FAMILY_RULE_KEYS.statutoryForms,
    cardIds: ["c103", "c85"],
    reviewers: [...ATTORNEY],
    description: "Statutory warnings, notices and forms required in Texas family filings",
  }),
} as const;

/** One attorney copy gate per client-facing sentence in every registered pack. */
function definePackCopyGates(): Gate[] {
  const out: Gate[] = [];
  for (const pack of listPacks()) {
    for (const item of uniqueCopyItems(pack)) {
      out.push(
        defineGate({
          key: item.copyKey,
          cardIds: [pack.cardId, "c102"],
          reviewers: [...ATTORNEY],
          description: `${pack.label} pack: ${item.where} (client-facing)`,
          draft: item.draft,
        })
      );
    }
  }
  return out;
}

export const PACK_COPY_GATES: readonly Gate[] = definePackCopyGates();

export const ALL_ENGINES_GATE_KEYS: readonly string[] = [
  ...Object.values(FAMILY_RULE_GATES).map((g) => g.key),
  ...PACK_COPY_GATES.map((g) => g.key),
];

/** Shared gates this engine's packs depend on (shown on the admin pages). */
export const ALL_ENGINES_SHARED_GATE_KEYS: readonly string[] = [
  RULE_GATES.courtDeadlines.key,
  RULE_GATES.limitationPeriods.key,
  RULE_GATES.feeAgreementTerms.key,
  RULE_GATES.trustAccounting.key,
];
