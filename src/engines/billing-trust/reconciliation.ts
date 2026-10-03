// c76 — monthly three-way reconciliation, as pure functions.
//
//   (1) bank:    statement closing balance, adjusted for items in transit
//   (2) book:    the trust account's register (Σ transaction net amounts)
//   (3) clients: Σ every client-matter (and cushion) sub-ledger
//
// as of the statement's period end. All three must agree to the cent, and
// every difference is itemised — a "small unexplained variance" is never
// accepted (c75 §4). The same pass re-verifies the ledger's own integrity:
// cached running balances vs recomputed sums, the hash chain, and each
// transaction's lines vs its register amount.

import { canonicalJson, sha256Hex, type ChainCheck } from "./hashChain";
import { jsonSafe, sumCents, type Cents } from "./money";
import {
  TrustRuleError,
  addDays,
  daysBetween,
  nextPeriod,
  periodBounds,
  type SignoffRole,
  type StatementLineKind,
  type SubledgerKind,
  type TransactionKind,
} from "./types";

export interface StatementLineData {
  id: string;
  lineNo: number;
  postedOn: string;
  amount: Cents;
  description: string;
  reference: string | null;
  kind: StatementLineKind;
}

export interface StatementData {
  id: string;
  period: string;
  periodStart: string;
  periodEnd: string;
  openingBalance: Cents;
  closingBalance: Cents;
  lines: StatementLineData[];
}

export interface BookTransaction {
  id: string;
  sequence: number;
  kind: TransactionKind;
  effectiveDate: string;
  netAmount: Cents;
  reference: string | null;
  counterparty: string | null;
  reason: string;
  reversesTransactionId: string | null;
  lines: ReadonlyArray<{ subledgerId: string; amount: Cents }>;
}

export interface LedgerSnapshot {
  id: string;
  kind: SubledgerKind;
  label: string;
  clientPartyId: string | null;
  matterId: string | null;
  cachedBalance: Cents;
  cachedHeld: Cents;
}

export interface ManualMatch {
  statementLineId: string;
  transactionIds: string[];
}

export interface ReconciliationInput {
  trustAccountId: string;
  period: string;
  statement: StatementData;
  /** Closing balance of the previous period's statement, when there is one. */
  previousClosingBalance: Cents | null;
  /** Every transaction of the account (all dates). */
  transactions: ReadonlyArray<BookTransaction>;
  ledgers: ReadonlyArray<LedgerSnapshot>;
  cachedBookBalance: Cents;
  /** Transactions already cleared by the bank in an earlier closed reconciliation. */
  previouslyCleared: ReadonlySet<string>;
  manualMatches?: ReadonlyArray<ManualMatch>;
  chain: ChainCheck;
  /** Deposits: how many days after the book date the bank may show them. */
  depositToleranceDays: number;
  /** Checks/withdrawals: how many days after the book date they may clear. */
  withdrawalClearDays: number;
  /** Outstanding items older than this are reported (warning, not blocking). */
  staleOutstandingDays: number;
}

export type DifferenceCode =
  | "STATEMENT_WRONG_PERIOD"
  | "STATEMENT_DOES_NOT_FOOT"
  | "STATEMENT_OPENING_MISMATCH"
  | "STATEMENT_LINE_OUTSIDE_PERIOD"
  | "UNMATCHED_BANK_LINE"
  | "UNEXPLAINED_BANK_DIFFERENCE"
  | "BOOK_VS_CLIENT_LEDGERS"
  | "NEGATIVE_CLIENT_LEDGER"
  | "TRANSACTION_LINES_MISMATCH"
  | "CACHED_LEDGER_MISMATCH"
  | "CACHED_BOOK_MISMATCH"
  | "CACHED_TOTAL_MISMATCH"
  | "HASH_CHAIN_BROKEN"
  | "STALE_OUTSTANDING_ITEM";

export interface Difference {
  code: DifferenceCode;
  /** Blocking differences stop the month from closing. */
  blocking: boolean;
  message: string;
  amount?: Cents;
  ref?: Record<string, string>;
}

export interface OutstandingItem {
  transactionId: string;
  sequence: number;
  kind: TransactionKind;
  effectiveDate: string;
  amount: Cents;
  counterparty: string | null;
  reference: string | null;
  ageDays: number;
}

export interface MatchRecord {
  /** Null for a reversal pair that never reached the bank (the entry and its reversal cancel out). */
  statementLineId: string | null;
  transactionIds: string[];
  how: "manual" | "reference" | "amount_date" | "reversal_pair";
}

