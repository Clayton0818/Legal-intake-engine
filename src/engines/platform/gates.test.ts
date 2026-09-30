import { beforeEach, describe, expect, it } from "vitest";
import { isApproved, isPlaceholder, legalCopy, resetApprovalStateForTests } from "@/compliance/approvals";
import { PLATFORM_GATE_KEYS, PLATFORM_GATES } from "./gates";
import { parseSafetyRules } from "@/llm/safetyRules";

beforeEach(() => resetApprovalStateForTests());

describe("platform gates", () => {
  it("declares the four gates, all closed by default", () => {
    expect(PLATFORM_GATE_KEYS.sort()).toEqual([
      "auth.vendor",
      "copy.platform.triage_system_prompt",
      "copy.platform.widget_notice",
      "rules.platform.safety_triggers",
    ]);
    for (const k of PLATFORM_GATE_KEYS) expect(isApproved(k)).toBe(false);
    expect(PLATFORM_GATES.authVendor.reviewers).toEqual(["founder_decision", "vendor_dpa"]);
  });

  it("widget notice renders the visible placeholder until approved", () => {
    const text = legalCopy(PLATFORM_GATES.widgetNotice.key, { firmName: "Smith Law" });
    expect(isPlaceholder(text)).toBe(true);
    expect(text).toContain("PENDING ATTORNEY REVIEW");
  });

  it("safety trigger draft is a valid rule list", () => {
    const rules = parseSafetyRules(PLATFORM_GATES.safetyTriggers.draft);
    expect(rules?.map((r) => r.category)).toEqual(["domestic_violence", "self_harm", "child_danger", "weapons"]);
  });
});
