import { describe, expect, it } from "vitest";
import { CAL, chicago } from "../testFixtures";
import { DEFAULT_ALERT_SETTINGS } from "../settings";
import { deadlineBeatsLadder, firstStepAt, isLadderDecision, planStep } from "./plan";

const steps = DEFAULT_ALERT_SETTINGS.ladder;

describe("client chase ladder (c42 / c46)", () => {
  it("the first reminder runs when the window lapses; later gaps count business hours", () => {
    const lapsed = chicago(2, 16); // Fri 16:00
    expect(firstStepAt(lapsed, steps, CAL).toISOString()).toBe(lapsed.toISOString());
    const first = planStep(steps, 0, 0, lapsed, CAL)!;
    expect(first).toMatchObject({ index: 0, reminderNumber: 1, flagLevel: 1 });
    // 16 business hours after Fri 16:00 = Tue 16:00 (Fri 1h + Mon 8h + Tue 7h).
    expect(first.nextAt!.toISOString()).toBe(chicago(6, 16).toISOString());
  });

  it("the second reminder is level 2; the last step is the lawyer's decision and has no next step", () => {
    const second = planStep(steps, 1, 1, chicago(6, 16), CAL)!;
    expect(second).toMatchObject({ reminderNumber: 2, flagLevel: 2 });
    const last = planStep(steps, 2, 2, chicago(8, 16), CAL)!;
    expect(last.step.action).toBe("lawyer_decides");
    expect(last.reminderNumber).toBeNull();
    expect(last.nextAt).toBeNull();
    expect(planStep(steps, 3, 2, chicago(9, 9), CAL)).toBeNull();
  });

  it("the real-clock safety net fires when a linked deadline arrives before the next step", () => {
    const now = chicago(5, 10);
    expect(deadlineBeatsLadder(null, chicago(6, 10), now)).toBe(false);
    expect(deadlineBeatsLadder(chicago(5, 9), chicago(6, 10), now)).toBe(true); // already arrived
    expect(deadlineBeatsLadder(chicago(5, 20), chicago(6, 10), now)).toBe(true); // before the next step
    expect(deadlineBeatsLadder(chicago(9, 9), chicago(6, 10), now)).toBe(false);
    expect(deadlineBeatsLadder(chicago(9, 9), null, now)).toBe(false); // last step: only an arrived deadline
  });

  it("only offers decisions that are never a legal step", () => {
    expect(isLadderDecision("extend_window")).toBe(true);
    expect(isLadderDecision("withdraw")).toBe(false);
    expect(isLadderDecision("send_non_engagement_letter")).toBe(false);
  });
});
