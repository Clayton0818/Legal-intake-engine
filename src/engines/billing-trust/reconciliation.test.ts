import { describe, expect, it } from "vitest";
import {
  reconcile,
  reconciliationDueDate,
  reportHash,
  statementProblems,
  validateCloseOrder,
  validateSignoff,
  type BookTransaction,
  type LedgerSnapshot,
  type ReconciliationInput,
  type StatementData,
  type StatementLineData,
} from "./reconciliation";
import { TrustRuleError } from "./types";
import { A1, B1, prng } from "./testFixtures";

const OK_CHAIN = { valid: true, checked: 0, brokenAt: null };

function tx(id: string, sequence: number, effectiveDate: string, lines: [string, bigint][], over: Partial<BookTransaction> = {}): BookTransaction {
  const net = lines.reduce((s, [, a]) => s + a, 0n);
  return {
    id,
    sequence,
    kind: net > 0n ? "deposit" : net < 0n ? "disbursement" : "transfer",
    effectiveDate,
    netAmount: net,
    reference: null,
    counterparty: null,
    reason: "r",
    reversesTransactionId: null,
    lines: lines.map(([subledgerId, amount]) => ({ subledgerId, amount })),
    ...over,
  };
}

function line(id: string, lineNo: number, postedOn: string, amount: bigint, over: Partial<StatementLineData> = {}): StatementLineData {
  return { id, lineNo, postedOn, amount, description: `line ${lineNo}`, reference: null, kind: amount > 0n ? "deposit" : "withdrawal", ...over };
}

function statement(lines: StatementLineData[], opening = 0n, over: Partial<StatementData> = {}): StatementData {
  return {
    id: "st-1",
    period: "2026-09",
    periodStart: "2026-09-01",
    periodEnd: "2026-09-30",
    openingBalance: opening,
    closingBalance: opening + lines.reduce((s, l) => s + l.amount, 0n),
    lines,
    ...over,
  };
}

function ledgersFrom(txs: BookTransaction[]): LedgerSnapshot[] {
  const bal = new Map<string, bigint>([
    [A1, 0n],
    [B1, 0n],
  ]);
  for (const t of txs) for (const l of t.lines) bal.set(l.subledgerId, (bal.get(l.subledgerId) ?? 0n) + l.amount);
  return [...bal.entries()].map(([id, b]) => ({ id, kind: "client_matter", label: id === A1 ? "Alpha / Divorce" : "Beta / Custody", clientPartyId: id, matterId: id, cachedBalance: b, cachedHeld: 0n }));
}

function base(txs: BookTransaction[], st: StatementData, over: Partial<ReconciliationInput> = {}): ReconciliationInput {
  return {
    trustAccountId: "acct",
    period: "2026-09",
    statement: st,
    previousClosingBalance: null,
    transactions: txs,
    ledgers: ledgersFrom(txs),
    cachedBookBalance: txs.reduce((s, t) => s + t.netAmount, 0n),
    previouslyCleared: new Set(),
    chain: OK_CHAIN,
    depositToleranceDays: 5,
    withdrawalClearDays: 180,
    staleOutstandingDays: 90,
    ...over,
  };
}

