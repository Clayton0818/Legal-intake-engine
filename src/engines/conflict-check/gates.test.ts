import { afterEach, describe, expect, it } from "vitest";
import {
  getGate,
  isApproved,
  legalCopy,
  PendingApprovalError,
  requireApproval,
  resetApprovalStateForTests,
  setBlockedActionSink,
  type BlockedActionEvent,
} from "@/compliance/approvals";
import { RULE_GATES, VENDOR_GATES } from "@/compliance/gates";
import { StubESignatureProvider } from "./esign";
import { CONFLICT_COPY_GATES, CONFLICT_GATE_KEYS, CONFLICT_RULE_GATES } from "./gates";

afterEach(() => resetApprovalStateForTests());

describe("conflict-check approval gates", () => {
  it("defines namespaced gates tied to this group's cards", () => {
    for (const key of CONFLICT_GATE_KEYS) {
      expect(key).toMatch(/^(copy|rules)\.conflict-check\./);
      expect(getGate(key).cardIds.every((c) => ["c3", "c56", "c57", "c58", "c59", "c61", "c62", "c63", "c96", "c97"].includes(c))).toBe(true);
    }
  });

  it("every client-facing text is attorney-reviewed and shows a visible placeholder until approved", () => {
    for (const g of Object.values(CONFLICT_COPY_GATES)) {
      expect(g.reviewers).toContain("attorney");
      expect(isApproved(g.key)).toBe(false);
      expect(legalCopy(g.key, { firmName: "Firm" })).toMatch(/^\[PENDING ATTORNEY REVIEW/);
    }
  });

  it("the pending-review message draft never mentions a conflict (c59 Q3)", () => {
    expect(CONFLICT_COPY_GATES.pendingReview.draft?.toLowerCase()).not.toContain("conflict");
  });

  it("the rule-table override needs both the attorney and the founder", () => {
    expect([...CONFLICT_RULE_GATES.ruleTableOverride.reviewers].sort()).toEqual(["attorney", "founder_decision"]);
  });

  it("blocks and logs gated actions while pending", () => {
    const events: BlockedActionEvent[] = [];
    setBlockedActionSink((e) => events.push(e));
    for (const key of [RULE_GATES.conflictRules.key, VENDOR_GATES.esignature.key, CONFLICT_RULE_GATES.exportDisclosure.key]) {
      expect(() => requireApproval(key, { action: "test" })).toThrow(PendingApprovalError);
    }
    expect(events.map((e) => e.gateKey)).toEqual(["rules.conflicts", "vendor.esignature", "rules.conflict-check.export_disclosure"]);
  });
});

describe("StubESignatureProvider", () => {
  it("records the request and never sends", async () => {
    const stub = new StubESignatureProvider();
    const r = await stub.sendForSignature({ tenantId: "t", waiverId: "w", signerPartyId: "p", documentId: null, countersign: true });
    expect(r.outcome).toBe("held");
    expect(stub.recorded).toHaveLength(1);
    expect(stub.isStub).toBe(true);
  });
});
