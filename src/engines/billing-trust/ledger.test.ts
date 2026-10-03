import { describe, expect, it } from "vitest";
import {
  applyHold,
  applyPlan,
  available,
  checkInvariants,
  clientDeltas,
  planHold,
  planTransaction,
  retainerFloorSplit,
  type TransactionInput,
} from "./ledger";
import { TrustRuleError, type TrustRuleCode } from "./types";
import { A1, A2, ACCOUNT, B1, CLIENT_A, CTX, CUSHION, OTHER_ACCOUNT, standardAccount, sub, account } from "./testFixtures";

function input(over: Partial<TransactionInput>): TransactionInput {
  return { kind: "deposit", trustAccountId: ACCOUNT, effectiveDate: "2026-10-01", reason: "Retainer received", ...over };
}

function code(fn: () => unknown): TrustRuleCode | null {
  try {
    fn();
    return null;
  } catch (err) {
    if (err instanceof TrustRuleError) return err.code;
    throw err;
  }
}

describe("planTransaction — deposits", () => {
  it("deposits client money to a client-matter ledger and moves the book by the same amount", () => {
    const s = standardAccount();
    const plan = planTransaction(s, input({ subledgerId: A1, amount: 500_000n, fundsSource: "client" }), CTX);
    expect(plan.sequence).toBe(1);
    expect(plan.netAmount).toBe(500_000n);
    expect(plan.lines).toEqual([{ lineNo: 1, subledgerId: A1, amount: 500_000n, balanceAfter: 500_000n, bookBalanceAfter: 500_000n }]);
    const next = applyPlan(s, plan, "h1");
    expect(next.subledgers.get(A1)!.balance).toBe(500_000n);
    expect(next.bookBalance).toBe(500_000n);
    expect(next.lastSequence).toBe(1);
    expect(next.lastHash).toBe("h1");
    expect(checkInvariants(next)).toEqual([]);
    // input state is never mutated
    expect(s.subledgers.get(A1)!.balance).toBe(0n);
  });

  it("refuses firm money on a client ledger (commingling)", () => {
    expect(code(() => planTransaction(standardAccount(), input({ subledgerId: A1, amount: 1n, fundsSource: "firm_operating" }), CTX))).toBe("COMMINGLING");
  });

  it("requires the source of funds", () => {
    expect(code(() => planTransaction(standardAccount(), input({ subledgerId: A1, amount: 1n }), CTX))).toBe("FUNDS_SOURCE_REQUIRED");
  });

  it("refuses a deposit with a processor fee netted out", () => {
    expect(
      code(() => planTransaction(standardAccount(), input({ subledgerId: A1, amount: 9_700n, fundsSource: "client", processorFeeCents: 300n }), CTX))
    ).toBe("PROCESSOR_FEE_NETTED");
  });

  it("refuses a client deposit into the firm cushion", () => {
    expect(code(() => planTransaction(standardAccount(), input({ subledgerId: CUSHION, amount: 1n, fundsSource: "client" }), CTX))).toBe(
      "WRONG_SUBLEDGER_KIND"
    );
  });

  it.each([
    [0n, "INVALID_AMOUNT"],
    [-5n, "INVALID_AMOUNT"],
    [100_000_000_000_001n, "INVALID_AMOUNT"],
  ] as const)("refuses amount %s", (amount, expected) => {
    expect(code(() => planTransaction(standardAccount(), input({ subledgerId: A1, amount, fundsSource: "client" }), CTX))).toBe(expected);
  });

  it("requires an amount", () => {
    expect(code(() => planTransaction(standardAccount(), input({ subledgerId: A1, fundsSource: "client" }), CTX))).toBe("INVALID_AMOUNT");
  });
});

