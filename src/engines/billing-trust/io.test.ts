// HTTP parsing, error mapping, statement CSV/JSON input, exports, gates and
// worker registration. No database.

import { afterEach, describe, expect, it } from "vitest";
import {
  gateStatus,
  getGate,
  PendingApprovalError,
  requireApproval,
  resetApprovalStateForTests,
  setBlockedActionSink,
  type BlockedActionEvent,
} from "@/compliance/approvals";
import { RULE_GATES } from "@/compliance/gates";
import { listAllGates } from "@/compliance/allGates";
import { buildRegistry } from "@/worker/hooks";
import { jsonSafe } from "./money";
import { mapHandledError, parseManualMatches, parseTransactionInput, readBody } from "./http";
import { parseStatementCsv, parseStatementLines, reconciliationCsv, splitCsvLine, type ExportMeta } from "./statementIo";
import { reconcile, reportHash } from "./reconciliation";
import { reportHashOfStored, reviveReport } from "./reconciliationService";
import { StubBankFeedAdapter, getBankFeedAdapter, setBankFeedAdapter } from "./bankFeed";
import { TRUST_DEPENDENCY_GATE_KEYS, TRUST_RULE_GATES } from "./gates";
import { worker } from "./worker";
import { TrustRuleError } from "./types";
import { A1 } from "./testFixtures";

afterEach(() => resetApprovalStateForTests());

const ID = "11111111-1111-4111-8111-111111111111";

describe("parseTransactionInput", () => {
  it("parses a posting request with cent amounts as numbers or strings", () => {
    const input = parseTransactionInput(
      { kind: "deposit", effectiveDate: "2026-09-01", reason: "Retainer", amountCents: "450000", subledgerId: ID, fundsSource: "client", invoiceId: ID },
      ID
    );
    expect(input).toMatchObject({ kind: "deposit", amount: 450_000n, subledgerId: ID, fundsSource: "client", invoiceId: ID, trustAccountId: ID });
    expect(parseTransactionInput({ kind: "refund", effectiveDate: "2026-09-01", reason: "x", amountCents: 5 }, ID).amount).toBe(5n);
  });

  it("rejects floats, unknown kinds, bad ids and bad sources", () => {
    const base = { kind: "deposit", effectiveDate: "2026-09-01", reason: "r" };
    expect(() => parseTransactionInput({ ...base, amountCents: 10.5 }, ID)).toThrow(/whole number of cents/);
    expect(() => parseTransactionInput({ ...base, kind: "steal" }, ID)).toThrow(TrustRuleError);
    expect(() => parseTransactionInput({ ...base, subledgerId: "x" }, ID)).toThrow(TrustRuleError);
    expect(() => parseTransactionInput({ ...base, fundsSource: "loan" }, ID)).toThrow(TrustRuleError);
    expect(() => parseTransactionInput({ ...base, effectiveDate: "09/01/2026" }, ID)).toThrow(TrustRuleError);
  });

  it("parses manual matches", () => {
    expect(parseManualMatches([{ statementLineId: ID, transactionIds: [ID] }])).toEqual([{ statementLineId: ID, transactionIds: [ID] }]);
    expect(parseManualMatches(undefined)).toEqual([]);
    expect(() => parseManualMatches([{ statementLineId: "x", transactionIds: [] }])).toThrow(TrustRuleError);
    expect(() => parseManualMatches("x")).toThrow(TrustRuleError);
  });

  it("reads JSON bodies", async () => {
    await expect(readBody(new Request("http://x", { method: "POST", body: "{" }))).rejects.toThrow(TrustRuleError);
    await expect(readBody(new Request("http://x", { method: "POST", body: "[]" }))).rejects.toThrow(TrustRuleError);
    await expect(readBody(new Request("http://x", { method: "POST", body: '{"a":1}' }))).resolves.toEqual({ a: 1 });
  });
});