describe("three-way reconciliation", () => {
  it("balances when bank, book and client ledgers agree", () => {
    const txs = [tx("t1", 1, "2026-09-02", [[A1, 500_000n]]), tx("t2", 2, "2026-09-10", [[B1, 100_000n]]), tx("t3", 3, "2026-09-20", [[A1, -20_000n]])];
    const st = statement([line("l1", 1, "2026-09-03", 500_000n), line("l2", 2, "2026-09-11", 100_000n), line("l3", 3, "2026-09-25", -20_000n)]);
    const r = reconcile(base(txs, st));
    expect(r.differences).toEqual([]);
    expect(r.balanced).toBe(true);
    expect(r.threeWay).toEqual({ bank: 580_000n, book: 580_000n, clients: 580_000n, agree: true });
    expect(r.matches).toHaveLength(3);
    expect(r.outstanding).toEqual([]);
    expect(r.throughSequence).toBe(3);
  });

  it("treats uncleared items as deposits in transit / outstanding checks", () => {
    const txs = [tx("t1", 1, "2026-09-02", [[A1, 500_000n]]), tx("t2", 2, "2026-09-29", [[B1, 100_000n]]), tx("t3", 3, "2026-09-28", [[A1, -20_000n]], { reference: "1001" })];
    const st = statement([line("l1", 1, "2026-09-03", 500_000n)]);
    const r = reconcile(base(txs, st));
    expect(r.balanced).toBe(true);
    expect(r.bank).toMatchObject({ closingBalance: 500_000n, depositsInTransit: 100_000n, outstandingWithdrawals: 20_000n, adjustedBalance: 580_000n });
    expect(r.outstanding.map((o) => o.transactionId)).toEqual(["t2", "t3"]);
  });

  it("itemises a bank fee missing from the book and blocks the month", () => {
    const txs = [tx("t1", 1, "2026-09-02", [[A1, 500_000n]])];
    const st = statement([line("l1", 1, "2026-09-03", 500_000n), line("l2", 2, "2026-09-30", -1_500n, { kind: "fee", description: "Service charge" })]);
    const r = reconcile(base(txs, st));
    expect(r.balanced).toBe(false);
    const codes = r.differences.map((d) => d.code);
    expect(codes).toEqual(["UNMATCHED_BANK_LINE"]);
    expect(r.differences[0]!.amount).toBe(-1_500n);
    expect(r.threeWay.agree).toBe(false);
  });

  it("reports an unexplained residual when the statement opening is off", () => {
    const txs = [tx("t1", 1, "2026-09-02", [[A1, 500_000n]])];
    const st = statement([line("l1", 1, "2026-09-03", 500_000n)], 7n);
    const r = reconcile(base(txs, st, { previousClosingBalance: 0n }));
    expect(r.differences.map((d) => d.code).sort()).toEqual(["STATEMENT_OPENING_MISMATCH", "UNEXPLAINED_BANK_DIFFERENCE"]);
    expect(r.differences.find((d) => d.code === "UNEXPLAINED_BANK_DIFFERENCE")!.amount).toBe(7n);
  });

  it("flags a statement that does not foot or covers the wrong dates", () => {
    const st = statement([line("l1", 1, "2026-10-01", 5n)], 0n, { closingBalance: 4n });
    const codes = statementProblems(st).map((d) => d.code);
    expect(codes).toContain("STATEMENT_DOES_NOT_FOOT");
    expect(codes).toContain("STATEMENT_LINE_OUTSIDE_PERIOD");
    expect(statementProblems({ ...statement([]), periodStart: "2026-09-02" }).map((d) => d.code)).toEqual(["STATEMENT_WRONG_PERIOD"]);
  });

  it("detects a client ledger that was negative at period end (money spent before it arrived)", () => {
    const txs = [tx("t1", 1, "2026-09-20", [[A1, -10_000n]]), tx("t2", 2, "2026-10-01", [[A1, 10_000n]])];
    const st = statement([line("l1", 1, "2026-09-21", -10_000n)]);
    const r = reconcile(base(txs, st));
    expect(r.differences.map((d) => d.code)).toContain("NEGATIVE_CLIENT_LEDGER");
    expect(r.balanced).toBe(false);
  });

  it("detects tampering: cached balances, register vs lines, and the hash chain", () => {
    const txs = [tx("t1", 1, "2026-09-02", [[A1, 500n]])];
    const st = statement([line("l1", 1, "2026-09-03", 500n)]);
    const ledgers = ledgersFrom(txs).map((l) => (l.id === A1 ? { ...l, cachedBalance: 900n } : l));
    const r = reconcile(
      base([{ ...txs[0]!, netAmount: 500n, lines: [{ subledgerId: A1, amount: 400n }] }], st, {
        ledgers,
        cachedBookBalance: 600n,
        chain: { valid: false, checked: 0, brokenAt: { sequence: 1, problem: "hash_mismatch" } },
      })
    );
    const codes = r.differences.map((d) => d.code);
    for (const c of ["HASH_CHAIN_BROKEN", "TRANSACTION_LINES_MISMATCH", "CACHED_LEDGER_MISMATCH", "CACHED_BOOK_MISMATCH", "CACHED_TOTAL_MISMATCH", "BOOK_VS_CLIENT_LEDGERS"]) {
      expect(codes).toContain(c);
    }
    expect(r.balanced).toBe(false);
  });

  it("hints when a bank line matches an entry dated after period end", () => {
    const txs = [tx("t1", 1, "2026-10-01", [[A1, 500n]])];
    const st = statement([line("l1", 1, "2026-09-30", 500n)]);
    const r = reconcile(base(txs, st));
    const d = r.differences.find((x) => x.code === "UNMATCHED_BANK_LINE")!;
    expect(d.ref?.possibleTransactionId).toBe("t1");
  });

  it("does not re-match items cleared in an earlier month", () => {
    const txs = [tx("t0", 1, "2026-08-20", [[A1, 500n]]), tx("t1", 2, "2026-09-02", [[A1, 500n]])];
    const st = statement([line("l1", 1, "2026-09-03", 500n)], 500n);
    const r = reconcile(base(txs, st, { previouslyCleared: new Set(["t0"]), previousClosingBalance: 500n }));
    expect(r.balanced).toBe(true);
    expect(r.matches[0]!.transactionIds).toEqual(["t1"]);
  });

  it("prefers a reference match and respects the date window", () => {
    const txs = [
      tx("t1", 1, "2026-09-01", [[A1, -300n]], { reference: "1002" }),
      tx("t2", 2, "2026-09-01", [[A1, -300n]], { reference: "1001" }),
      tx("t3", 3, "2026-09-25", [[B1, 900n]]),
    ];
    const st = statement([line("l1", 1, "2026-09-20", -300n, { reference: "1001" }), line("l2", 2, "2026-09-10", 900n)], 1_000n);
    const r = reconcile(base(txs, st, { previouslyCleared: new Set(), ledgers: ledgersFrom(txs) }));
    expect(r.matches.find((m) => m.statementLineId === "l1")!.transactionIds).toEqual(["t2"]);
    // l2 posted 15 days BEFORE the book date: not a match.
    expect(r.unmatchedBankLines.map((l) => l.id)).toEqual(["l2"]);
  });

  it("accepts a valid manual match of several entries to one bank deposit and rejects bad ones", () => {
    const txs = [tx("t1", 1, "2026-09-02", [[A1, 300n]]), tx("t2", 2, "2026-09-02", [[B1, 200n]])];
    const st = statement([line("l1", 1, "2026-09-03", 500n)]);
    const r = reconcile(base(txs, st, { manualMatches: [{ statementLineId: "l1", transactionIds: ["t1", "t2"] }] }));
    expect(r.balanced).toBe(true);
    expect(r.matches[0]!.how).toBe("manual");
    expect(() => reconcile(base(txs, st, { manualMatches: [{ statementLineId: "l1", transactionIds: ["t1"] }] }))).toThrow(TrustRuleError);
    expect(() => reconcile(base(txs, st, { manualMatches: [{ statementLineId: "x", transactionIds: ["t1"] }] }))).toThrow(TrustRuleError);
    expect(() => reconcile(base(txs, st, { manualMatches: [{ statementLineId: "l1", transactionIds: ["t1", "t1"] }] }))).toThrow(TrustRuleError);
  });

  it("treats IOLTA interest and its remittance to the Foundation as a pass-through", () => {
    const txs = [tx("t1", 1, "2026-09-02", [[A1, 500n]])];
    const st = statement([
      line("l1", 1, "2026-09-03", 500n),
      line("l2", 2, "2026-09-30", 12n, { kind: "iolta_interest" }),
      line("l3", 3, "2026-09-30", -12n, { kind: "iolta_remittance" }),
    ]);
    const r = reconcile(base(txs, st));
    expect(r.balanced).toBe(true);
    expect(r.ioltaPassThrough).toHaveLength(2);
    const unbalancedInterest = reconcile(base(txs, statement([line("l1", 1, "2026-09-03", 500n), line("l2", 2, "2026-09-30", 12n, { kind: "iolta_interest" })])));
    expect(unbalancedInterest.balanced).toBe(false);
  });

  it("clears an entry and its reversal that never reached the bank together", () => {
    const txs = [
      tx("t1", 1, "2026-09-02", [[A1, 500n]]),
      tx("t2", 2, "2026-09-03", [[A1, -500n]], { kind: "reversal", reversesTransactionId: "t1" }),
    ];
    const r = reconcile(base(txs, statement([])));
    expect(r.balanced).toBe(true);
    expect(r.outstanding).toEqual([]);
    expect(r.matches[0]).toMatchObject({ statementLineId: null, how: "reversal_pair" });
  });

  it("warns (without blocking) on stale outstanding items", () => {
    const txs = [tx("t1", 1, "2026-05-01", [[A1, -500n]], { reference: "999" }), tx("t0", 0, "2026-04-01", [[A1, 1_000n]])];
    const r = reconcile(base(txs, statement([], 1_000n), { previouslyCleared: new Set(["t0"]) }));
    expect(r.differences.map((d) => d.code)).toEqual(["STALE_OUTSTANDING_ITEM"]);
    expect(r.differences[0]!.blocking).toBe(false);
    expect(r.balanced).toBe(true);
  });

  it("property: a consistent random month always balances; any single extra bank line never does", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const r = prng(seed);
      const txs: BookTransaction[] = [];
      const lines: StatementLineData[] = [];
      const bal = new Map<string, bigint>([
        [A1, 0n],
        [B1, 0n],
      ]);
      for (let i = 1; i <= 25; i++) {
        const sub = r() < 0.5 ? A1 : B1;
        const day = 1 + Math.floor(r() * 28);
        const date = `2026-09-${String(day).padStart(2, "0")}`;
        let amount = BigInt(1 + Math.floor(r() * 50_000));
        if (r() < 0.4 && bal.get(sub)! >= amount) amount = -amount;
        bal.set(sub, bal.get(sub)! + amount);
        txs.push(tx(`t${i}`, i, date, [[sub, amount]], { reference: `r${i}` }));
        if (r() < 0.8) lines.push(line(`l${i}`, lines.length + 1, date, amount, { reference: `r${i}` }));
      }
      const balancedRun = reconcile(base(txs, statement(lines)));
      expect(balancedRun.balanced, `seed ${seed}: ${JSON.stringify(balancedRun.differences.map((d) => d.code))}`).toBe(true);
      const extra = line("lx", lines.length + 1, "2026-09-30", -BigInt(1 + Math.floor(r() * 999)), { kind: "fee" });
      expect(reconcile(base(txs, statement([...lines, extra]))).balanced, `seed ${seed} with extra line`).toBe(false);
    }
  });

  it("report hash is stable and changes with content", () => {
    const txs = [tx("t1", 1, "2026-09-02", [[A1, 500n]])];
    const a = reconcile(base(txs, statement([line("l1", 1, "2026-09-03", 500n)])));
    const b = reconcile(base(txs, statement([line("l1", 1, "2026-09-03", 500n)])));
    expect(reportHash(a)).toBe(reportHash(b));
    expect(reportHash({ ...a, bookBalance: 1n })).not.toBe(reportHash(a));
  });

  it("rejects a statement for another period", () => {
    expect(() => reconcile(base([], statement([]), { period: "2026-08" }))).toThrow(TrustRuleError);
  });
});