describe("planTransaction — common rules", () => {
  const ok = { subledgerId: A1, amount: 100n, fundsSource: "client" as const };

  it("requires a reason", () => {
    expect(code(() => planTransaction(standardAccount(), input({ ...ok, reason: "  " }), CTX))).toBe("REASON_REQUIRED");
  });

  it("rejects invalid and future dates", () => {
    expect(code(() => planTransaction(standardAccount(), input({ ...ok, effectiveDate: "2026-02-30" }), CTX))).toBe("INVALID_DATE");
    expect(code(() => planTransaction(standardAccount(), input({ ...ok, effectiveDate: "2026-10-03" }), CTX))).toBe("FUTURE_DATE");
  });

  it("refuses entries dated in a closed period, but allows the first open day", () => {
    const s = standardAccount({}, { closedThrough: "2026-08-31" });
    expect(code(() => planTransaction(s, input({ ...ok, effectiveDate: "2026-08-31" }), CTX))).toBe("PERIOD_CLOSED");
    expect(code(() => planTransaction(s, input({ ...ok, effectiveDate: "2026-09-01" }), CTX))).toBeNull();
  });

  it("refuses postings to a closed account or a different account", () => {
    expect(code(() => planTransaction(standardAccount({}, { status: "closed" }), input(ok), CTX))).toBe("ACCOUNT_CLOSED");
    expect(code(() => planTransaction(standardAccount(), input({ ...ok, trustAccountId: OTHER_ACCOUNT }), CTX))).toBe("WRONG_ACCOUNT");
  });

  it("refuses an unknown ledger and a ledger of another account", () => {
    expect(code(() => planTransaction(standardAccount(), input({ ...ok, subledgerId: "nope" }), CTX))).toBe("UNKNOWN_SUBLEDGER");
    const foreign = account([sub(A1, CLIENT_A, 0n, 0n, OTHER_ACCOUNT)]);
    expect(code(() => planTransaction(foreign, input(ok), CTX))).toBe("WRONG_ACCOUNT");
  });

  it("refuses fields that do not apply to the kind", () => {
    expect(code(() => planTransaction(standardAccount(), input({ ...ok, toSubledgerId: A2 }), CTX))).toBe("UNEXPECTED_FIELD");
    expect(code(() => planTransaction(standardAccount(), input({ ...ok, earnedBasis: "x" }), CTX))).toBe("UNEXPECTED_FIELD");
  });

  it("keeps the invoice id the entry pays (extension point for invoicing)", () => {
    const plan = planTransaction(standardAccount(), input({ ...ok, invoiceId: "inv-1" }), CTX);
    expect(plan.invoiceId).toBe("inv-1");
  });
});