export interface LedgerLine {
  subledgerId: string;
  kind: SubledgerKind;
  label: string;
  clientPartyId: string | null;
  matterId: string | null;
  balanceAtPeriodEnd: Cents;
  cachedBalance: Cents;
  recomputedBalance: Cents;
  held: Cents;
}

export interface ReconciliationReport {
  trustAccountId: string;
  period: string;
  periodStart: string;
  periodEnd: string;
  statementId: string;
  bank: {
    openingBalance: Cents;
    closingBalance: Cents;
    depositsInTransit: Cents;
    outstandingWithdrawals: Cents;
    adjustedBalance: Cents;
  };
  bookBalance: Cents;
  clientLedgerTotal: Cents;
  /** The three figures must all agree. */
  threeWay: { bank: Cents; book: Cents; clients: Cents; agree: boolean };
  ledgers: LedgerLine[];
  outstanding: OutstandingItem[];
  matches: MatchRecord[];
  unmatchedBankLines: StatementLineData[];
  ioltaPassThrough: StatementLineData[];
  chain: ChainCheck;
  differences: Difference[];
  balanced: boolean;
  /** Highest transaction sequence included (as of preparation). */
  throughSequence: number;
}

function diff(code: DifferenceCode, message: string, extra: Partial<Difference> = {}): Difference {
  return { code, blocking: code !== "STALE_OUTSTANDING_ITEM", message, ...extra };
}

/** Validate a statement on its own: period, footing (opening + lines = closing). Returns problems. */
export function statementProblems(s: StatementData): Difference[] {
  const out: Difference[] = [];
  const bounds = periodBounds(s.period);
  if (s.periodStart !== bounds.start || s.periodEnd !== bounds.end) {
    out.push(diff("STATEMENT_WRONG_PERIOD", `The statement must cover the calendar month ${s.period} (${bounds.start} to ${bounds.end}).`));
  }
  const footed = s.openingBalance + sumCents(s.lines.map((l) => l.amount));
  if (footed !== s.closingBalance) {
    out.push(
      diff("STATEMENT_DOES_NOT_FOOT", "Opening balance plus the statement lines does not equal the closing balance.", {
        amount: s.closingBalance - footed,
      })
    );
  }
  for (const l of s.lines) {
    if (l.postedOn < s.periodStart || l.postedOn > s.periodEnd) {
      out.push(diff("STATEMENT_LINE_OUTSIDE_PERIOD", `Statement line ${l.lineNo} is dated outside the period.`, { ref: { statementLineId: l.id } }));
    }
  }
  return out;
}

function matchWindowOk(line: StatementLineData, t: BookTransaction, input: ReconciliationInput): boolean {
  const lag = daysBetween(t.effectiveDate, line.postedOn); // bank date − book date
  if (lag < -3) return false; // the bank can't clear an item days before the book says it happened
  return lag <= (t.netAmount > 0n ? input.depositToleranceDays : input.withdrawalClearDays);
}

