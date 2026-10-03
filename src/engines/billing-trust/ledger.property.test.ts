// Property-style tests: thousands of random operation sequences (valid and
// invalid) against the pure ledger. After EVERY step the invariants must hold,
// a refused operation must leave the state untouched, and the state must
// equal a naive recomputation from the accepted journal. Seeded PRNG, so a
// failure is reproducible from the seed in the test name.

import { describe, expect, it } from "vitest";
import {
  applyHold,
  applyPlan,
  checkInvariants,
  clientDeltas,
  planHold,
  planTransaction,
  type AccountState,
  type OriginalTransaction,
  type TransactionInput,
  type TransactionPlan,
} from "./ledger";
import { transactionHash, verifyChain, type HashableTransaction } from "./hashChain";
import { TRANSACTION_KINDS, TrustRuleError, type FundsSource } from "./types";
import { A1, A2, ACCOUNT, B1, CTX, CUSHION, prng, standardAccount } from "./testFixtures";

const SUBS = [A1, A2, B1, CUSHION, "ghost"];
const SOURCES: (FundsSource | null)[] = ["client", "third_party", "firm_operating", null];

interface Journal {
  id: string;
  plan: TransactionPlan;
  reversedById: string | null;
}

function randomInput(r: () => number, journal: Journal[]): { input: TransactionInput; original: OriginalTransaction | null } {
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  // A third of operations are deposits so ledgers fill up and outflows get exercised deeply.
  const kind = r() < 0.35 ? "deposit" : pick(TRANSACTION_KINDS);
  // Amounts skewed small so overdrafts are common; occasionally zero/negative/huge.
  const roll = r();
  const amount = roll < 0.03 ? 0n : roll < 0.05 ? -BigInt(Math.floor(r() * 100)) : roll < 0.06 ? 10n ** 15n : BigInt(1 + Math.floor(r() * 20_000));
  const input: TransactionInput = {
    kind,
    trustAccountId: ACCOUNT,
    effectiveDate: r() < 0.03 ? "2026-12-01" : "2026-09-15",
    reason: r() < 0.03 ? "" : "random op",
    amount,
    subledgerId: r() < 0.9 ? pick(SUBS.slice(0, 4)) : "ghost",
    toSubledgerId: kind === "transfer" ? pick(SUBS) : null,
    fundsSource: kind === "deposit" || kind === "cushion_deposit" ? (r() < 0.6 ? "client" : pick(SOURCES)) : null,
    counterparty: kind === "disbursement" && r() < 0.9 ? "Payee" : null,
    invoiceId: kind === "earned_fee_transfer" && r() < 0.8 ? "inv" : null,
    processorFeeCents: r() < 0.02 ? 30n : null,
  };
  let original: OriginalTransaction | null = null;
  if (kind === "reversal") {
    input.amount = null;
    input.subledgerId = null;
    const j = journal.length > 0 ? pick(journal) : null;
    if (j) {
      input.reversesTransactionId = j.id;
      original = {
        id: j.id,
        trustAccountId: ACCOUNT,
        kind: j.plan.kind,
        lines: j.plan.lines.map((l) => ({ subledgerId: l.subledgerId, amount: l.amount })),
        reversedById: j.reversedById,
      };
    }
  }
  return { input, original };
}

function recompute(start: AccountState, journal: Journal[]): Map<string, bigint> {
  const m = new Map<string, bigint>();
  for (const id of start.subledgers.keys()) m.set(id, 0n);
  for (const j of journal) for (const l of j.plan.lines) m.set(l.subledgerId, (m.get(l.subledgerId) ?? 0n) + l.amount);
  return m;
}

function snapshot(s: AccountState): string {
  return JSON.stringify([s.bookBalance.toString(), s.lastSequence, s.lastHash, [...s.subledgers.values()].map((x) => [x.id, x.balance.toString(), x.held.toString()])]);
}

