import { afterEach, describe, expect, it } from "vitest";
import { InMemoryApprovalSource, PendingApprovalError, refreshApprovals, resetApprovalStateForTests, setApprovalSource } from "@/compliance/approvals";
import {
  RETENTION_GATE,
  addYearsUtc,
  computeRetention,
  proposeRetention,
  resolveRetentionRule,
  validateRetentionRule,
  type RetentionRule,
} from "./policy";

const rules: RetentionRule[] = [
  { id: "all", practiceArea: null, documentType: null, retainYearsAfterClose: 5, basis: "Firm policy" },
  { id: "family", practiceArea: "family", documentType: null, retainYearsAfterClose: 7, basis: "Firm policy" },
  { id: "orders", practiceArea: null, documentType: "court_order", retainYearsAfterClose: 10, basis: "Firm policy" },
  { id: "family-orders", practiceArea: "family", documentType: "court_order", retainYearsAfterClose: 20, basis: "Minors' orders" },
];

describe("validateRetentionRule", () => {
  it("needs whole years in range and a recorded basis", () => {
    expect(validateRetentionRule({ practiceArea: null, documentType: null, retainYearsAfterClose: 5, basis: "Policy" })).toEqual([]);
    expect(validateRetentionRule({ practiceArea: null, documentType: null, retainYearsAfterClose: 2.5, basis: "x" })).toHaveLength(1);
    expect(validateRetentionRule({ practiceArea: null, documentType: null, retainYearsAfterClose: 101, basis: "x" })).toHaveLength(1);
    expect(validateRetentionRule({ practiceArea: null, documentType: "Bad Type", retainYearsAfterClose: 1, basis: " " })).toHaveLength(2);
  });
});

describe("resolveRetentionRule", () => {
  it("picks the most specific rule", () => {
    expect(resolveRetentionRule(rules, { practiceArea: "family", documentType: "court_order" })!.id).toBe("family-orders");
    expect(resolveRetentionRule(rules, { practiceArea: "immigration", documentType: "court_order" })!.id).toBe("orders");
    expect(resolveRetentionRule(rules, { practiceArea: "family", documentType: "letter" })!.id).toBe("family");
    expect(resolveRetentionRule(rules, { practiceArea: null, documentType: "letter" })!.id).toBe("all");
    expect(resolveRetentionRule([], { practiceArea: null, documentType: "letter" })).toBeNull();
  });
});

describe("computeRetention", () => {
  const closed = new Date("2024-02-29T12:00:00Z");
  it("is a proposal date for review, years after closing", () => {
    expect(computeRetention({ matterClosedAt: closed, legalHold: false, legalHoldReason: null, rule: rules[0]! })).toEqual({
      state: "eligible_for_review_at",
      at: new Date("2029-02-28T12:00:00Z"),
      ruleId: "all",
      years: 5,
      basis: "Firm policy",
    });
  });
  it("a legal hold always wins; open matters and missing rules have no date", () => {
    expect(computeRetention({ matterClosedAt: closed, legalHold: true, legalHoldReason: "Litigation", rule: rules[0]! })).toEqual({
      state: "legal_hold",
      reason: "Litigation",
    });
    expect(computeRetention({ matterClosedAt: null, legalHold: false, legalHoldReason: null, rule: rules[0]! }).state).toBe("matter_open");
    expect(computeRetention({ matterClosedAt: closed, legalHold: false, legalHoldReason: null, rule: null }).state).toBe("no_rule");
  });
  it("adds calendar years", () => {
    expect(addYearsUtc(new Date("2020-01-15T00:00:00Z"), 3).toISOString()).toBe("2023-01-15T00:00:00.000Z");
  });
});

describe("proposeRetention (gated)", () => {
  afterEach(() => resetApprovalStateForTests());
  const input = { matterClosedAt: new Date("2024-01-01T00:00:00Z"), legalHold: false, legalHoldReason: null, practiceArea: "family", documentType: "letter", rules };

  it("is blocked while rules.retention_periods is pending", () => {
    expect(() => proposeRetention("t1", input)).toThrow(PendingApprovalError);
  });

  it("runs once an attorney approved the gate", async () => {
    const src = new InMemoryApprovalSource();
    src.approve({ gateKey: RETENTION_GATE, reviewerKind: "attorney", approvedByName: "Reviewer" });
    setApprovalSource(src);
    await refreshApprovals();
    expect(proposeRetention("t1", input)).toMatchObject({ state: "eligible_for_review_at", ruleId: "family", years: 7 });
  });
});
