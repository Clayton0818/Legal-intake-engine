// c50 — Retainer floor ($4,500 default): an approved invoice is paid from the
// client's trust balance only down to the floor; the rest is billed to the
// client directly, and flags are raised.
//
// This file has two layers:
//   - planTrustPayment(): a PURE calculation. Safe to run today, e.g. to show
//     a lawyer a preview on a draft invoice (c79). Moves no money.
//   - executeTrustPayment(): the step that would post a ledger entry. It is a
//     PLACEHOLDER that throws PendingApprovalError until the trust review
//     (c75), the ledger (c76) and the floor terms (c50) are signed off by a
//     Texas attorney and a CPA.
//
// Hard trust rules that the floor can never override (c50 note, c76):
//   - a client's trust balance can never go negative;
//   - one client's money can never cover another client's bill;
//   - money leaves trust only for fees actually earned and invoiced;
//   - a disputed amount stays in trust until resolved.

import { assertNonNegativeCents, type Cents } from "./money";
import { requireGates, type GateRegistry, COMPLIANCE_GATES } from "./approvals";

export interface TrustPosition {
  clientId: string;
  matterId: string;
  /** Current balance of this client's sub-ledger for this matter (c76). */
  balanceCents: Cents;
  /** Funds inside the balance that are held because of a dispute. Never drawn. */
  disputedHeldCents: Cents;
}

export interface InvoiceToPay {
  invoiceId: string;
  clientId: string;
  matterId: string;
  /** Invoice status must be an approved, issued invoice (c79). */
  status: "draft" | "approved" | "sent" | "partially_paid" | "paid" | "void";
  /** Amount still open on the invoice. */
  openCents: Cents;
  /** Part of the open amount the client disputes. Not paid from trust, not chased. */
  disputedCents: Cents;
}

export interface FloorTerms {
  /** Floor for this matter (firm default, lawyer may override per matter). */
  floorCents: Cents;
  /** Early warning threshold, or null when off. */
  earlyWarningCents: Cents | null;
  /**
   * True only if the signed engagement agreement (c39) contains the
   * evergreen / minimum-balance term. Without it the floor is not applied
   * and no replenishment request is sent.
   */
  agreedInEngagement: boolean;
}

export type FloorFlag =
  /** Payable amount was more than trust could cover above the floor. */
  | "floor_limited_payment"
  /** Balance after payment is below the floor: client replenishment request. */
  | "below_floor"
  /** Balance after payment is under the early-warning threshold but not below the floor. */
  | "early_warning"
  /** Matter uses a retainer but the floor term is not in the signed agreement. Internal only. */
  | "floor_not_in_agreement"
  /** Some of the invoice is disputed and was held. Internal only. */
  | "disputed_amount_held";

export interface TrustPaymentPlan {
  invoiceId: string;
  /** Amount to draw from this client's trust for this invoice. */
  trustDrawCents: Cents;
  /** Amount billed to the client directly as due. */
  clientDueCents: Cents;
  /** Disputed amount left unpaid and untouched. */
  disputedCents: Cents;
  balanceAfterCents: Cents;
  floorCents: Cents;
  /** Amount needed to bring the balance back to the floor (0 if none). */
  replenishmentNeededCents: Cents;
  flags: FloorFlag[];
}

export class TrustRuleViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrustRuleViolation";
  }
}

export function planTrustPayment(position: TrustPosition, invoice: InvoiceToPay, terms: FloorTerms): TrustPaymentPlan {
  assertNonNegativeCents(position.disputedHeldCents, "disputedHeldCents");
  assertNonNegativeCents(invoice.openCents, "openCents");
  assertNonNegativeCents(invoice.disputedCents, "disputedCents");
  assertNonNegativeCents(terms.floorCents, "floorCents");

  if (!Number.isInteger(position.balanceCents) || position.balanceCents < 0) {
    throw new TrustRuleViolation(`Trust balance for client ${position.clientId} is negative or invalid; stop and reconcile (c76).`);
  }
  if (position.clientId !== invoice.clientId || position.matterId !== invoice.matterId) {
    throw new TrustRuleViolation("One client's (or matter's) trust money can never pay another client's (or matter's) invoice.");
  }
  if (invoice.status !== "approved" && invoice.status !== "sent" && invoice.status !== "partially_paid") {
    throw new TrustRuleViolation(`Trust may only pay an approved, issued invoice; invoice ${invoice.invoiceId} is "${invoice.status}".`);
  }
  if (invoice.disputedCents > invoice.openCents) {
    throw new Error("disputedCents cannot exceed openCents");
  }
  if (position.disputedHeldCents > position.balanceCents) {
    throw new TrustRuleViolation("Disputed funds held cannot exceed the trust balance.");
  }

  const flags: FloorFlag[] = [];
  const floor = terms.agreedInEngagement ? terms.floorCents : 0;
  if (!terms.agreedInEngagement && terms.floorCents > 0) flags.push("floor_not_in_agreement");
  if (invoice.disputedCents > 0) flags.push("disputed_amount_held");

  const payable = invoice.openCents - invoice.disputedCents;
  // Disputed funds already held in trust are not available, and the floor sits on top of them.
  const drawable = Math.max(0, position.balanceCents - position.disputedHeldCents - floor);
  const trustDraw = Math.min(payable, drawable);
  const clientDue = payable - trustDraw;
  const balanceAfter = position.balanceCents - trustDraw;

  if (balanceAfter < 0) throw new TrustRuleViolation("Plan would make trust negative (bug).");

  if (clientDue > 0 && terms.agreedInEngagement) flags.push("floor_limited_payment");

  let replenishmentNeeded = 0;
  if (terms.agreedInEngagement) {
    const effective = balanceAfter - position.disputedHeldCents;
    if (effective < floor) {
      replenishmentNeeded = floor - effective;
      flags.push("below_floor");
    } else if (terms.earlyWarningCents !== null && effective < terms.earlyWarningCents) {
      flags.push("early_warning");
    }
  }

  return {
    invoiceId: invoice.invoiceId,
    trustDrawCents: trustDraw,
    clientDueCents: clientDue,
    disputedCents: invoice.disputedCents,
    balanceAfterCents: balanceAfter,
    floorCents: floor,
    replenishmentNeededCents: replenishmentNeeded,
    flags,
  };
}

/** Which audiences each flag reaches. Client never sees firm-side flags. */
export function floorFlagAudience(flag: FloorFlag): { client: boolean; firm: boolean } {
  switch (flag) {
    case "below_floor":
    case "early_warning":
    case "floor_limited_payment":
      return { client: true, firm: true };
    case "floor_not_in_agreement":
    case "disputed_amount_held":
      return { client: false, firm: true };
  }
}

/**
 * PLACEHOLDER — posting the trust draw.
 *
 * Would write an append-only `trust_ledger_entries` row (c76) of type
 * `draw_for_invoice`, a matching operating-side receipt, the client-due
 * amount on the invoice, and the audit events, all in one withTenant()
 * transaction. It is intentionally not implemented and throws until every
 * gate below is approved by a licensed Texas attorney and a CPA.
 */
export async function executeTrustPayment(
  _plan: TrustPaymentPlan,
  registry: GateRegistry = COMPLIANCE_GATES
): Promise<never> {
  requireGates(
    ["trust_rules_c75", "trust_ledger_c76", "retainer_floor_terms_c50"],
    "draw from client trust to pay an invoice",
    registry
  );
  // Reached only after sign-off. Implementation belongs to the c76 ledger build.
  throw new Error("executeTrustPayment: approved but not yet implemented; build with the c76 trust ledger.");
}
