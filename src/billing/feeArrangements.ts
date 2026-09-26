// c52 — Every matter is either FIXED FEE (with a pay schedule) or RETAINER
// (hourly billed against a trust retainer with the c50 floor).
//
// Two schedules, not one:
//   - the PAY schedule: when the client pays (upfront + installments);
//   - the EARNING schedule: lawyer-defined milestones at which the firm has
//     actually earned part of the fee.
// Per the State Bar of Texas trust guide, Cluck v. Comm'n for Lawyer
// Discipline (214 S.W.3d 736) and Texas Ethics Opinion 611, an advance flat
// fee belongs to the client until earned and goes into trust. So money moves
// from trust to operating only as milestones complete. That movement is a
// PLACEHOLDER below, gated on attorney + CPA sign-off (c75, c52).

import { addDays, addMonths, parseIsoDate, type IsoDate } from "./calendar";
import { assertNonNegativeCents, splitEvenly, type Cents } from "./money";
import { requireGates, type GateRegistry, COMPLIANCE_GATES } from "./approvals";

export type FeeArrangementType = "fixed_fee" | "retainer";
export type InstallmentFrequency = "weekly" | "biweekly" | "monthly";

export interface FixedFeeTemplate {
  practiceArea: string; // e.g. "family_law"
  matterType: string; // e.g. "uncontested_divorce"
  /** PLACEHOLDER: the firm sets its own fees; the product ships none. */
  totalCents: Cents;
  upfrontCents: Cents;
  installmentCount: number;
  frequency: InstallmentFrequency;
  /** Default earning milestones for this matter type, as shares of the total in basis points. */
  milestones: { key: string; label: string; shareBasisPoints: number }[];
}

export interface PayScheduleInput {
  totalCents: Cents;
  upfrontCents: Cents;
  upfrontDueDate: IsoDate;
  installmentCount: number;
  frequency: InstallmentFrequency;
  /** Due date of the first installment. */
  firstInstallmentDate: IsoDate;
}

export interface PayScheduleLine {
  seq: number; // 0 = upfront
  kind: "upfront" | "installment";
  dueDate: IsoDate;
  amountCents: Cents;
}

export function nextDueDate(first: IsoDate, index: number, frequency: InstallmentFrequency): IsoDate {
  switch (frequency) {
    case "weekly":
      return addDays(first, 7 * index);
    case "biweekly":
      return addDays(first, 14 * index);
    case "monthly":
      // Always computed from the first date so Jan 31 -> Feb 28 -> Mar 31, not drifting.
      return addMonths(first, index);
  }
}

export function buildPaySchedule(input: PayScheduleInput): PayScheduleLine[] {
  assertNonNegativeCents(input.totalCents, "totalCents");
  assertNonNegativeCents(input.upfrontCents, "upfrontCents");
  if (input.totalCents === 0) throw new Error("A fixed fee total must be greater than zero");
  if (input.upfrontCents > input.totalCents) throw new Error("Upfront amount cannot exceed the total");
  if (!Number.isInteger(input.installmentCount) || input.installmentCount < 0) {
    throw new Error("installmentCount must be a non-negative integer");
  }
  const remainder = input.totalCents - input.upfrontCents;
  if (remainder > 0 && input.installmentCount === 0) {
    throw new Error("The upfront amount must equal the total when there are no installments");
  }
  if (remainder === 0 && input.installmentCount > 0) {
    throw new Error("No balance left to spread over installments");
  }
  if (input.installmentCount > 0 && parseIsoDate(input.firstInstallmentDate) < parseIsoDate(input.upfrontDueDate)) {
    throw new Error("First installment cannot be due before the upfront payment");
  }

  const lines: PayScheduleLine[] = [];
  if (input.upfrontCents > 0) {
    lines.push({ seq: 0, kind: "upfront", dueDate: input.upfrontDueDate, amountCents: input.upfrontCents });
  }
  if (input.installmentCount > 0) {
    const parts = splitEvenly(remainder, input.installmentCount);
    parts.forEach((amount, i) => {
      lines.push({
        seq: i + 1,
        kind: "installment",
        dueDate: nextDueDate(input.firstInstallmentDate, i, input.frequency),
        amountCents: amount,
      });
    });
  }
  const sum = lines.reduce((a, l) => a + l.amountCents, 0);
  if (sum !== input.totalCents) throw new Error("Pay schedule does not add up to the total (bug)");
  return lines;
}

// ---------------------------------------------------------------------------
// Earning schedule
// ---------------------------------------------------------------------------

export interface EarningMilestone {
  key: string;
  label: string;
  amountCents: Cents;
  /** Set when the responsible lawyer marks the milestone complete. */
  completedAt: string | null;
  completedByUserId: string | null;
}