/** Pure three-way reconciliation. Throws TrustRuleError only for invalid manual matches. */
export function reconcile(input: ReconciliationInput): ReconciliationReport {
  const { statement: st } = input;
  if (st.period !== input.period) throw new TrustRuleError("RECONCILIATION_INVALID", "The statement is for a different period.");
  const { start, end } = periodBounds(input.period);
  const differences: Difference[] = [...statementProblems(st)];

  if (input.previousClosingBalance !== null && input.previousClosingBalance !== st.openingBalance) {
    differences.push(
      diff("STATEMENT_OPENING_MISMATCH", "This statement's opening balance does not equal the previous statement's closing balance.", {
        amount: st.openingBalance - input.previousClosingBalance,
      })
    );
  }

  // --- Ledger integrity -------------------------------------------------
  if (!input.chain.valid) {
    differences.push(
      diff("HASH_CHAIN_BROKEN", `The ledger's tamper-evidence chain is broken at entry #${input.chain.brokenAt?.sequence} (${input.chain.brokenAt?.problem}).`)
    );
  }
  for (const t of input.transactions) {
    const sum = sumCents(t.lines.map((l) => l.amount));
    if (sum !== t.netAmount) {
      differences.push(
        diff("TRANSACTION_LINES_MISMATCH", `Entry #${t.sequence}'s ledger lines do not add up to its register amount.`, {
          amount: t.netAmount - sum,
          ref: { transactionId: t.id },
        })
      );
    }
  }

  // --- Book and client ledgers as of period end ---------------------------
  const inPeriod = input.transactions.filter((t) => t.effectiveDate <= end);
  const bookBalance = sumCents(inPeriod.map((t) => t.netAmount));

  const asOf = new Map<string, Cents>();
  const recomputed = new Map<string, Cents>();
  for (const t of input.transactions) {
    for (const l of t.lines) {
      recomputed.set(l.subledgerId, (recomputed.get(l.subledgerId) ?? 0n) + l.amount);
      if (t.effectiveDate <= end) asOf.set(l.subledgerId, (asOf.get(l.subledgerId) ?? 0n) + l.amount);
    }
  }
  const ledgers: LedgerLine[] = input.ledgers.map((g) => ({
    subledgerId: g.id,
    kind: g.kind,
    label: g.label,
    clientPartyId: g.clientPartyId,
    matterId: g.matterId,
    balanceAtPeriodEnd: asOf.get(g.id) ?? 0n,
    cachedBalance: g.cachedBalance,
    recomputedBalance: recomputed.get(g.id) ?? 0n,
    held: g.cachedHeld,
  }));
  const known = new Set(input.ledgers.map((g) => g.id));
  for (const id of new Set([...asOf.keys(), ...recomputed.keys()])) {
    if (!known.has(id)) {
      ledgers.push({
        subledgerId: id,
        kind: "client_matter",
        label: "(unknown ledger)",
        clientPartyId: null,
        matterId: null,
        balanceAtPeriodEnd: asOf.get(id) ?? 0n,
        cachedBalance: 0n,
        recomputedBalance: recomputed.get(id) ?? 0n,
        held: 0n,
      });
    }
  }
  const clientLedgerTotal = sumCents(ledgers.map((l) => l.balanceAtPeriodEnd));

  for (const l of ledgers) {
    if (l.balanceAtPeriodEnd < 0n) {
      differences.push(
        diff("NEGATIVE_CLIENT_LEDGER", `${l.label} was below zero on ${end} (money was paid out before it was received).`, {
          amount: l.balanceAtPeriodEnd,
          ref: { subledgerId: l.subledgerId },
        })
      );
    }
    if (l.cachedBalance !== l.recomputedBalance) {
      differences.push(
        diff("CACHED_LEDGER_MISMATCH", `${l.label}: the stored running balance does not equal the sum of its entries.`, {
          amount: l.cachedBalance - l.recomputedBalance,
          ref: { subledgerId: l.subledgerId },
        })
      );
    }
  }
  const recomputedBook = sumCents(input.transactions.map((t) => t.netAmount));
  if (input.cachedBookBalance !== recomputedBook) {
    differences.push(
      diff("CACHED_BOOK_MISMATCH", "The stored book balance does not equal the sum of the register.", {
        amount: input.cachedBookBalance - recomputedBook,
      })
    );
  }
  const cachedLedgerSum = sumCents(input.ledgers.map((g) => g.cachedBalance));
  if (cachedLedgerSum !== input.cachedBookBalance) {
    differences.push(
      diff("CACHED_TOTAL_MISMATCH", "The stored client ledger balances do not add up to the stored book balance.", {
        amount: input.cachedBookBalance - cachedLedgerSum,
      })
    );
  }
  if (bookBalance !== clientLedgerTotal) {
    differences.push(
      diff("BOOK_VS_CLIENT_LEDGERS", `The book balance and the sum of client ledgers differ on ${end}.`, {
        amount: bookBalance - clientLedgerTotal,
      })
    );
  }

  // --- Bank ↔ book matching ---------------------------------------------
  const candidates = new Map<string, BookTransaction>();
  for (const t of inPeriod) {
    if (t.netAmount !== 0n && !input.previouslyCleared.has(t.id)) candidates.set(t.id, t);
  }
  const lineById = new Map(st.lines.map((l) => [l.id, l]));
  const matchedLines = new Set<string>();
  const matchedTx = new Set<string>();
  const matches: MatchRecord[] = [];

  for (const m of input.manualMatches ?? []) {
    const line = lineById.get(m.statementLineId);
    if (!line) throw new TrustRuleError("RECONCILIATION_INVALID", "A manual match names a statement line that is not on this statement.");
    if (matchedLines.has(line.id)) throw new TrustRuleError("RECONCILIATION_INVALID", `Statement line ${line.lineNo} is matched twice.`);
    if (m.transactionIds.length === 0) throw new TrustRuleError("RECONCILIATION_INVALID", "A manual match needs at least one entry.");
    let total = 0n;
    for (const id of m.transactionIds) {
      const t = candidates.get(id);
      if (!t || matchedTx.has(id)) {
        throw new TrustRuleError("RECONCILIATION_INVALID", "A manual match names an entry that is not outstanding in this period (or is used twice).", {
          transactionId: id,
        });
      }
      total += t.netAmount;
    }
    if (total !== line.amount) {
      throw new TrustRuleError("RECONCILIATION_INVALID", `Statement line ${line.lineNo}: the matched entries do not add up to the bank amount.`, {
        difference: (line.amount - total).toString(),
      });
    }
    matchedLines.add(line.id);
    for (const id of m.transactionIds) matchedTx.add(id);
    matches.push({ statementLineId: line.id, transactionIds: [...m.transactionIds], how: "manual" });
  }

  const remainingLines = st.lines
    .filter((l) => !matchedLines.has(l.id))
    .sort((a, b) => (a.postedOn === b.postedOn ? a.lineNo - b.lineNo : a.postedOn < b.postedOn ? -1 : 1));
  for (const line of remainingLines) {
    let best: { t: BookTransaction; score: number; how: MatchRecord["how"] } | null = null;
    for (const t of candidates.values()) {
      if (matchedTx.has(t.id) || t.netAmount !== line.amount) continue;
      const refMatch = Boolean(line.reference && t.reference && line.reference.trim().toLowerCase() === t.reference.trim().toLowerCase());
      if (!refMatch && !matchWindowOk(line, t, input)) continue;
      if (refMatch && daysBetween(t.effectiveDate, line.postedOn) < -3) continue;
      const score = refMatch ? -1 : Math.abs(daysBetween(t.effectiveDate, line.postedOn));
      if (!best || score < best.score || (score === best.score && t.sequence < best.t.sequence)) {
        best = { t, score, how: refMatch ? "reference" : "amount_date" };
      }
    }
    if (best) {
      matchedLines.add(line.id);
      matchedTx.add(best.t.id);
      matches.push({ statementLineId: line.id, transactionIds: [best.t.id], how: best.how });
    }
  }

  // An entry and its reversal that both never reached the bank cancel out:
  // they are cleared together instead of sitting "outstanding" forever.
  for (const t of candidates.values()) {
    if (!t.reversesTransactionId || matchedTx.has(t.id)) continue;
    const original = candidates.get(t.reversesTransactionId);
    if (original && !matchedTx.has(original.id) && original.netAmount + t.netAmount === 0n) {
      matchedTx.add(original.id);
      matchedTx.add(t.id);
      matches.push({ statementLineId: null, transactionIds: [original.id, t.id], how: "reversal_pair" });
    }
  }

  // IOLTA interest is remitted to the Texas Access to Justice Foundation, not
  // credited to any client (c75 §3): an interest credit and its remittance
  // that net to zero on the statement are a pass-through, not a difference.
  let unmatched = st.lines.filter((l) => !matchedLines.has(l.id));
  const iolta = unmatched.filter((l) => l.kind === "iolta_interest" || l.kind === "iolta_remittance");
  let ioltaPassThrough: StatementLineData[] = [];
  if (iolta.length > 0 && sumCents(iolta.map((l) => l.amount)) === 0n) {
    ioltaPassThrough = iolta;
    const ids = new Set(iolta.map((l) => l.id));
    unmatched = unmatched.filter((l) => !ids.has(l.id));
  }

  const later = input.transactions.filter((t) => t.effectiveDate > end);
  for (const l of unmatched) {
    const hint = later.find((t) => t.netAmount === l.amount);
    differences.push(
      diff(
        "UNMATCHED_BANK_LINE",
        `Bank line ${l.lineNo} (${l.postedOn}, ${l.description}) has no matching entry in the trust book${
          hint ? ` — entry #${hint.sequence} has the same amount but is dated ${hint.effectiveDate}, after the period end` : ""
        }.`,
        { amount: l.amount, ref: { statementLineId: l.id, ...(hint ? { possibleTransactionId: hint.id } : {}) } }
      )
    );
  }

  // --- Outstanding items and the adjusted bank balance ---------------------
  const outstanding: OutstandingItem[] = [...candidates.values()]
    .filter((t) => !matchedTx.has(t.id))
    .sort((a, b) => a.sequence - b.sequence)
    .map((t) => ({
      transactionId: t.id,
      sequence: t.sequence,
      kind: t.kind,
      effectiveDate: t.effectiveDate,
      amount: t.netAmount,
      counterparty: t.counterparty,
      reference: t.reference,
      ageDays: daysBetween(t.effectiveDate, end),
    }));
  const depositsInTransit = sumCents(outstanding.filter((o) => o.amount > 0n).map((o) => o.amount));
  const outstandingWithdrawals = -sumCents(outstanding.filter((o) => o.amount < 0n).map((o) => o.amount));
  const adjustedBalance = st.closingBalance + depositsInTransit - outstandingWithdrawals;

  for (const o of outstanding) {
    if (o.ageDays > input.staleOutstandingDays) {
      differences.push(
        diff("STALE_OUTSTANDING_ITEM", `Entry #${o.sequence} (${o.effectiveDate}) has not cleared the bank after ${o.ageDays} days.`, {
          amount: o.amount,
          ref: { transactionId: o.transactionId },
        })
      );
    }
  }

  const explainedByUnmatched = sumCents(unmatched.map((l) => l.amount));
  const residual = adjustedBalance - bookBalance - explainedByUnmatched;
  if (residual !== 0n) {
    differences.push(
      diff("UNEXPLAINED_BANK_DIFFERENCE", "The adjusted bank balance differs from the book by an amount no single item explains.", {
        amount: residual,
      })
    );
  }

  const agree = adjustedBalance === bookBalance && bookBalance === clientLedgerTotal;
  const balanced = agree && !differences.some((d) => d.blocking);
  const throughSequence = input.transactions.reduce((m, t) => Math.max(m, t.sequence), 0);

  return {
    trustAccountId: input.trustAccountId,
    period: input.period,
    periodStart: start,
    periodEnd: end,
    statementId: st.id,
    bank: { openingBalance: st.openingBalance, closingBalance: st.closingBalance, depositsInTransit, outstandingWithdrawals, adjustedBalance },
    bookBalance,
    clientLedgerTotal,
    threeWay: { bank: adjustedBalance, book: bookBalance, clients: clientLedgerTotal, agree },
    ledgers: ledgers.sort((a, b) => a.label.localeCompare(b.label)),
    outstanding,
    matches,
    unmatchedBankLines: unmatched,
    ioltaPassThrough,
    chain: input.chain,
    differences,
    balanced,
    throughSequence,
  };
}

