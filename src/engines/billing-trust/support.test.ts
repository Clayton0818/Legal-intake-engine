// Tests for the small pure modules: money, dates, hash chain, access, rules.

import { afterEach, describe, expect, it } from "vitest";
import { InMemoryApprovalSource, resetApprovalStateForTests, setApprovals } from "@/compliance/approvals";
import { centsToDecimalString, formatCents, jsonSafe, MoneyError, parseCents, parseDollars } from "./money";
import { addDays, daysBetween, isIsoDate, isPeriod, nextPeriod, periodBounds, previousPeriod, todayIn } from "./types";
import { transactionHash, verifyChain, type HashableTransaction } from "./hashChain";
import { assertCan, can, toActor, trustPermissions } from "./access";
import { DEFAULT_TRUST_SETTINGS, parseRuleValues, readTrustSettings, trustRecordsRetainUntil, trustRuleValues } from "./rules";
import { TRUST_RULE_GATES } from "./gates";

afterEach(() => resetApprovalStateForTests());

describe("money", () => {
  it("parses whole cents only", () => {
    expect(parseCents(123)).toBe(123n);
    expect(parseCents("-45")).toBe(-45n);
    expect(parseCents(7n)).toBe(7n);
    for (const bad of [1.5, "1.50", "", "1e3", Number.MAX_SAFE_INTEGER + 2, null, {}]) expect(() => parseCents(bad)).toThrow(MoneyError);
  });

  it("parses dollar strings exactly", () => {
    expect(parseDollars("1,234.56")).toBe(123_456n);
    expect(parseDollars("$0.1")).toBe(10n);
    expect(parseDollars("-12")).toBe(-1_200n);
    expect(parseDollars("(7.05)")).toBe(-705n);
    expect(parseDollars("0.07")).toBe(7n);
    for (const bad of ["1.234", "abc", "", "1.2.3"]) expect(() => parseDollars(bad)).toThrow(MoneyError);
  });

  it("formats without floats", () => {
    expect(formatCents(123_456_789n)).toBe("$1,234,567.89");
    expect(formatCents(-5n)).toBe("-$0.05");
    expect(centsToDecimalString(-100_001n)).toBe("-1000.01");
    expect(formatCents(9_007_199_254_740_993n)).toBe("$90,071,992,547,409.93");
  });

  it("makes bigints and dates JSON-safe", () => {
    expect(jsonSafe({ a: 1n, b: [2n], c: new Date("2026-01-01T00:00:00Z"), d: undefined, e: new Map([["k", 3n]]) })).toEqual({
      a: "1",
      b: ["2"],
      c: "2026-01-01T00:00:00.000Z",
      e: { k: "3" },
    });
  });
});

describe("dates", () => {
  it("validates calendar dates and periods", () => {
    expect(isIsoDate("2024-02-29")).toBe(true);
    expect(isIsoDate("2026-02-29")).toBe(false);
    expect(isIsoDate("2026-9-01")).toBe(false);
    expect(isPeriod("2026-12")).toBe(true);
    expect(isPeriod("2026-13")).toBe(false);
    expect(periodBounds("2024-02")).toEqual({ start: "2024-02-01", end: "2024-02-29" });
    expect(() => periodBounds("x")).toThrow();
    expect(nextPeriod("2026-12")).toBe("2027-01");
    expect(previousPeriod("2026-01")).toBe("2025-12");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(daysBetween("2026-09-01", "2026-10-01")).toBe(30);
  });

  it("computes today in the firm's time zone", () => {
    const now = new Date("2026-10-02T03:00:00Z");
    expect(todayIn("America/Chicago", now)).toBe("2026-10-01");
    expect(todayIn("UTC", now)).toBe("2026-10-02");
    expect(todayIn("Not/AZone", now)).toBe("2026-10-02");
  });
});

describe("hash chain", () => {
  const row = (sequence: number, prevHash: string | null): HashableTransaction => ({
    tenantId: "t",
    trustAccountId: "a",
    sequence,
    kind: "deposit",
    effectiveDate: "2026-09-01",
    netAmount: 100n,
    reason: "r",
    memo: null,
    counterparty: null,
    reference: null,
    invoiceId: null,
    earnedBasis: null,
    fundsSource: "client",
    reversesTransactionId: null,
    postedByUserId: "u",
    postedAt: new Date("2026-09-01T12:00:00.123Z"),
    prevHash,
    lines: [{ lineNo: 1, subledgerId: "s", amount: 100n }],
  });

  function chain(n: number) {
    const out: (HashableTransaction & { hash: string })[] = [];
    let prev: string | null = null;
    for (let i = 1; i <= n; i++) {
      const r = row(i, prev);
      const hash = transactionHash(r);
      out.push({ ...r, hash });
      prev = hash;
    }
    return out;
  }

  it("verifies an intact chain and finds the first break", () => {
    expect(verifyChain(chain(5))).toEqual({ valid: true, checked: 5, brokenAt: null });
    const c = chain(5);
    c[2] = { ...c[2]!, reason: "edited" };
    expect(verifyChain(c).brokenAt).toEqual({ sequence: 3, problem: "hash_mismatch" });
    expect(verifyChain(chain(5).filter((r) => r.sequence !== 2)).brokenAt?.problem).toBe("sequence_gap");
    const relinked = chain(3);
    relinked[1] = { ...relinked[1]!, prevHash: "x" };
    expect(verifyChain(relinked).brokenAt?.problem).toBe("prev_hash_mismatch");
  });

  it("covers the lines", () => {
    const a = row(1, null);
    expect(transactionHash(a)).not.toBe(transactionHash({ ...a, lines: [{ lineNo: 1, subledgerId: "s", amount: 101n }] }));
  });
});

