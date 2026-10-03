// c76 — the trust ledger's rules, as pure functions over an in-memory
// account state. The database enforces the same invariants independently
// (triggers + CHECKs listed in src/db/tables/billing-trust.ts MIGRATION
// NOTES); this layer exists so every rule is exhaustively unit- and
// property-tested, and so a refused action is explained to staff in plain
// words before it ever reaches the database.
//
// Invariants (compliance review c75 §11):
//   I1  no sub-ledger balance is ever below zero                         (§11.2)
//   I2  money held for a dispute is never moved (balance ≥ held ≥ 0)     (§11.6)
//   I3  book balance = Σ sub-ledger balances                             (§11.1)
//   I4  one client's money never covers another's: a transaction changes
//       the balance of at most one client, and a transfer nets to zero
//       for that client                                                  (§11.2, c50)
//   I5  firm money only ever enters the firm-cushion sub-ledger, and only
//       when the cushion rule is approved and within the firm's cap      (§8, §11.7)
//   I6  entries are never edited: a correction is an exact reversal, at
//       most once per transaction                                        (§11.10)
//   I7  nothing is posted into a period that has been reconciled and closed
//
// Nothing here checks approvals: the service calls
// requireApproval("rules.trust_accounting") before it plans a posting.

import { assertPositiveAmount, MoneyError, type Cents } from "./money";
import {
  INFLOW_KINDS,
  OUTFLOW_KINDS,
  TrustRuleError,
  isIsoDate,
  type FundsSource,
  type SubledgerKind,
  type TransactionKind,
} from "./types";

export interface SubledgerState {
  id: string;
  trustAccountId: string;
  kind: SubledgerKind;
  /** The client (parties.id) whose money this is. Null only for the firm cushion. */
  clientPartyId: string | null;
  matterId: string | null;
  balance: Cents;
  /** Disputed / held amount (active holds). Never available to move. */
  held: Cents;
}

export interface AccountState {
  id: string;
  status: "active" | "closed";
  bookBalance: Cents;
  lastSequence: number;
  lastHash: string | null;
  /** Period-end date of the latest closed (reconciled and signed-off) month; nothing may be dated on or before it. */
  closedThrough: string | null;
  /** Firm-configured maximum for the bank-fee cushion (0 = no cushion). */
  cushionCap: Cents;
  subledgers: ReadonlyMap<string, SubledgerState>;
}

/** An earlier transaction, as needed to plan its reversal. */
export interface OriginalTransaction {
  id: string;
  trustAccountId: string;
  kind: TransactionKind;
  lines: ReadonlyArray<{ subledgerId: string; amount: Cents }>;
  /** Id of the reversal already posted against it, if any. */
  reversedById: string | null;
}

export interface TransactionInput {
  kind: TransactionKind;
  trustAccountId: string;
  /** The date the money actually moved (bank date), 'YYYY-MM-DD'. */
  effectiveDate: string;
  /** Why — required on every entry (who and when are recorded by the service). */
  reason: string;
  memo?: string | null;
  /** Payee or payer (required for disbursements). */
  counterparty?: string | null;
  /** Check number, wire reference, deposit slip … */
  reference?: string | null;
  /** The invoice this entry pays (extension point for c79; no FK yet). */
  invoiceId?: string | null;
  /** For earned-fee transfers without an invoice: the earning benchmark that was met (c52 / c75 §7). */
  earnedBasis?: string | null;
  fundsSource?: FundsSource | null;
  /** A card processor's fee deducted from the deposit. Must be zero: fees never come out of trust (§8). */
  processorFeeCents?: Cents | null;
  amount?: Cents | null;
  /** The sub-ledger the money goes into (inflows) or out of (outflows / transfer source). */
  subledgerId?: string | null;
  /** Transfer destination (same client, different matter). */
  toSubledgerId?: string | null;
  reversesTransactionId?: string | null;
}

