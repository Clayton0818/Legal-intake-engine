// Test fixtures for the billing-trust domain tests (no database).

import type { AccountState, SubledgerState } from "./ledger";

export const ACCOUNT = "00000000-0000-4000-8000-0000000000a1";
export const OTHER_ACCOUNT = "00000000-0000-4000-8000-0000000000a2";
export const CLIENT_A = "00000000-0000-4000-8000-00000000c00a";
export const CLIENT_B = "00000000-0000-4000-8000-00000000c00b";
export const A1 = "00000000-0000-4000-8000-0000000005a1"; // client A, matter 1
export const A2 = "00000000-0000-4000-8000-0000000005a2"; // client A, matter 2
export const B1 = "00000000-0000-4000-8000-0000000005b1"; // client B, matter 1
export const CUSHION = "00000000-0000-4000-8000-0000000005f0";

export function sub(id: string, clientPartyId: string | null, balance = 0n, held = 0n, trustAccountId = ACCOUNT): SubledgerState {
  return {
    id,
    trustAccountId,
    kind: clientPartyId ? "client_matter" : "firm_cushion",
    clientPartyId,
    matterId: clientPartyId ? `${id.slice(0, -4)}m${id.slice(-3)}` : null,
    balance,
    held,
  };
}

export function account(subs: SubledgerState[], over: Partial<AccountState> = {}): AccountState {
  const book = subs.reduce((s, x) => s + x.balance, 0n);
  return {
    id: ACCOUNT,
    status: "active",
    bookBalance: book,
    lastSequence: 0,
    lastHash: null,
    closedThrough: null,
    cushionCap: 0n,
    subledgers: new Map(subs.map((s) => [s.id, s])),
    ...over,
  };
}

/** The standard account: A1, A2 (client A), B1 (client B) and the firm cushion. */
export function standardAccount(balances: { a1?: bigint; a2?: bigint; b1?: bigint; cushion?: bigint } = {}, over: Partial<AccountState> = {}): AccountState {
  return account(
    [sub(A1, CLIENT_A, balances.a1 ?? 0n), sub(A2, CLIENT_A, balances.a2 ?? 0n), sub(B1, CLIENT_B, balances.b1 ?? 0n), sub(CUSHION, null, balances.cushion ?? 0n)],
    over
  );
}

export const CTX = { today: "2026-10-02", cushionRuleApproved: false } as const;

/** Small deterministic PRNG (mulberry32) for property-style tests: reproducible from a seed. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