describe("access (local stand-in for the shared permission model)", () => {
  const u = (role: string, roleLabel: string | null = null, status = "active") => toActor({ id: "u", role, roleLabel, status, displayName: "U" });

  it("owners and bookkeepers post and reconcile; lawyers read and sign as lawyer", () => {
    expect([...trustPermissions(u("firm_admin"))].sort()).toEqual(["post", "read", "reconcile", "signoff_bookkeeper"]);
    expect(can(u("intake_staff", "Bookkeeper"), "post")).toBe(true);
    expect(can(u("attorney", "owner"), "post")).toBe(true);
    expect(can(u("attorney", "owner"), "signoff_lawyer")).toBe(true);
    expect([...trustPermissions(u("attorney"))].sort()).toEqual(["read", "signoff_lawyer"]);
  });

  it("everyone else gets nothing", () => {
    for (const a of [u("intake_staff"), u("read_only", "bookkeeper"), u("integration_service", "owner"), u("firm_admin", null, "disabled"), u("none")]) {
      expect(trustPermissions(a).size).toBe(0);
    }
    expect(() => assertCan(u("intake_staff"), "post")).toThrow(/owner or bookkeeper/);
  });
});

describe("gated rule values and settings", () => {
  it("are PROPOSED (draft) until an attorney and a CPA approve", async () => {
    const pending = trustRuleValues();
    expect(pending.approved).toBe(false);
    expect(pending.pendingReviewers.sort()).toEqual(["attorney", "cpa"]);
    expect(pending.values.retentionYearsAfterRepresentationEnds).toBe(5);

    const src = new InMemoryApprovalSource();
    src.approve({ gateKey: TRUST_RULE_GATES.ruleValues.key, reviewerKind: "attorney", approvedByName: "A" });
    src.approve({ gateKey: TRUST_RULE_GATES.ruleValues.key, reviewerKind: "cpa", approvedByName: "C" });
    setApprovals(await src.load());
    expect(trustRuleValues().approved).toBe(true);
  });

  it("parses approved text defensively; tolerance is always zero", () => {
    expect(parseRuleValues('{"retentionYearsAfterRepresentationEnds": 7, "reconciliationToleranceCents": 500}')).toMatchObject({
      retentionYearsAfterRepresentationEnds: 7,
      reconciliationToleranceCents: 0,
    });
    expect(parseRuleValues("not json").retentionYearsAfterRepresentationEnds).toBe(5);
    expect(parseRuleValues('{"retentionYearsAfterRepresentationEnds": 0}').retentionYearsAfterRepresentationEnds).toBe(5);
  });

  it("retention never shorter than the rule, firms may keep longer, clock starts at closing", () => {
    expect(trustRecordsRetainUntil(null, 5, null)).toBeNull();
    expect(trustRecordsRetainUntil("2026-03-15", 5, null)).toBe("2031-03-15");
    expect(trustRecordsRetainUntil("2026-03-15", 5, 3)).toBe("2031-03-15");
    expect(trustRecordsRetainUntil("2026-03-15", 5, 7)).toBe("2033-03-15");
  });

  it("reads firm settings with safe fallbacks", () => {
    expect(readTrustSettings({ engineSettings: {} })).toEqual(DEFAULT_TRUST_SETTINGS);
    const s = readTrustSettings({
      engineSettings: { "billing-trust": { reconciliationDueDays: 10, signoffRoles: ["lawyer", "bogus"], staleOutstandingDays: -1, retentionYears: 8 } },
    });
    expect(s.reconciliationDueDays).toBe(10);
    expect(s.signoffRoles).toEqual(["lawyer"]);
    expect(s.staleOutstandingDays).toBe(90);
    expect(s.retentionYears).toBe(8);
    expect(readTrustSettings({ engineSettings: { "billing-trust": { signoffRoles: [] } } }).signoffRoles).toEqual(["bookkeeper", "lawyer"]);
  });
});