/** Convert template shares into amounts; the rounding remainder lands on the last milestone. */
export function milestonesFromShares(
  totalCents: Cents,
  shares: { key: string; label: string; shareBasisPoints: number }[]
): EarningMilestone[] {
  if (shares.length === 0) throw new Error("At least one earning milestone is required");
  const bpSum = shares.reduce((a, s) => a + s.shareBasisPoints, 0);
  if (bpSum !== 10_000) throw new Error(`Milestone shares must add to 100% (10000 bp), got ${bpSum}`);
  let allocated = 0;
  return shares.map((s, i) => {
    const amount = i === shares.length - 1 ? totalCents - allocated : Math.floor((totalCents * s.shareBasisPoints) / 10_000);
    allocated += amount;
    return { key: s.key, label: s.label, amountCents: amount, completedAt: null, completedByUserId: null };
  });
}

export function validateEarningSchedule(totalCents: Cents, milestones: EarningMilestone[]): void {
  const sum = milestones.reduce((a, m) => a + m.amountCents, 0);
  if (sum !== totalCents) throw new Error(`Earning milestones add to ${sum}, expected ${totalCents}`);
  const keys = new Set(milestones.map((m) => m.key));
  if (keys.size !== milestones.length) throw new Error("Milestone keys must be unique");
}

export function earnedCents(milestones: EarningMilestone[]): Cents {
  return milestones.filter((m) => m.completedAt !== null).reduce((a, m) => a + m.amountCents, 0);
}

export interface EarnedTransferPlan {
  /** Earned but not yet moved to operating. */
  earnedNotTransferredCents: Cents;
  /** What can actually move now: limited by what the client has paid into trust for this matter. */
  transferableCents: Cents;
  /** Earned but the client has not paid it yet (billable to the client). */
  earnedUnpaidCents: Cents;
  /** Paid into trust and not yet earned: refundable if the representation ends early (c82). */
  unearnedInTrustCents: Cents;
}

export function planEarnedTransfer(params: {
  milestones: EarningMilestone[];
  /** Total the client has paid into trust for this fixed fee. */
  paidIntoTrustCents: Cents;
  /** Total already transferred from trust to operating for this fixed fee. */
  transferredCents: Cents;
}): EarnedTransferPlan {
  const earned = earnedCents(params.milestones);
  assertNonNegativeCents(params.paidIntoTrustCents, "paidIntoTrustCents");
  assertNonNegativeCents(params.transferredCents, "transferredCents");
  if (params.transferredCents > earned) {
    throw new Error("More has been transferred to operating than has been earned; stop and reconcile (c76).");
  }
  if (params.transferredCents > params.paidIntoTrustCents) {
    throw new Error("More has been transferred than was paid in; stop and reconcile (c76).");
  }
  const heldInTrust = params.paidIntoTrustCents - params.transferredCents;
  const earnedNotTransferred = earned - params.transferredCents;
  const transferable = Math.min(earnedNotTransferred, heldInTrust);
  return {
    earnedNotTransferredCents: earnedNotTransferred,
    transferableCents: transferable,
    earnedUnpaidCents: earnedNotTransferred - transferable,
    unearnedInTrustCents: heldInTrust - transferable,
  };
}

/**
 * PLACEHOLDER — moving earned fixed-fee money from trust to operating.
 * Throws until the trust review (c75), the ledger (c76) and the fixed-fee
 * earning rules (c52) are signed off by a Texas attorney and a CPA.
 */
export async function executeEarnedTransfer(
  _plan: EarnedTransferPlan,
  registry: GateRegistry = COMPLIANCE_GATES
): Promise<never> {
  requireGates(
    ["trust_rules_c75", "trust_ledger_c76", "fixed_fee_earning_c52"],
    "move earned fixed-fee funds from trust to operating",
    registry
  );
  throw new Error("executeEarnedTransfer: approved but not yet implemented; build with the c76 trust ledger.");
}

// ---------------------------------------------------------------------------
// Arrangement changes
// ---------------------------------------------------------------------------

export interface FeeArrangementRecord {
  type: FeeArrangementType;
  /** Engagement agreement document id (c39) this arrangement was signed in. */
  engagementDocumentId: string | null;
  signedAt: string | null;
}

/** An arrangement is only in force once it is in a signed engagement agreement (c39). */
export function isArrangementInForce(a: FeeArrangementRecord): boolean {
  return Boolean(a.engagementDocumentId && a.signedAt);
}

/** Changing arrangement type, total or schedule mid-matter needs a new signed agreement. */
export function changeRequiresNewAgreement(
  current: { type: FeeArrangementType; totalCents: Cents | null; schedule: PayScheduleLine[] },
  proposed: { type: FeeArrangementType; totalCents: Cents | null; schedule: PayScheduleLine[] }
): boolean {
  if (current.type !== proposed.type) return true;
  if (current.totalCents !== proposed.totalCents) return true;
  return JSON.stringify(current.schedule) !== JSON.stringify(proposed.schedule);
}