describe("ledger properties over random operation sequences", () => {
  const SEEDS = 300;
  const STEPS = 80;

  it(`invariants hold after every step (${SEEDS} seeds × ${STEPS} steps)`, () => {
    let accepted = 0;
    let rejected = 0;
    const rejectedCodes = new Set<string>();
    for (let seed = 1; seed <= SEEDS; seed++) {
      const r = prng(seed);
      const start = standardAccount({}, { cushionCap: 50_000n });
      let s = start;
      const journal: Journal[] = [];
      const hashed: (HashableTransaction & { hash: string })[] = [];
      for (let step = 0; step < STEPS; step++) {
        // Occasionally place or release a hold instead of posting.
        if (r() < 0.1) {
          const target = [A1, A2, B1][Math.floor(r() * 3)]!;
          const cur = s.subledgers.get(target)!;
          if (r() < 0.5 && cur.held > 0n) {
            s = applyHold(s, target, -cur.held);
          } else {
            try {
              const h = planHold(s, { subledgerId: target, amount: BigInt(1 + Math.floor(r() * 5_000)), reason: "dispute" });
              s = applyHold(s, target, h.amount);
            } catch (err) {
              if (!(err instanceof TrustRuleError)) throw err;
            }
          }
          expect(checkInvariants(s), `seed ${seed} step ${step} (hold)`).toEqual([]);
          continue;
        }

        const { input, original } = randomInput(r, journal);
        const ctx = { ...CTX, cushionRuleApproved: r() < 0.7, original };
        const before = snapshot(s);
        let plan: TransactionPlan;
        try {
          plan = planTransaction(s, input, ctx);
        } catch (err) {
          if (!(err instanceof TrustRuleError)) throw err;
          rejected++;
          rejectedCodes.add(err.code);
          expect(snapshot(s), `seed ${seed} step ${step}: refused op must not change state`).toBe(before);
          continue;
        }
        accepted++;

        // I4: a transaction changes at most one client, and a transfer nets to zero for that client.
        const deltas = [...clientDeltas(s, plan).entries()].filter(([, v]) => v !== 0n);
        expect(deltas.length, `seed ${seed} step ${step}: touches more than one client`).toBeLessThanOrEqual(1);
        if (plan.kind === "transfer") expect(deltas.length).toBe(0);

        // I5: firm money only ever lands in the cushion, within the cap, when approved.
        if (plan.fundsSource === "firm_operating") {
          expect(plan.kind).toBe("cushion_deposit");
          expect(ctx.cushionRuleApproved).toBe(true);
          expect(plan.lines[0]!.subledgerId).toBe(CUSHION);
          expect(plan.lines[0]!.balanceAfter <= s.cushionCap).toBe(true);
        }
        // Bank fees never touch a client.
        if (plan.kind === "bank_fee") expect(plan.lines.every((l) => l.subledgerId === CUSHION)).toBe(true);

        const id = `t${seed}-${step}`;
        const row: HashableTransaction = {
          tenantId: "tenant",
          trustAccountId: ACCOUNT,
          sequence: plan.sequence,
          kind: plan.kind,
          effectiveDate: plan.effectiveDate,
          netAmount: plan.netAmount,
          reason: plan.reason,
          memo: plan.memo,
          counterparty: plan.counterparty,
          reference: plan.reference,
          invoiceId: plan.invoiceId,
          earnedBasis: plan.earnedBasis,
          fundsSource: plan.fundsSource,
          reversesTransactionId: plan.reversesTransactionId,
          postedByUserId: "user",
          postedAt: new Date(Date.UTC(2026, 8, 15, 0, 0, step)),
          prevHash: plan.prevHash,
          lines: plan.lines,
        };
        const hash = transactionHash(row);
        hashed.push({ ...row, hash });
        s = applyPlan(s, plan, hash);
        if (plan.reversesTransactionId) {
          const j = journal.find((x) => x.id === plan.reversesTransactionId)!;
          j.reversedById = id;
        }
        journal.push({ id, plan, reversedById: null });

        expect(checkInvariants(s), `seed ${seed} step ${step}`).toEqual([]);
        for (const l of plan.lines) expect(l.balanceAfter).toBe(s.subledgers.get(l.subledgerId)!.balance);
      }
      // Model equivalence: cached balances == naive recomputation from the journal.
      const rec = recompute(start, journal);
      for (const [id, sub] of s.subledgers) expect(sub.balance, `seed ${seed} ledger ${id}`).toBe(rec.get(id));
      // Every journal produced is a valid hash chain; any edit breaks it.
      expect(verifyChain(hashed).valid).toBe(true);
      if (hashed.length > 1) {
        const tampered = hashed.map((h, i) => (i === 0 ? { ...h, netAmount: h.netAmount + 1n } : h));
        expect(verifyChain(tampered).valid).toBe(false);
      }
    }
    // The generator really exercised both paths and many refusal reasons.
    expect(accepted).toBeGreaterThan(SEEDS * 10);
    expect(rejected).toBeGreaterThan(SEEDS * 10);
    for (const c of ["INSUFFICIENT_FUNDS", "CROSS_CLIENT", "COMMINGLING", "WRONG_SUBLEDGER_KIND", "UNKNOWN_SUBLEDGER", "ALREADY_REVERSED", "FUNDS_ON_HOLD"]) {
      expect(rejectedCodes, `never produced ${c}`).toContain(c);
    }
  });

  it("posting then reversing every accepted transaction (newest first) returns every ledger to zero", () => {
    for (let seed = 1000; seed < 1100; seed++) {
      const r = prng(seed);
      let s = standardAccount({}, { cushionCap: 50_000n });
      const journal: Journal[] = [];
      for (let step = 0; step < 40; step++) {
        const { input } = randomInput(r, []);
        if (input.kind === "reversal") continue;
        try {
          const plan = planTransaction(s, input, { ...CTX, cushionRuleApproved: true });
          s = applyPlan(s, plan);
          journal.push({ id: `t${step}`, plan, reversedById: null });
        } catch (err) {
          if (!(err instanceof TrustRuleError)) throw err;
        }
      }
      for (const j of [...journal].reverse()) {
        const plan = planTransaction(
          s,
          { kind: "reversal", trustAccountId: ACCOUNT, effectiveDate: "2026-09-30", reason: "unwind", reversesTransactionId: j.id },
          { ...CTX, original: { id: j.id, trustAccountId: ACCOUNT, kind: j.plan.kind, lines: j.plan.lines, reversedById: null } }
        );
        s = applyPlan(s, plan);
        expect(checkInvariants(s)).toEqual([]);
      }
      expect(s.bookBalance, `seed ${seed}`).toBe(0n);
      for (const sub of s.subledgers.values()) expect(sub.balance).toBe(0n);
    }
  });
});