describe("planTransaction — money out", () => {
  const funded = () => standardAccount({ a1: 100_000n, a2: 50_000n, b1: 900_000n });

  it("never lets a client ledger go below zero, even when the pooled account has plenty", () => {
    const s = funded();
    expect(s.bookBalance).toBe(1_050_000n);
    expect(
      code(() => planTransaction(s, input({ kind: "disbursement", subledgerId: A1, amount: 100_001n, counterparty: "Court clerk" }), CTX))
    ).toBe("INSUFFICIENT_FUNDS");
    expect(code(() => planTransaction(s, input({ kind: "refund", subledgerId: A1, amount: 100_001n }), CTX))).toBe("INSUFFICIENT_FUNDS");
    expect(code(() => planTransaction(s, input({ kind: "earned_fee_transfer", subledgerId: A1, amount: 100_001n, invoiceId: "i" }), CTX))).toBe(
      "INSUFFICIENT_FUNDS"
    );
  });

  it("allows taking a ledger exactly to zero", () => {
    const s = funded();
    const plan = planTransaction(s, input({ kind: "refund", subledgerId: A1, amount: 100_000n }), CTX);
    expect(plan.lines[0]!.balanceAfter).toBe(0n);
    expect(plan.counterparty).toBe("Client");
    expect(checkInvariants(applyPlan(s, plan))).toEqual([]);
  });

  it("requires a payee on disbursements", () => {
    expect(code(() => planTransaction(funded(), input({ kind: "disbursement", subledgerId: A1, amount: 1n }), CTX))).toBe("PAYEE_REQUIRED");
  });

  it("moves earned fees only with an invoice or a stated earning benchmark", () => {
    expect(code(() => planTransaction(funded(), input({ kind: "earned_fee_transfer", subledgerId: A1, amount: 1n }), CTX))).toBe(
      "EARNED_BASIS_REQUIRED"
    );
    const plan = planTransaction(funded(), input({ kind: "earned_fee_transfer", subledgerId: A1, amount: 1n, earnedBasis: "Petition filed (25%)" }), CTX);
    expect(plan.counterparty).toBe("Firm operating account");
    expect(plan.netAmount).toBe(-1n);
  });

  it("refuses a disbursement from the firm cushion and bank fees from a client ledger", () => {
    const s = standardAccount({ a1: 1_000n, cushion: 1_000n });
    expect(code(() => planTransaction(s, input({ kind: "disbursement", subledgerId: CUSHION, amount: 1n, counterparty: "X" }), CTX))).toBe(
      "WRONG_SUBLEDGER_KIND"
    );
    expect(code(() => planTransaction(s, input({ kind: "bank_fee", subledgerId: A1, amount: 1n }), CTX))).toBe("WRONG_SUBLEDGER_KIND");
    const fee = planTransaction(s, input({ kind: "bank_fee", subledgerId: CUSHION, amount: 1_000n }), CTX);
    expect(fee.counterparty).toBe("Bank");
  });

  it("refuses moving funds that are on hold for a dispute", () => {
    let s = funded();
    const hold = planHold(s, { subledgerId: A1, amount: 60_000n, reason: "Fee disputed by client" });
    s = applyHold(s, A1, hold.amount);
    expect(available(s.subledgers.get(A1)!)).toBe(40_000n);
    expect(code(() => planTransaction(s, input({ kind: "refund", subledgerId: A1, amount: 40_001n }), CTX))).toBe("FUNDS_ON_HOLD");
    expect(code(() => planTransaction(s, input({ kind: "refund", subledgerId: A1, amount: 40_000n }), CTX))).toBeNull();
  });
});

describe("planTransaction — transfers between matters", () => {
  it("moves money between two matters of the same client, netting to zero", () => {
    const s = standardAccount({ a1: 10_000n });
    const plan = planTransaction(s, input({ kind: "transfer", subledgerId: A1, toSubledgerId: A2, amount: 4_000n }), CTX);
    expect(plan.netAmount).toBe(0n);
    expect(plan.lines.map((l) => [l.subledgerId, l.amount, l.balanceAfter])).toEqual([
      [A1, -4_000n, 6_000n],
      [A2, 4_000n, 4_000n],
    ]);
    expect(plan.bookBalanceAfter).toBe(10_000n);
    expect(clientDeltas(s, plan).get(CLIENT_A)).toBe(0n);
  });

  it("never moves one client's money to another client", () => {
    const s = standardAccount({ a1: 10_000n });
    expect(code(() => planTransaction(s, input({ kind: "transfer", subledgerId: A1, toSubledgerId: B1, amount: 1n }), CTX))).toBe("CROSS_CLIENT");
    expect(code(() => planTransaction(s, input({ kind: "transfer", subledgerId: A1, toSubledgerId: CUSHION, amount: 1n }), CTX))).toBe(
      "WRONG_SUBLEDGER_KIND"
    );
  });

  it("refuses a transfer to itself and an overdrawing transfer", () => {
    const s = standardAccount({ a1: 10_000n });
    expect(code(() => planTransaction(s, input({ kind: "transfer", subledgerId: A1, toSubledgerId: A1, amount: 1n }), CTX))).toBe("SAME_SUBLEDGER");
    expect(code(() => planTransaction(s, input({ kind: "transfer", subledgerId: A1, toSubledgerId: A2, amount: 10_001n }), CTX))).toBe(
      "INSUFFICIENT_FUNDS"
    );
  });
});