describe("sign-off and month close", () => {
  const balanced = { status: "balanced" as const, superseded: false, periodClosed: false };
  const roles = ["bookkeeper", "lawyer"] as const;

  it("needs every required role before the month closes", () => {
    expect(validateSignoff({ reconciliation: balanced, role: "bookkeeper", signerUserId: "u1", existing: [], requiredRoles: roles })).toEqual({ closesPeriod: false });
    expect(
      validateSignoff({ reconciliation: balanced, role: "lawyer", signerUserId: "u2", existing: [{ role: "bookkeeper", userId: "u1" }], requiredRoles: roles })
    ).toEqual({ closesPeriod: true });
  });

  it("refuses unbalanced, superseded, closed, duplicate or unused-role sign-offs", () => {
    const t = (over: object) => () => validateSignoff({ reconciliation: balanced, role: "lawyer", signerUserId: "u", existing: [], requiredRoles: roles, ...over });
    expect(t({ reconciliation: { ...balanced, status: "unbalanced" } })).toThrow(/does not balance/);
    expect(t({ reconciliation: { ...balanced, superseded: true } })).toThrow(TrustRuleError);
    expect(t({ reconciliation: { ...balanced, periodClosed: true } })).toThrow(TrustRuleError);
    expect(t({ existing: [{ role: "lawyer", userId: "x" }] })).toThrow(TrustRuleError);
    expect(t({ requiredRoles: ["bookkeeper"] })).toThrow(TrustRuleError);
  });

  it("closes months in order", () => {
    expect(() => validateCloseOrder("2026-09", null)).not.toThrow();
    expect(() => validateCloseOrder("2026-09", "2026-08")).not.toThrow();
    expect(() => validateCloseOrder("2027-01", "2026-12")).not.toThrow();
    expect(() => validateCloseOrder("2026-10", "2026-08")).toThrow(/first/);
    expect(() => validateCloseOrder("2026-08", "2026-08")).toThrow(/already/);
  });

  it("computes the due date from the month end", () => {
    expect(reconciliationDueDate("2026-09", 15)).toBe("2026-10-15");
    expect(reconciliationDueDate("2026-02", 10)).toBe("2026-03-10");
  });
});