export interface PlanContext {
  /** Today in the firm's time zone ('YYYY-MM-DD'); entries may not be dated in the future. */
  today: string;
  /** Whether the bank-fee cushion rule gate is approved (rules.billing-trust.bank_fee_cushion). */
  cushionRuleApproved: boolean;
  /** Required for kind 'reversal'. */
  original?: OriginalTransaction | null;
  /**
   * c50 extension point: per-sub-ledger evergreen retainer floor. When set, an
   * earned-fee transfer may only take the balance down to the floor.
   */
  retainerFloors?: ReadonlyMap<string, Cents>;
}

export interface PlannedLine {
  lineNo: number;
  subledgerId: string;
  amount: Cents;
  balanceAfter: Cents;
  bookBalanceAfter: Cents;
}

export interface TransactionPlan {
  trustAccountId: string;
  sequence: number;
  prevHash: string | null;
  kind: TransactionKind;
  effectiveDate: string;
  netAmount: Cents;
  reason: string;
  memo: string | null;
  counterparty: string | null;
  reference: string | null;
  invoiceId: string | null;
  earnedBasis: string | null;
  fundsSource: FundsSource | null;
  reversesTransactionId: string | null;
  lines: PlannedLine[];
  bookBalanceAfter: Cents;
}

const MAX_TEXT = 2000;

function cleanText(v: string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const t = v.trim();
  if (t.length > MAX_TEXT) throw new TrustRuleError("BAD_REQUEST", `Text fields are limited to ${MAX_TEXT} characters.`);
  return t.length > 0 ? t : null;
}

function requireSubledger(state: AccountState, id: string | null | undefined, role: string): SubledgerState {
  if (!id) throw new TrustRuleError("UNKNOWN_SUBLEDGER", `Choose the ${role} ledger.`);
  const s = state.subledgers.get(id);
  if (!s) throw new TrustRuleError("UNKNOWN_SUBLEDGER", `The ${role} ledger was not found in this trust account.`, { subledgerId: id });
  if (s.trustAccountId !== state.id) {
    throw new TrustRuleError("WRONG_ACCOUNT", `The ${role} ledger belongs to a different trust account.`, { subledgerId: id });
  }
  return s;
}

function requireKind(s: SubledgerState, kind: SubledgerKind, why: string): void {
  if (s.kind !== kind) throw new TrustRuleError("WRONG_SUBLEDGER_KIND", why, { subledgerId: s.id, kind: s.kind });
}

function amountOf(input: TransactionInput): Cents {
  if (input.amount === null || input.amount === undefined) throw new TrustRuleError("INVALID_AMOUNT", "Enter an amount.");
  try {
    return assertPositiveAmount(input.amount);
  } catch (err) {
    if (err instanceof MoneyError) throw new TrustRuleError("INVALID_AMOUNT", err.message);
    throw err;
  }
}

function forbid(input: TransactionInput, fields: (keyof TransactionInput)[]): void {
  for (const f of fields) {
    const v = input[f];
    if (v !== undefined && v !== null && v !== "" && !(typeof v === "bigint" && v === 0n)) {
      throw new TrustRuleError("UNEXPECTED_FIELD", `'${String(f)}' does not apply to a ${input.kind.replace(/_/g, " ")}.`, { field: f });
    }
  }
}

/** Money that can leave a sub-ledger now: balance minus held (disputed) funds. */
export function available(s: Pick<SubledgerState, "balance" | "held">): Cents {
  return s.balance - s.held;
}

function checkOutflow(s: SubledgerState, amount: Cents): void {
  if (amount > s.balance) {
    throw new TrustRuleError(
      "INSUFFICIENT_FUNDS",
      "This would take the ledger below zero. A client's trust balance can never go negative, and another client's money can never cover it.",
      { subledgerId: s.id, balance: s.balance.toString(), amount: amount.toString() }
    );
  }
  if (amount > available(s)) {
    throw new TrustRuleError(
      "FUNDS_ON_HOLD",
      "Part of this balance is held because it is disputed. Held money stays in trust until the dispute is resolved.",
      { subledgerId: s.id, balance: s.balance.toString(), held: s.held.toString(), amount: amount.toString() }
    );
  }
}