/** The hash a signer signs: any later change to the stored worksheet is detectable (canonical JSON survives jsonb). */
export function reportHash(report: ReconciliationReport): string {
  return sha256Hex(canonicalJson(jsonSafe(report)));
}

// ---------------------------------------------------------------------------
// Sign-off and month close
// ---------------------------------------------------------------------------

export interface SignoffCheckInput {
  reconciliation: { status: "balanced" | "unbalanced"; superseded: boolean; periodClosed: boolean };
  role: SignoffRole;
  signerUserId: string;
  existing: ReadonlyArray<{ role: SignoffRole; userId: string }>;
  requiredRoles: ReadonlyArray<SignoffRole>;
}

/** Validate a sign-off; returns whether this sign-off completes the set and closes the month. */
export function validateSignoff(input: SignoffCheckInput): { closesPeriod: boolean } {
  const r = input.reconciliation;
  if (r.periodClosed) throw new TrustRuleError("SIGNOFF_INVALID", "This month is already closed.");
  if (r.superseded) throw new TrustRuleError("SIGNOFF_INVALID", "A newer reconciliation for this month exists; sign that one.");
  if (r.status !== "balanced") {
    throw new TrustRuleError(
      "SIGNOFF_INVALID",
      "This reconciliation does not balance. A month with any difference cannot be signed off or closed; resolve the differences and prepare it again."
    );
  }
  if (!input.requiredRoles.includes(input.role)) {
    throw new TrustRuleError("SIGNOFF_INVALID", `This firm does not use a '${input.role}' sign-off.`);
  }
  if (input.existing.some((e) => e.role === input.role)) {
    throw new TrustRuleError("SIGNOFF_INVALID", `The ${input.role} sign-off is already recorded.`);
  }
  const roles = new Set([...input.existing.map((e) => e.role), input.role]);
  return { closesPeriod: input.requiredRoles.every((r2) => roles.has(r2)) };
}

/** Months close in order: after the first close, only the month right after the latest closed one. */
export function validateCloseOrder(period: string, latestClosedPeriod: string | null): void {
  if (latestClosedPeriod && period !== nextPeriod(latestClosedPeriod)) {
    throw new TrustRuleError(
      "SIGNOFF_INVALID",
      latestClosedPeriod >= period
        ? `This month is already covered by the close of ${latestClosedPeriod}.`
        : `Close ${nextPeriod(latestClosedPeriod)} first; months are closed in order.`
    );
  }
}

/** Date after which an unreconciled month is overdue (firm setting: days after month end). */
export function reconciliationDueDate(period: string, dueDays: number): string {
  return addDays(periodBounds(period).end, dueDays);
}
