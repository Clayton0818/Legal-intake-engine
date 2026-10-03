import { describe, expect, it } from "vitest";
import { CAL, chicago } from "../testFixtures";
import { DEFAULT_ALERT_SETTINGS } from "../settings";
import { decideStall, stallSummary, validateCheckBack, type LiveWatch, type StallCandidate } from "./plan";

const handoff: StallCandidate = {
  itemType: "intake_session",
  itemId: "s1",
  matterId: null,
  stage: "existing_caller_handoff",
  lastActivityAt: chicago(5, 10), // Mon 10:00
  lastActivityLabel: "intake event",
  ownerUserId: null,
  watchedElsewhere: false,
};

describe("decideStall (c47)", () => {
  it("acceptance 1: a parked handoff with no activity for more than 1 business day is flagged", () => {
    expect(decideStall(handoff, null, chicago(6, 9, 59), DEFAULT_ALERT_SETTINGS, CAL).kind).toBe("none"); // 7.98 BH
    const d = decideStall(handoff, null, chicago(6, 10), DEFAULT_ALERT_SETTINGS, CAL);
    expect(d).toEqual({ kind: "flag", stuckBusinessHours: 8, expectedBusinessHours: 8 });
  });

  it("acceptance 2: an item another rule watches is never flagged", () => {
    expect(decideStall({ ...handoff, watchedElsewhere: true }, null, chicago(9, 10), DEFAULT_ALERT_SETTINGS, CAL).kind).toBe("none");
  });

  it("a stage with no configured duration is never flagged", () => {
    expect(decideStall({ ...handoff, itemType: "matter", stage: "retained" }, null, chicago(30, 10), DEFAULT_ALERT_SETTINGS, CAL).kind).toBe("none");
  });

  const watch: LiveWatch = { id: "w", status: "flagged", stage: "existing_caller_handoff", lastActivityAt: chicago(5, 10), checkBackAt: null };

  it("acceptance 7: a still-stalled item is not flagged again", () => {
    expect(decideStall(handoff, watch, chicago(9, 10), DEFAULT_ALERT_SETTINGS, CAL).kind).toBe("none");
  });

  it("acceptance 5: moving, new activity or finishing clears it", () => {
    expect(decideStall({ ...handoff, stage: "collect_facts" }, watch, chicago(7, 10), DEFAULT_ALERT_SETTINGS, CAL).kind).toBe("clear");
    expect(decideStall({ ...handoff, lastActivityAt: chicago(7, 9) }, watch, chicago(7, 10), DEFAULT_ALERT_SETTINGS, CAL).kind).toBe("clear");
    expect(decideStall(null, watch, chicago(7, 10), DEFAULT_ALERT_SETTINGS, CAL).kind).toBe("clear");
  });

  it("acceptance 3/4: a check-back holds re-flagging until the date, then re-flags if nothing changed", () => {
    const held: LiveWatch = { ...watch, status: "check_back", checkBackAt: chicago(10, 0) };
    expect(decideStall(handoff, held, chicago(9, 23), DEFAULT_ALERT_SETTINGS, CAL).kind).toBe("none");
    expect(decideStall(handoff, held, chicago(10, 0), DEFAULT_ALERT_SETTINGS, CAL).kind).toBe("reflag_after_check_back");
  });
});

describe("validateCheckBack", () => {
  const now = chicago(5, 10);
  it("needs a reason and a future date within the horizon", () => {
    expect(validateCheckBack("", chicago(10, 0), now, 90)).toMatch(/reason/);
    expect(validateCheckBack("Waiting on the court", chicago(4, 0), now, 90)).toMatch(/future/);
    expect(validateCheckBack("Waiting on the court", new Date(now.getTime() + 91 * 86_400_000), now, 90)).toMatch(/90 days/);
    expect(validateCheckBack("Waiting on the court until Oct 10", chicago(10, 0), now, 90)).toBeNull();
  });
});

describe("stallSummary", () => {
  it("states stage, time stuck, last activity and owner, factually", () => {
    const text = stallSummary(handoff, 8, 8, chicago(6, 10), null);
    expect(text).toContain("stage 'existing_caller_handoff' for 8 business hours (1 calendar days); expected at most 8.");
    expect(text).toContain("Last activity: intake event");
    expect(text).toContain("Owner: no owner.");
  });
});