/**
 * c50 helper: how much of an invoice can be paid from trust without taking
 * the balance below the floor, and how much must be billed to the client.
 */
export function retainerFloorSplit(
  s: Pick<SubledgerState, "balance" | "held">,
  floor: Cents,
  invoiceAmount: Cents
): { fromTrust: Cents; billDirect: Cents } {
  const headroom = available(s) - floor;
  const fromTrust = headroom <= 0n ? 0n : headroom < invoiceAmount ? headroom : invoiceAmount;
  return { fromTrust, billDirect: invoiceAmount - fromTrust };
}

/**
 * Validate a requested movement against the account state and return exactly
 * what would be written. Throws TrustRuleError (never partially applies).
 */
export function planTransaction(state: AccountState, input: TransactionInput, ctx: PlanContext): TransactionPlan {
  if (input.trustAccountId !== state.id) throw new TrustRuleError("WRONG_ACCOUNT", "This entry names a different trust account.");
  if (state.status !== "active") throw new TrustRuleError("ACCOUNT_CLOSED", "This trust account is closed.");

  const reason = cleanText(input.reason);
  if (!reason || reason.length < 3) throw new TrustRuleError("REASON_REQUIRED", "Say why this entry is being made.");
  if (!isIsoDate(input.effectiveDate)) throw new TrustRuleError("INVALID_DATE", "The date must be a calendar date (YYYY-MM-DD).");
  if (input.effectiveDate > ctx.today) throw new TrustRuleError("FUTURE_DATE", "An entry cannot be dated in the future.");
  if (state.closedThrough && input.effectiveDate <= state.closedThrough) {
    throw new TrustRuleError(
      "PERIOD_CLOSED",
      `The books are reconciled and closed through ${state.closedThrough}. Date the entry (or its correction) in the open period.`,
      { closedThrough: state.closedThrough }
    );
  }
  if (input.processorFeeCents !== undefined && input.processorFeeCents !== null && input.processorFeeCents !== 0n) {
    throw new TrustRuleError(
      "PROCESSOR_FEE_NETTED",
      "Card or payment processing fees can never be netted out of a trust deposit. Deposit the full amount; charge the fee to the operating account.",
      { processorFeeCents: input.processorFeeCents.toString() }
    );
  }

  const base = {
    trustAccountId: state.id,
    sequence: state.lastSequence + 1,
    prevHash: state.lastHash,
    kind: input.kind,
    effectiveDate: input.effectiveDate,
    reason,
    memo: cleanText(input.memo),
    counterparty: cleanText(input.counterparty),
    reference: cleanText(input.reference),
    invoiceId: cleanText(input.invoiceId),
    earnedBasis: cleanText(input.earnedBasis),
    fundsSource: input.fundsSource ?? null,
    reversesTransactionId: null as string | null,
  };

  let deltas: Array<{ subledgerId: string; amount: Cents }>;

  switch (input.kind) {
    case "deposit": {
      forbid(input, ["toSubledgerId", "reversesTransactionId", "earnedBasis"]);
      const s = requireSubledger(state, input.subledgerId, "client");
      requireKind(s, "client_matter", "Client money can only be deposited to a client-matter ledger.");
      if (!base.fundsSource) throw new TrustRuleError("FUNDS_SOURCE_REQUIRED", "Say where the money came from (client or third party).");
      if (base.fundsSource === "firm_operating") {
        throw new TrustRuleError(
          "COMMINGLING",
          "Firm money cannot be deposited to a client's trust ledger. The only firm money allowed in trust is the bank-fee cushion, if the firm has one."
        );
      }
      deltas = [{ subledgerId: s.id, amount: amountOf(input) }];
      break;
    }
    case "disbursement":
    case "refund":
    case "earned_fee_transfer": {
      forbid(input, ["toSubledgerId", "reversesTransactionId", "fundsSource"]);
      const s = requireSubledger(state, input.subledgerId, "client");
      requireKind(s, "client_matter", "Only client-matter ledgers pay disbursements, refunds and earned fees.");
      const amount = amountOf(input);
      if (input.kind === "disbursement" && !base.counterparty) {
        throw new TrustRuleError("PAYEE_REQUIRED", "Name the payee of the disbursement.");
      }
      if (input.kind === "earned_fee_transfer") {
        if (!base.invoiceId && !base.earnedBasis) {
          throw new TrustRuleError(
            "EARNED_BASIS_REQUIRED",
            "Money moves to operating only for fees actually earned: give the invoice it pays or the earning benchmark that was met."
          );
        }
        base.counterparty ??= "Firm operating account";
        const floor = ctx.retainerFloors?.get(s.id);
        if (floor !== undefined && s.balance - amount < floor) {
          const split = retainerFloorSplit(s, floor, amount);
          throw new TrustRuleError("BELOW_RETAINER_FLOOR", "This would take the retainer below the agreed minimum balance.", {
            floor: floor.toString(),
            fromTrust: split.fromTrust.toString(),
            billDirect: split.billDirect.toString(),
          });
        }
      }
      if (input.kind === "refund") base.counterparty ??= "Client";
      checkOutflow(s, amount);
      deltas = [{ subledgerId: s.id, amount: -amount }];
      break;
    }
    case "transfer": {
      forbid(input, ["reversesTransactionId", "fundsSource", "invoiceId", "earnedBasis"]);
      const from = requireSubledger(state, input.subledgerId, "source");
      const to = requireSubledger(state, input.toSubledgerId, "destination");
      if (from.id === to.id) throw new TrustRuleError("SAME_SUBLEDGER", "The source and destination are the same ledger.");
      requireKind(from, "client_matter", "Transfers are only between client-matter ledgers.");
      requireKind(to, "client_matter", "Transfers are only between client-matter ledgers.");
      if (!from.clientPartyId || from.clientPartyId !== to.clientPartyId) {
        throw new TrustRuleError(
          "CROSS_CLIENT",
          "Money can only be moved between matters of the same client. One client's money can never be used for another client.",
          { from: from.id, to: to.id }
        );
      }
      const amount = amountOf(input);
      checkOutflow(from, amount);
      deltas = [
        { subledgerId: from.id, amount: -amount },
        { subledgerId: to.id, amount },
      ];
      break;
    }
    case "cushion_deposit": {
      forbid(input, ["toSubledgerId", "reversesTransactionId", "invoiceId", "earnedBasis"]);
      const s = requireSubledger(state, input.subledgerId, "firm cushion");
      requireKind(s, "firm_cushion", "Firm money can only go to the firm's bank-fee cushion ledger.");
      if (base.fundsSource !== null && base.fundsSource !== "firm_operating") {
        throw new TrustRuleError("COMMINGLING", "Client money cannot be put in the firm's cushion ledger.");
      }
      base.fundsSource = "firm_operating";
      if (!ctx.cushionRuleApproved) {
        throw new TrustRuleError("CUSHION_NOT_ALLOWED", "A firm bank-fee cushion is not allowed until the cushion rule is approved by an attorney and a CPA.");
      }
      if (state.cushionCap <= 0n) throw new TrustRuleError("CUSHION_NOT_ALLOWED", "This account has no bank-fee cushion configured.");
      const amount = amountOf(input);
      if (s.balance + amount > state.cushionCap) {
        throw new TrustRuleError("CUSHION_CAP_EXCEEDED", "This would put more firm money in trust than the configured bank-fee cushion.", {
          cap: state.cushionCap.toString(),
          current: s.balance.toString(),
        });
      }
      deltas = [{ subledgerId: s.id, amount }];
      break;
    }
    case "cushion_withdrawal":
    case "bank_fee": {
      forbid(input, ["toSubledgerId", "reversesTransactionId", "invoiceId", "earnedBasis", "fundsSource"]);
      const s = requireSubledger(state, input.subledgerId, "firm cushion");
      requireKind(
        s,
        "firm_cushion",
        input.kind === "bank_fee"
          ? "Bank fees can never be charged to a client's ledger; they come only from the firm's cushion (or the operating account)."
          : "Only the firm cushion can be withdrawn to operating."
      );
      if (input.kind === "bank_fee") base.counterparty ??= "Bank";
      if (input.kind === "cushion_withdrawal") base.counterparty ??= "Firm operating account";
      const amount = amountOf(input);
      checkOutflow(s, amount);
      deltas = [{ subledgerId: s.id, amount: -amount }];
      break;
    }
    case "reversal": {
      forbid(input, ["amount", "subledgerId", "toSubledgerId", "fundsSource", "invoiceId", "earnedBasis"]);
      const original = ctx.original;
      if (!input.reversesTransactionId || !original || original.id !== input.reversesTransactionId) {
        throw new TrustRuleError("REVERSAL_INVALID", "Choose the entry to reverse.");
      }
      if (original.trustAccountId !== state.id) throw new TrustRuleError("REVERSAL_INVALID", "That entry belongs to a different trust account.");
      if (original.kind === "reversal") {
        throw new TrustRuleError("REVERSAL_INVALID", "A reversal cannot itself be reversed; post the correct entry again instead.");
      }
      if (original.reversedById) {
        throw new TrustRuleError("ALREADY_REVERSED", "That entry has already been reversed.", { reversedBy: original.reversedById });
      }
      if (original.lines.length === 0) throw new TrustRuleError("REVERSAL_INVALID", "That entry has no lines.");
      base.reversesTransactionId = original.id;
      deltas = original.lines.map((l) => ({ subledgerId: l.subledgerId, amount: -l.amount }));
      // Check every line: a reversal can never push a ledger below zero or into held funds.
      for (const d of deltas) {
        const s = requireSubledger(state, d.subledgerId, "original");
        if (d.amount < 0n) checkOutflow(s, -d.amount);
      }
      break;
    }
    default: {
      const never: never = input.kind;
      throw new TrustRuleError("BAD_REQUEST", `Unknown entry kind '${String(never)}'.`);
    }
  }

  const seen = new Set<string>();
  let book = state.bookBalance;
  const running = new Map<string, Cents>();
  const lines: PlannedLine[] = deltas.map((d, i) => {
    if (seen.has(d.subledgerId)) throw new TrustRuleError("SAME_SUBLEDGER", "An entry may touch each ledger only once.");
    seen.add(d.subledgerId);
    const s = state.subledgers.get(d.subledgerId)!;
    const after = (running.get(s.id) ?? s.balance) + d.amount;
    if (after < 0n) throw new TrustRuleError("INSUFFICIENT_FUNDS", "This would take a ledger below zero.", { subledgerId: s.id });
    running.set(s.id, after);
    book += d.amount;
    return { lineNo: i + 1, subledgerId: s.id, amount: d.amount, balanceAfter: after, bookBalanceAfter: book };
  });

  const netAmount = deltas.reduce((sum, d) => sum + d.amount, 0n);
  if (INFLOW_KINDS.includes(input.kind) && netAmount <= 0n) throw new TrustRuleError("INVALID_AMOUNT", "A deposit must be positive.");
  if (OUTFLOW_KINDS.includes(input.kind) && netAmount >= 0n) throw new TrustRuleError("INVALID_AMOUNT", "A withdrawal must be positive.");
  if (input.kind === "transfer" && netAmount !== 0n) throw new TrustRuleError("INVALID_AMOUNT", "A transfer must net to zero.");

  return { ...base, netAmount, lines, bookBalanceAfter: book };
}

