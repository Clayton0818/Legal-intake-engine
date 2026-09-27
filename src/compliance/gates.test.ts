import { describe, it, expect, beforeEach } from "vitest";
import { CORE_GATE_KEYS, NOTIFY_COPY_GATES, RULE_GATES, VENDOR_GATES } from "./gates";
import { listAllGates } from "./allGates";
import {
  isApproved,
  isPlaceholder,
  legalCopy,
  requireApproval,
  PendingApprovalError,
  resetApprovalStateForTests,
  setApprovals,
  setBlockedActionSink,
} from "./approvals";
import { buildApprovalInsert, formatGateReport } from "./report";

beforeEach(() => {
  resetApprovalStateForTests();
  setBlockedActionSink(() => {});
});

describe("shared gates", () => {
  it("covers every vendor, rule set and client wording the founder listed", () => {
    expect(Object.values(VENDOR_GATES).map((g) => g.key)).toEqual(
      expect.arrayContaining([
        "vendor.email",
        "vendor.sms",
        "vendor.ai_model",
        "vendor.calendar_sync",
        "vendor.mailbox_access",
        "vendor.efiling",
        "vendor.payment_processor",
      ])
    );
    expect(Object.values(RULE_GATES).map((g) => g.key)).toEqual(
      expect.arrayContaining([
        "rules.trust_accounting",
        "rules.conflicts",
        "rules.court_deadlines",
        "rules.limitation_periods",
        "rules.fee_agreement_terms",
        "rules.retention_periods",
      ])
    );
    expect(new Set(CORE_GATE_KEYS).size).toBe(CORE_GATE_KEYS.length);
  });

  it("trust money needs BOTH an attorney and a CPA", () => {
    expect(RULE_GATES.trustAccounting.reviewers).toEqual(["attorney", "cpa"]);
  });

  it("everything is closed by default: actions block, wording shows a placeholder", () => {
    for (const key of CORE_GATE_KEYS) expect(isApproved(key)).toBe(false);
    expect(() => requireApproval("rules.trust_accounting", { action: "trust.disburse" })).toThrow(PendingApprovalError);
    const text = legalCopy(NOTIFY_COPY_GATES.flagUpdate.key, { firmName: "X", portalUrl: "Y" });
    expect(text).toBe(
      "[PENDING ATTORNEY REVIEW — Minimal client email/in-app text for a client-side flag (gate: notify.client.flag_update)]"
    );
    expect(isPlaceholder(text)).toBe(true);
  });

  it("listAllGates() works when no engine has a gates.ts yet", async () => {
    const keys = (await listAllGates()).map((g) => g.key);
    expect(keys).toEqual(expect.arrayContaining(CORE_GATE_KEYS));
  });
});

describe("report helpers (compliance CLI)", () => {
  it("formats pending and approved gates", () => {
    setApprovals([{ gateKey: "vendor.email", reviewerKind: "vendor_dpa", approvedByName: "Ops", approvedAt: new Date() }]);
    const report = formatGateReport([VENDOR_GATES.email, VENDOR_GATES.sms]);
    expect(report).toContain("1 approved, 1 pending");
    expect(report).toContain("[x] vendor.email  (APPROVED)");
    expect(report).toContain("[ ] vendor.sms  (PENDING vendor_dpa + attorney)");
  });

  it("builds a sign-off row with the current draft hash", () => {
    const row = buildApprovalInsert({
      gateKey: NOTIFY_COPY_GATES.reminder.key,
      reviewerKind: "attorney",
      approvedByName: " Jane Roe, Texas Bar #000 ",
    });
    expect(row).toMatchObject({
      gateKey: "notify.client.reminder",
      reviewerKind: "attorney",
      approvedByName: "Jane Roe, Texas Bar #000",
      draftHash: NOTIFY_COPY_GATES.reminder.draftHash,
      approvedText: null,
    });
  });

  it("refuses reviewers the gate does not ask for, unknown kinds, unknown gates and blank names", () => {
    expect(() => buildApprovalInsert({ gateKey: "vendor.email", reviewerKind: "attorney", approvedByName: "J" })).toThrow(/does not ask/);
    expect(() => buildApprovalInsert({ gateKey: "vendor.email", reviewerKind: "judge", approvedByName: "J" })).toThrow(/Unknown reviewer/);
    expect(() => buildApprovalInsert({ gateKey: "vendor.nope", reviewerKind: "vendor_dpa", approvedByName: "J" })).toThrow(/Unknown approval gate/);
    expect(() => buildApprovalInsert({ gateKey: "vendor.email", reviewerKind: "vendor_dpa", approvedByName: " " })).toThrow(/required/);
  });
});