describe("planTransaction — firm bank-fee cushion (gated)", () => {
  const cushionInput = input({ kind: "cushion_deposit", subledgerId: CUSHION, amount: 5_000n, reason: "Bank fee cushion" });

  it("is refused while the cushion rule is not approved, even with a cap", () => {
    expect(code(() => planTransaction(standardAccount({}, { cushionCap: 10_000n }), cushionInput, CTX))).toBe("CUSHION_NOT_ALLOWED");
  });

  it("is refused without a configured cap", () => {
    expect(code(() => planTransaction(standardAccount(), cushionInput, { ...CTX, cushionRuleApproved: true }))).toBe("CUSHION_NOT_ALLOWED");
  });

  it("is allowed up to the cap once approved, and never above it", () => {
    const ctx = { ...CTX, cushionRuleApproved: true };
    const s = standardAccount({ cushion: 6_000n }, { cushionCap: 10_000n });
    expect(code(() => planTransaction(s, cushionInput, ctx))).toBe("CUSHION_CAP_EXCEEDED");
    const plan = planTransaction(s, { ...cushionInput, amount: 4_000n }, ctx);
    expect(plan.fundsSource).toBe("firm_operating");
    expect(plan.lines[0]!.balanceAfter).toBe(10_000n);
  });

  it("refuses client money into the cushion", () => {
    expect(
      code(() =>
        planTransaction(standardAccount({}, { cushionCap: 10_000n }), { ...cushionInput, fundsSource: "client" }, { ...CTX, cushionRuleApproved: true })
      )
    ).toBe("COMMINGLING");
  });
});

describe("planTransaction — reversals (corrections)", () => {
  const original = { id: "t1", trustAccountId: ACCOUNT, kind: "deposit" as const, lines: [{ subledgerId: A1, amount: 5_000n }], reversedById: null };

  it("reverses an entry exactly", () => {
    const s = standardAccount({ a1: 5_000n });
    const plan = planTransaction(s, input({ kind: "reversal", reversesTransactionId: "t1", reason: "Check bounced" }), { ...CTX, original });
    expect(plan.lines).toEqual([{ lineNo: 1, subledgerId: A1, amount: -5_000n, balanceAfter: 0n, bookBalanceAfter: 0n }]);
    expect(plan.reversesTransactionId).toBe("t1");
  });

  it("refuses a reversal that would overdraw (the money was already spent)", () => {
    const s = standardAccount({ a1: 1_000n, b1: 9_000n });
    expect(code(() => planTransaction(s, input({ kind: "reversal", reversesTransactionId: "t1" }), { ...CTX, original }))).toBe("INSUFFICIENT_FUNDS");
  });

  it("refuses reversing twice, reversing a reversal, a missing original, or extra fields", () => {
    const s = standardAccount({ a1: 5_000n });
    const r = input({ kind: "reversal", reversesTransactionId: "t1" });
    expect(code(() => planTransaction(s, r, { ...CTX, original: { ...original, reversedById: "t2" } }))).toBe("ALREADY_REVERSED");
    expect(code(() => planTransaction(s, r, { ...CTX, original: { ...original, kind: "reversal" } }))).toBe("REVERSAL_INVALID");
    expect(code(() => planTransaction(s, r, CTX))).toBe("REVERSAL_INVALID");
    expect(code(() => planTransaction(s, { ...r, amount: 5n }, { ...CTX, original }))).toBe("UNEXPECTED_FIELD");
    expect(code(() => planTransaction(s, r, { ...CTX, original: { ...original, trustAccountId: OTHER_ACCOUNT } }))).toBe("REVERSAL_INVALID");
  });

  it("reverses a transfer back across both matters", () => {
    const s = standardAccount({ a1: 6_000n, a2: 4_000n });
    const plan = planTransaction(s, input({ kind: "reversal", reversesTransactionId: "t9" }), {
      ...CTX,
      original: {
        id: "t9",
        trustAccountId: ACCOUNT,
        kind: "transfer",
        lines: [
          { subledgerId: A1, amount: -4_000n },
          { subledgerId: A2, amount: 4_000n },
        ],
        reversedById: null,
      },
    });
    expect(plan.netAmount).toBe(0n);
    const next = applyPlan(s, plan);
    expect(next.subledgers.get(A1)!.balance).toBe(10_000n);
    expect(next.subledgers.get(A2)!.balance).toBe(0n);
  });
});

