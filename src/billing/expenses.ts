// c78 — Costs and expenses billable to the client: filing fees, service of
// process, experts, copies, travel and mileage, with receipt upload, billable
// flag, and whether the firm paid it or it was paid from trust. Costs flow
// into the next invoice. Markups follow the engagement agreement.
//
// Placeholders:
//   - Paying a cost FROM TRUST is gated (c75/c76/c78 attorney + CPA review).
//   - Any markup is gated (attorney review of how it is disclosed) and must
//     also be allowed by the matter's signed engagement agreement.
//   - Mileage has no product default rate; the firm must set one.

import { applyBasisPoints, assertNonNegativeCents, type Cents } from "./money";
import { requireGates, isGateApproved, type GateRegistry, COMPLIANCE_GATES } from "./approvals";

export type ExpenseCategory =
  | "filing_fee"
  | "service_of_process"
  | "expert"
  | "copies"
  | "travel"
  | "mileage"
  | "other";

export type PaidFrom = "firm_operating" | "client_trust" | "client_direct";

export type ExpenseStatus = "draft" | "approved" | "billed" | "void";

export interface Expense {
  id: string;
  tenantId: string;
  matterId: string;
  category: ExpenseCategory;
  incurredOn: string;
  description: string;
  /** Actual cost to the firm or trust. */
  costCents: Cents;
  /** For mileage: miles driven (costCents is derived from the firm rate). */
  miles: number | null;
  billable: boolean;
  paidFrom: PaidFrom;
  /** Receipt stored in the Document engine (c84); required above the firm threshold. */
  receiptDocumentId: string | null;
  /** Markup applied, in basis points (0 unless allowed; see markupFor()). */
  markupBasisPoints: number;
  status: ExpenseStatus;
  enteredByUserId: string;
  approvedByUserId: string | null;
  invoiceId: string | null;
}

export interface EngagementCostTerms {
  /** True only if the signed engagement agreement allows a markup on costs. */
  markupAllowed: boolean;
  /** Markup the agreement allows, in basis points. */
  markupBasisPoints: number;
}

/** Mileage cost from the firm rate. There is no product default rate. */
export function mileageCost(miles: number, rateCentsPerMile: Cents | null): Cents {
  if (rateCentsPerMile === null) {
    throw new Error("PLACEHOLDER: the firm has not set a mileage rate (settings.mileageRateCentsPerMile).");
  }
  if (!(miles > 0)) throw new Error("miles must be positive");
  return Math.round(miles * rateCentsPerMile);
}

/**
 * The markup that may be applied to a cost. Returns 0 unless BOTH the
 * attorney-review gate is approved AND the engagement agreement allows it.
 */
export function markupFor(terms: EngagementCostTerms | null, registry: GateRegistry = COMPLIANCE_GATES): number {
  if (!terms || !terms.markupAllowed) return 0;
  if (!isGateApproved("cost_markup_disclosure_c78", registry)) return 0;
  return terms.markupBasisPoints;
}

/** What the client is billed for this cost (0 when non-billable). */
export function billedAmountCents(e: Pick<Expense, "costCents" | "billable" | "markupBasisPoints">): Cents {
  assertNonNegativeCents(e.costCents, "costCents");
  if (!e.billable) return 0;
  return e.costCents + applyBasisPoints(e.costCents, e.markupBasisPoints);
}

export function validateExpense(e: Expense, ctx: { receiptRequiredAboveCents: Cents }): string[] {
  const problems: string[] = [];
  if (e.costCents <= 0) problems.push("Cost must be greater than zero.");
  if (e.category === "mileage" && (e.miles === null || e.miles <= 0)) problems.push("Mileage entries need miles.");
  if (e.costCents > ctx.receiptRequiredAboveCents && !e.receiptDocumentId) {
    problems.push("A receipt is required for costs above the firm threshold.");
  }
  if (e.paidFrom === "client_trust" && !e.billable) {
    problems.push("A cost paid from client trust must be billable to that client.");
  }
  return problems;
}

/** Approved, billable, unbilled costs for a matter's next invoice (c79). */
export function costsForInvoice(expenses: Expense[], matterId: string): Expense[] {
  return expenses.filter((e) => e.matterId === matterId && e.status === "approved" && e.invoiceId === null && e.billable);
}

/**
 * PLACEHOLDER — recording a cost as paid from the client's trust funds.
 * Throws until the trust review (c75), the ledger (c76) and the
 * costs-from-trust rules (c78) are signed off by a Texas attorney and a CPA.
 */
export async function payExpenseFromTrust(_expense: Expense, registry: GateRegistry = COMPLIANCE_GATES): Promise<never> {
  requireGates(["trust_rules_c75", "trust_ledger_c76", "costs_from_trust_c78"], "pay a client cost from trust", registry);
  throw new Error("payExpenseFromTrust: approved but not yet implemented; build with the c76 trust ledger.");
}