/** Apply a validated plan; returns a NEW state (the input is never mutated). */
export function applyPlan(state: AccountState, plan: TransactionPlan, hash: string | null = null): AccountState {
  if (plan.sequence !== state.lastSequence + 1) throw new Error("applyPlan: plan is stale (sequence mismatch).");
  const subledgers = new Map(state.subledgers);
  for (const l of plan.lines) {
    const s = subledgers.get(l.subledgerId)!;
    subledgers.set(s.id, { ...s, balance: s.balance + l.amount });
  }
  return {
    ...state,
    bookBalance: state.bookBalance + plan.netAmount,
    lastSequence: plan.sequence,
    lastHash: hash,
    subledgers,
  };
}

// ---------------------------------------------------------------------------
// Disputed-funds holds (c75 §6, §11.6)
// ---------------------------------------------------------------------------

export interface HoldInput {
  subledgerId: string;
  amount: Cents;
  reason: string;
}

/** Validate placing a hold. Holds are placed only on client ledgers and never exceed the balance. */
export function planHold(state: AccountState, input: HoldInput): { subledgerId: string; amount: Cents; heldAfter: Cents; reason: string } {
  const s = requireSubledger(state, input.subledgerId, "client");
  requireKind(s, "client_matter", "Disputed-funds holds apply to client-matter ledgers.");
  const reason = cleanText(input.reason);
  if (!reason || reason.length < 3) throw new TrustRuleError("REASON_REQUIRED", "Describe the dispute.");
  let amount: Cents;
  try {
    amount = assertPositiveAmount(input.amount);
  } catch (err) {
    if (err instanceof MoneyError) throw new TrustRuleError("INVALID_AMOUNT", err.message);
    throw err;
  }
  if (s.held + amount > s.balance) {
    throw new TrustRuleError("HOLD_INVALID", "A hold cannot be larger than the money in the ledger that is not already held.", {
      balance: s.balance.toString(),
      held: s.held.toString(),
    });
  }
  return { subledgerId: s.id, amount, heldAfter: s.held + amount, reason };
}