describe("mapHandledError", () => {
  it("maps a pending trust gate to 423 with the visible placeholder", () => {
    setBlockedActionSink(() => {});
    let err: unknown;
    try {
      requireApproval(RULE_GATES.trustAccounting.key, { action: "trust.deposit" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PendingApprovalError);
    const mapped = mapHandledError(err)!;
    expect(mapped.status).toBe(423);
    expect(mapped.body.gate).toBe("rules.trust_accounting");
    expect(String(mapped.body.message)).toMatch(/PENDING ATTORNEY \+ CPA REVIEW/);
  });

  it("maps rule refusals to 4xx with a code, and leaves other errors alone", () => {
    expect(mapHandledError(new TrustRuleError("CROSS_CLIENT", "no", { a: 1n }))).toEqual({
      status: 422,
      body: { error: "no", code: "CROSS_CLIENT", details: { a: "1" } },
    });
    expect(mapHandledError(new TrustRuleError("NOT_ALLOWED", "no"))!.status).toBe(403);
    expect(mapHandledError(new TrustRuleError("NOT_FOUND", "no"))!.status).toBe(404);
    expect(mapHandledError(new Error("boom"))).toBeNull();
  });
});

describe("statement input", () => {
  it("parses JSON lines and infers kinds", () => {
    const lines = parseStatementLines([
      { postedOn: "2026-09-03", amountCents: 500000, description: "Deposit" },
      { postedOn: "2026-09-30", amountCents: "-1500", description: "Service charge", kind: "fee", reference: " 77 " },
    ]);
    expect(lines.map((l) => [l.amount, l.kind, l.reference])).toEqual([
      [500_000n, "deposit", null],
      [-1_500n, "fee", "77"],
    ]);
    expect(() => parseStatementLines([{ postedOn: "2026-09-03", amountCents: 0, description: "x" }])).toThrow(TrustRuleError);
    expect(() => parseStatementLines([{ postedOn: "2026-09-03", amountCents: 1.5, description: "x" }])).toThrow(TrustRuleError);
    expect(() => parseStatementLines([{ postedOn: "bad", amountCents: 1, description: "x" }])).toThrow(TrustRuleError);
  });

  it("parses a bank CSV with signed amounts or debit/credit columns", () => {
    const a = parseStatementCsv('Date,Description,Amount,Reference\n2026-09-03,"Deposit, retainer",5000.00,D1\n2026-09-30,Service charge,-15.00,\n');
    expect(a.map((l) => [l.postedOn, l.amount, l.description, l.reference, l.kind])).toEqual([
      ["2026-09-03", 500_000n, "Deposit, retainer", "D1", "deposit"],
      ["2026-09-30", -1_500n, "Service charge", null, "withdrawal"],
    ]);
    const b = parseStatementCsv("date,description,debit,credit,kind\n2026-09-05,Check 1001,250.00,,withdrawal\n2026-09-06,Wire in,,1,234.5,deposit\n".replace("1,234.5", '"1,234.50"'));
    expect(b.map((l) => l.amount)).toEqual([-25_000n, 123_450n]);
    expect(() => parseStatementCsv("date,amount\n2026-09-01,5")).toThrow(/columns/);
    expect(() => parseStatementCsv("date,description,amount\n2026-09-01,x,5.555")).toThrow(TrustRuleError);
    expect(() => parseStatementCsv("date,description,amount\n")).toThrow(TrustRuleError);
    expect(splitCsvLine('a,"b ""q"", c",d')).toEqual(["a", 'b "q", c', "d"]);
  });
});

describe("worksheet storage, hashing and export", () => {
  const report = reconcile({
    trustAccountId: "acct",
    period: "2026-09",
    statement: {
      id: "st",
      period: "2026-09",
      periodStart: "2026-09-01",
      periodEnd: "2026-09-30",
      openingBalance: 0n,
      closingBalance: 500n,
      lines: [{ id: "l1", lineNo: 1, postedOn: "2026-09-02", amount: 500n, description: "Dep", reference: null, kind: "deposit" }],
    },
    previousClosingBalance: null,
    transactions: [
      { id: "t1", sequence: 1, kind: "deposit", effectiveDate: "2026-09-01", netAmount: 500n, reference: null, counterparty: null, reason: "r", reversesTransactionId: null, lines: [{ subledgerId: A1, amount: 500n }] },
      { id: "t2", sequence: 2, kind: "disbursement", effectiveDate: "2026-09-29", netAmount: -100n, reference: "=cmd()", counterparty: "Court", reason: "r", reversesTransactionId: null, lines: [{ subledgerId: A1, amount: -100n }] },
    ],
    ledgers: [{ id: A1, kind: "client_matter", label: "Alpha — Family", clientPartyId: "c", matterId: "m", cachedBalance: 400n, cachedHeld: 0n }],
    cachedBookBalance: 400n,
    previouslyCleared: new Set(),
    chain: { valid: true, checked: 2, brokenAt: null },
    depositToleranceDays: 5,
    withdrawalClearDays: 180,
    staleOutstandingDays: 90,
  });

  it("hashes the same after a jsonb-style key reordering, and detects edits", () => {
    const stored = jsonSafe(report) as Record<string, unknown>;
    const reordered = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(stored).reverse()))) as Record<string, unknown>;
    expect(reportHashOfStored(reordered)).toBe(reportHash(report));
    expect(reportHashOfStored({ ...reordered, bookBalance: "1" })).not.toBe(reportHash(report));
  });

  it("revives a stored worksheet with exact bigint amounts", () => {
    const revived = reviveReport(jsonSafe(report) as Record<string, unknown>);
    expect(revived.bank.adjustedBalance).toBe(400n);
    expect(revived.outstanding[0]!.amount).toBe(-100n);
    expect(reportHash(revived)).toBe(reportHash(report));
  });

  it("exports CSV with the three figures, ledgers, outstanding items and formula-safe cells", () => {
    const meta: ExportMeta = {
      firmName: "Test Firm",
      accountName: "IOLTA",
      status: "balanced",
      preparedAt: "2026-10-02T00:00:00.000Z",
      preparedBy: "Bookkeeper",
      signoffs: [{ role: "bookkeeper", name: "B", signedAt: "2026-10-02T00:00:00.000Z" }],
      reportHash: reportHash(report),
      retainUntil: null,
      rulesApproved: false,
    };
    const csv = reconciliationCsv(report, meta);
    expect(csv).toContain("Adjusted bank balance,4.00");
    expect(csv).toContain("Trust book balance,4.00");
    expect(csv).toContain("Sum of client ledgers,4.00");
    expect(csv).toContain("Alpha — Family,4.00,0.00");
    expect(csv).toContain("'=cmd()");
    expect(csv).toContain("Less: outstanding checks / withdrawals,1.00");
    expect(csv).toContain("pending attorney + CPA review");
  });
});

