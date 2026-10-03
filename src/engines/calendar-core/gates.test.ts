import { afterEach, describe, expect, it } from "vitest";
import { getGate, isApproved, PendingApprovalError, requireApproval, resetApprovalStateForTests, setBlockedActionSink, type BlockedActionEvent } from "@/compliance/approvals";
import { buildRegistry } from "@/worker/hooks";
import { CALENDAR_CORE_DEPENDENT_GATE_KEYS, CALENDAR_CORE_GATE_KEYS, RULE_GATES } from "./gates";
import { worker } from "./worker";

afterEach(() => resetApprovalStateForTests());

describe("calendar-core gates", () => {
  it("own gates are namespaced and tied to c92", () => {
    for (const key of CALENDAR_CORE_GATE_KEYS) {
      expect(key).toMatch(/^rules\.calendar-core\./);
      expect(getGate(key).cardIds).toContain("c92");
    }
  });
  it("reuses the shared court-deadline, limitation-period and calendar-sync gates", () => {
    expect(CALENDAR_CORE_DEPENDENT_GATE_KEYS).toEqual(expect.arrayContaining(["rules.court_deadlines", "rules.limitation_periods", "vendor.calendar_sync"]));
  });
  it("nothing is approved by default: applying a court rule is blocked and logged", () => {
    const seen: BlockedActionEvent[] = [];
    setBlockedActionSink((e) => seen.push(e));
    expect(isApproved(RULE_GATES.courtDeadlines.key)).toBe(false);
    expect(() => requireApproval(RULE_GATES.courtDeadlines.key, { action: "deadline.calculate" })).toThrow(PendingApprovalError);
    expect(seen[0]?.action).toBe("deadline.calculate");
  });
});

describe("calendar-core worker", () => {
  it("registers prefixed hooks", () => {
    const reg = buildRegistry([{ slug: "calendar-core", module: worker }]);
    const names = reg.hooks.map((h) => h.name).filter((n) => n.startsWith("calendar-core."));
    expect(names).toEqual([
      "calendar-core.limitation_scan",
      "calendar-core.limitation_coverage",
      "calendar-core.sync_outbound",
      "calendar-core.sync_inbound",
      "calendar-core.task_list_release",
    ]);
  });
});