export function applyHold(state: AccountState, subledgerId: string, delta: Cents): AccountState {
  const subledgers = new Map(state.subledgers);
  const s = subledgers.get(subledgerId);
  if (!s) throw new Error("applyHold: unknown sub-ledger");
  const held = s.held + delta;
  if (held < 0n || held > s.balance) throw new Error("applyHold: hold out of range");
  subledgers.set(subledgerId, { ...s, held });
  return { ...state, subledgers };
}

// ---------------------------------------------------------------------------
// Invariant checks (used by tests and by the reconciliation integrity pass)
// ---------------------------------------------------------------------------

export function checkInvariants(state: AccountState): string[] {
  const problems: string[] = [];
  let total = 0n;
  for (const s of state.subledgers.values()) {
    total += s.balance;
    if (s.balance < 0n) problems.push(`I1: ledger ${s.id} is negative (${s.balance}).`);
    if (s.held < 0n) problems.push(`I2: ledger ${s.id} has a negative hold (${s.held}).`);
    if (s.held > s.balance) problems.push(`I2: ledger ${s.id} holds more (${s.held}) than its balance (${s.balance}).`);
    if (s.kind === "client_matter" && (!s.clientPartyId || !s.matterId)) problems.push(`ledger ${s.id} has no client/matter.`);
    if (s.kind === "firm_cushion" && (s.clientPartyId || s.matterId)) problems.push(`cushion ledger ${s.id} names a client.`);
  }
  if (total !== state.bookBalance) problems.push(`I3: book balance ${state.bookBalance} ≠ Σ ledgers ${total}.`);
  if (state.bookBalance < 0n) problems.push(`book balance is negative (${state.bookBalance}).`);
  return problems;
}

/** Net change per client (party id; cushion = 'firm') made by one plan. Used to prove I4. */
export function clientDeltas(state: AccountState, plan: Pick<TransactionPlan, "lines">): Map<string, Cents> {
  const out = new Map<string, Cents>();
  for (const l of plan.lines) {
    const s = state.subledgers.get(l.subledgerId);
    const key = s?.clientPartyId ?? "firm";
    out.set(key, (out.get(key) ?? 0n) + l.amount);
  }
  return out;
}