describe("retainer floor (c50 extension point)", () => {
  it("splits an invoice between trust (down to the floor) and a direct bill", () => {
    expect(retainerFloorSplit({ balance: 600_000n, held: 0n }, 450_000n, 200_000n)).toEqual({ fromTrust: 150_000n, billDirect: 50_000n });
    expect(retainerFloorSplit({ balance: 400_000n, held: 0n }, 450_000n, 10_000n)).toEqual({ fromTrust: 0n, billDirect: 10_000n });
    expect(retainerFloorSplit({ balance: 900_000n, held: 0n }, 450_000n, 10_000n)).toEqual({ fromTrust: 10_000n, billDirect: 0n });
  });

  it("refuses an earned-fee transfer below the floor when a floor applies", () => {
    const s = standardAccount({ a1: 600_000n });
    const ctx = { ...CTX, retainerFloors: new Map([[A1, 450_000n]]) };
    try {
      planTransaction(s, input({ kind: "earned_fee_transfer", subledgerId: A1, amount: 200_000n, invoiceId: "inv" }), ctx);
      expect.unreachable();
    } catch (err) {
      expect((err as TrustRuleError).code).toBe("BELOW_RETAINER_FLOOR");
      expect((err as TrustRuleError).details).toMatchObject({ fromTrust: "150000", billDirect: "50000" });
    }
    expect(code(() => planTransaction(s, input({ kind: "earned_fee_transfer", subledgerId: A1, amount: 150_000n, invoiceId: "inv" }), ctx))).toBeNull();
  });
});

describe("holds", () => {
  it("only on client ledgers, with a reason, never more than the unheld balance", () => {
    const s = standardAccount({ a1: 1_000n, cushion: 500n });
    expect(code(() => planHold(s, { subledgerId: CUSHION, amount: 1n, reason: "dispute" }))).toBe("WRONG_SUBLEDGER_KIND");
    expect(code(() => planHold(s, { subledgerId: A1, amount: 1n, reason: "" }))).toBe("REASON_REQUIRED");
    expect(code(() => planHold(s, { subledgerId: A1, amount: 1_001n, reason: "Lien dispute" }))).toBe("HOLD_INVALID");
    expect(code(() => planHold(s, { subledgerId: A1, amount: 0n, reason: "Lien dispute" }))).toBe("INVALID_AMOUNT");
    const ok = planHold(s, { subledgerId: A1, amount: 1_000n, reason: "Lien dispute" });
    expect(ok.heldAfter).toBe(1_000n);
  });

  it("applyHold refuses out-of-range holds", () => {
    const s = standardAccount({ a1: 1_000n });
    expect(() => applyHold(s, A1, 1_001n)).toThrow();
    expect(() => applyHold(s, A1, -1n)).toThrow();
  });
});

describe("checkInvariants", () => {
  it("reports a book that does not equal the ledgers, negatives and over-holds", () => {
    const s = account([sub(A1, CLIENT_A, -1n), sub(A2, CLIENT_A, 5n, 6n)], { bookBalance: 10n });
    const problems = checkInvariants(s);
    expect(problems.some((p) => p.startsWith("I1"))).toBe(true);
    expect(problems.some((p) => p.startsWith("I2"))).toBe(true);
    expect(problems.some((p) => p.startsWith("I3"))).toBe(true);
  });

  it("applyPlan refuses a stale plan", () => {
    const s = standardAccount();
    const plan = planTransaction(s, input({ subledgerId: A1, amount: 1n, fundsSource: "client" }), CTX);
    const next = applyPlan(s, plan);
    expect(() => applyPlan(next, plan)).toThrow(/stale/);
  });
});
