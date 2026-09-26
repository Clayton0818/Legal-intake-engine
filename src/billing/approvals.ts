// Approval placeholders for the Billing & trust engine.
//
// Two different kinds of "approval" exist in this module, and they must not
// be confused:
//
// 1. COMPLIANCE GATES (this file). Sign-offs that must happen BEFORE a piece
//    of behaviour is allowed to run at all, e.g. the trust-accounting review
//    (c75) signed off by a licensed Texas attorney AND a CPA. Until a gate is
//    approved, any code path that depends on it throws PendingApprovalError.
//    Approving a gate is a reviewed code change to COMPLIANCE_GATES below
//    (a PR that records who signed off, when, and the reference document),
//    never a runtime toggle and never something the AI can flip.
//
// 2. RUNTIME LAWYER APPROVALS (the other files). A lawyer approving a time
//    entry, a draft invoice or a refund. Those are real product behaviour and
//    are implemented as state transitions that require an `attorney` actor.
//
// Every gate below starts as PENDING. That is deliberate: see CLAUDE.md
// "Compliance content guardrails" and docs/product/features/billing-trust/.

export type Reviewer = "texas_attorney" | "cpa";

export type ComplianceGateId =
  /** c75: the trust-account rule list the ledger enforces (attorney + CPA). */
  | "trust_rules_c75"
  /** c76: the trust ledger + three-way reconciliation engine exists and is reviewed. */
  | "trust_ledger_c76"
  /** c50: the evergreen / minimum-balance term and replenishment mechanics. */
  | "retainer_floor_terms_c50"
  /** c52: advance flat fees into trust, earning milestones, transfer to operating. */
  | "fixed_fee_earning_c52"
  /** c78: paying client costs out of trust. */
  | "costs_from_trust_c78"
  /** c82: refund of unearned funds, disputed-funds handling at close. */
  | "refund_rules_c82"
  /** c78/c79: markup on costs and how it is disclosed on invoices. */
  | "cost_markup_disclosure_c78"
  /** c81: the point at which collection moves beyond reminders. */
  | "collections_escalation_c81"
  /** Client-facing wording (replenishment requests, reminders, refund letters). */
  | "client_copy_billing";

export interface GateApproval {
  approved: boolean;
  /** Names of the reviewers who signed off, by reviewer type. */
  approvedBy?: Partial<Record<Reviewer, string>>;
  /** ISO date of the final sign-off. */
  approvedOn?: string;
  /** Path or URL of the signed-off review document. */
  reference?: string;
}

export interface ComplianceGate {
  id: ComplianceGateId;
  description: string;
  requiredReviewers: Reviewer[];
  status: GateApproval;
}

const PENDING: GateApproval = { approved: false };

// PLACEHOLDER: every gate is pending until the named reviewers sign off.
// To approve one, change `status` in a PR with the reviewer names, date and
// the reference to the signed review. Never approve a gate from code paths.
export const COMPLIANCE_GATES: Readonly<Record<ComplianceGateId, ComplianceGate>> = {
  trust_rules_c75: {
    id: "trust_rules_c75",
    description:
      "Texas trust-account (IOLTA) rule list: what counts as earned, disputed funds, advance flat fees, card fees, refunds, record keeping.",
    requiredReviewers: ["texas_attorney", "cpa"],
    status: PENDING,
  },
  trust_ledger_c76: {
    id: "trust_ledger_c76",
    description: "Append-only per-client trust ledger and monthly three-way reconciliation are built and reviewed.",
    requiredReviewers: ["texas_attorney", "cpa"],
    status: PENDING,
  },
  retainer_floor_terms_c50: {
    id: "retainer_floor_terms_c50",
    description: "Evergreen / minimum-balance ($4,500 default) engagement term and the pay-down-to-floor mechanics.",
    requiredReviewers: ["texas_attorney", "cpa"],
    status: PENDING,
  },
  fixed_fee_earning_c52: {
    id: "fixed_fee_earning_c52",
    description: "Fixed-fee payments held in trust until earning milestones are met, then moved to operating.",
    requiredReviewers: ["texas_attorney", "cpa"],
    status: PENDING,
  },
  costs_from_trust_c78: {
    id: "costs_from_trust_c78",
    description: "Paying client costs and expenses directly out of the client's trust funds.",
    requiredReviewers: ["texas_attorney", "cpa"],
    status: PENDING,
  },
  refund_rules_c82: {
    id: "refund_rules_c82",
    description: "Refund of unearned trust funds at matter end, and holding disputed amounts.",
    requiredReviewers: ["texas_attorney", "cpa"],
    status: PENDING,
  },
  cost_markup_disclosure_c78: {
    id: "cost_markup_disclosure_c78",
    description: "Whether and how costs may be marked up, and how that is disclosed to the client.",
    requiredReviewers: ["texas_attorney"],
    status: PENDING,
  },
  collections_escalation_c81: {
    id: "collections_escalation_c81",
    description: "Anything beyond polite reminders (collections referral, suit, withdrawal) — always a lawyer decision.",
    requiredReviewers: ["texas_attorney"],
    status: PENDING,
  },
  client_copy_billing: {
    id: "client_copy_billing",
    description: "Client-facing billing wording: replenishment requests, payment reminders, refund letters.",
    requiredReviewers: ["texas_attorney"],
    status: PENDING,
  },
};

export class PendingApprovalError extends Error {
  readonly gate: ComplianceGateId;
  readonly requiredReviewers: Reviewer[];

  constructor(gate: ComplianceGate, action: string) {
    super(
      `Blocked: "${action}" needs compliance gate "${gate.id}" ` +
        `(${gate.requiredReviewers.join(" + ")} sign-off) which is still pending. ${gate.description}`
    );
    this.name = "PendingApprovalError";
    this.gate = gate.id;
    this.requiredReviewers = gate.requiredReviewers;
  }
}

export type GateRegistry = Readonly<Record<ComplianceGateId, ComplianceGate>>;

export function isGateApproved(id: ComplianceGateId, registry: GateRegistry = COMPLIANCE_GATES): boolean {
  const gate = registry[id];
  if (!gate.status.approved) return false;
  // An approval without every required reviewer's name recorded is not an approval.
  return gate.requiredReviewers.every((r) => Boolean(gate.status.approvedBy?.[r]));
}

/** Throws PendingApprovalError unless every listed gate is approved. */
export function requireGates(
  ids: ComplianceGateId[],
  action: string,
  registry: GateRegistry = COMPLIANCE_GATES
): void {
  for (const id of ids) {
    if (!isGateApproved(id, registry)) {
      throw new PendingApprovalError(registry[id], action);
    }
  }
}