describe("gates, bank feed and worker registration", () => {
  it("defines the engine gates with attorney + CPA (rules) and vendor DPA + CPA (bank feed)", async () => {
    expect(getGate(TRUST_RULE_GATES.ruleValues.key).reviewers).toEqual(["attorney", "cpa"]);
    expect(getGate(TRUST_RULE_GATES.bankFeeCushion.key).reviewers).toEqual(["attorney", "cpa"]);
    expect(getGate(TRUST_RULE_GATES.bankFeed.key).reviewers).toEqual(["vendor_dpa", "cpa"]);
    for (const key of TRUST_DEPENDENCY_GATE_KEYS) expect(gateStatus(key).approved).toBe(false);
    const all = (await listAllGates()).map((g) => g.key);
    for (const g of Object.values(TRUST_RULE_GATES)) expect(all).toContain(g.key);
  });

  it("ships only a stub bank feed that fetches nothing", async () => {
    const stub = new StubBankFeedAdapter();
    setBankFeedAdapter(stub);
    const res = await getBankFeedAdapter().fetchStatement({ tenantId: "t", trustAccountId: "a", bankName: "B", accountNumberLast4: "1234", period: "2026-09" });
    expect(res.status).toBe("unavailable");
    expect(stub.requests).toHaveLength(1);
    setBankFeedAdapter(null);
    expect(getBankFeedAdapter().name).toBe("stub");
  });

  it("registers prefixed worker hooks", () => {
    const registry = buildRegistry([{ slug: "billing-trust", module: worker }]);
    const names = registry.hooks.map((h) => h.name);
    expect(names).toContain("billing-trust.reconciliation_overdue");
    expect(names).toContain("billing-trust.closed_matter_funds");
  });

  it("blocked trust movements are reported to the blocked-action sink", () => {
    const events: BlockedActionEvent[] = [];
    setBlockedActionSink((e) => events.push(e));
    expect(() => requireApproval(RULE_GATES.trustAccounting.key, { action: "trust.refund", tenantId: "t" })).toThrow(PendingApprovalError);
    expect(events[0]).toMatchObject({ gateKey: "rules.trust_accounting", action: "trust.refund", tenantId: "t" });
  });
});
