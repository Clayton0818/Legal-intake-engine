import { afterEach, describe, it, expect } from "vitest";
import { gateStatus, getGate, isPlaceholder, legalCopy, requireApproval, PendingApprovalError, resetApprovalStateForTests } from "@/compliance/approvals";
import { approveGates } from "./__tests__/fixtures";
import { ACCEPTANCE_GATES, BOOKING_RULE_GATES, CHANNEL_COPY, copyKeyFor, INTAKE_GATE_KEYS, INTAKE_SHARED_GATE_KEYS, OPEN_MATTER_GATES } from "./gates";

afterEach(() => resetApprovalStateForTests());

describe("intake approval gates", () => {
  it("every gate is defined, namespaced and unique", () => {
    expect(new Set(INTAKE_GATE_KEYS).size).toBe(INTAKE_GATE_KEYS.length);
    for (const key of [...INTAKE_GATE_KEYS, ...INTAKE_SHARED_GATE_KEYS]) {
      expect(() => getGate(key)).not.toThrow();
      expect(key).toMatch(/^(copy\.intake|rules\.intake|vendor\.|rules\.|notify\.)/);
    }
  });

  it("client wording is a visible placeholder until an attorney approves it", () => {
    const text = legalCopy(CHANNEL_COPY.disclosure.en.key, { firmName: "Smith Family Law", portalUrl: "https://x" });
    expect(isPlaceholder(text)).toBe(true);
    expect(text).toMatch(/PENDING ATTORNEY REVIEW/);
    approveGates(CHANNEL_COPY.disclosure.en.key);
    expect(legalCopy(CHANNEL_COPY.disclosure.en.key, { firmName: "Smith Family Law", portalUrl: "https://x" })).toMatch(/You are contacting Smith Family Law/);
  });

  it("Spanish twins exist for bilingual copy", () => {
    expect(copyKeyFor(CHANNEL_COPY.disclosure, "es")).toBe("copy.intake.channel_disclosure_es");
    expect(copyKeyFor(CHANNEL_COPY.disclosure, "en")).toBe("copy.intake.channel_disclosure");
  });

  it("trust / fee / open-matter rules need the right reviewers and fail safe", () => {
    expect(getGate(BOOKING_RULE_GATES.consultFeeTerms.key).reviewers).toEqual(["attorney", "cpa"]);
    expect(getGate(OPEN_MATTER_GATES.retainerAttestation.key).reviewers).toEqual(["attorney", "cpa"]);
    expect(getGate(ACCEPTANCE_GATES.autoDecline.key).reviewers).toEqual(["attorney", "founder_decision"]);
    expect(() => requireApproval(OPEN_MATTER_GATES.openGates.key, { action: "test" })).toThrow(PendingApprovalError);
    expect(gateStatus(OPEN_MATTER_GATES.openGates.key).pendingReviewers).toEqual(["attorney"]);
  });
});
