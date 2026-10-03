// Approval gates owned by the Billing & trust engine (c76 so far).
//
// Nothing here is approved. Trust-ledger rule VALUES live in the drafts below
// so that an attorney's and a CPA's sign-off is bound to the exact values they
// reviewed (changing a draft re-closes the gate). Drafts are proposals taken
// from the c75 research memo (docs/compliance/trust-accounting-iolta-compliance-review.md),
// not settled law.
//
// Shared gates reused (never redefined here):
//   rules.trust_accounting  (RULE_GATES.trustAccounting) — EVERY movement of trust money
//                           (post, reverse) and every month close; attorney + CPA.
//   rules.retention_periods (RULE_GATES.retentionPeriods) — any future purge of trust records
//                           (none is implemented: the ledger is append-only).
//   vendor.email            (via src/core/notify.ts) — flag emails to firm users.

import { defineGate } from "@/compliance/approvals";
import { RULE_GATES, VENDOR_GATES } from "@/compliance/gates";

export { RULE_GATES, VENDOR_GATES };

/** Proposed rule values. Parsed by src/engines/billing-trust/rules.ts. */
export const TRUST_RULE_VALUES_DRAFT = JSON.stringify(
  {
    // c75 §5 / §11.9: Tex. R. Disciplinary P. 17.10 — five years after the representation ends; firms may keep longer, never shorter.
    retentionYearsAfterRepresentationEnds: 5,
    // c75 §4 / §11.3: the State Bar's guide recommends monthly three-way reconciliation.
    reconciliationCadence: "monthly",
    // c75 §4: any difference blocks the month; no tolerance for "small" variances.
    reconciliationToleranceCents: 0,
  },
  null,
  2
);

export const TRUST_RULE_GATES = {
  ruleValues: defineGate({
    key: "rules.billing-trust.rule_values",
    cardIds: ["c76", "c75"],
    reviewers: ["attorney", "cpa"],
    description:
      "Trust-ledger rule values: record retention after the representation ends, reconciliation cadence, and zero tolerance for reconciliation differences",
    draft: TRUST_RULE_VALUES_DRAFT,
  }),
  bankFeeCushion: defineGate({
    key: "rules.billing-trust.bank_fee_cushion",
    cardIds: ["c76", "c75"],
    reviewers: ["attorney", "cpa"],
    description:
      "Allow a firm-funded cushion in the trust account, limited to an amount reasonably sufficient to cover unavoidable bank fees (c75 §8); every other firm deposit to trust is refused as commingling",
  }),
  bankFeed: defineGate({
    key: "vendor.billing-trust.bank_feed",
    cardIds: ["c76"],
    reviewers: ["vendor_dpa", "cpa"],
    description: "Bank-feed / statement-import vendor for trust-account statements (subprocessor DPA; CPA confirms the data is statement-grade)",
  }),
} as const;

export const TRUST_GATE_KEYS = Object.values(TRUST_RULE_GATES).map((g) => g.key);

/** Every gate this engine depends on (its own + shared), for the admin approvals table. */
export const TRUST_DEPENDENCY_GATE_KEYS = [
  RULE_GATES.trustAccounting.key,
  ...TRUST_GATE_KEYS,
  RULE_GATES.retentionPeriods.key,
  VENDOR_GATES.email.key,
];
