import { describe, expect, it } from "vitest";
import { CAL, CLOCK_SETTINGS, TZ, chicago } from "../testFixtures";
import { checkpointDue, formatReplyBy, planReplyClock, replyFlagRecipients } from "./plan";

describe("planReplyClock", () => {
  it("c43: a Friday-evening message is flagged 24 business hours later, not on the weekend", () => {
    const p = planReplyClock({ startedAt: chicago(2, 18, 30), tier: "standard", settings: CLOCK_SETTINGS, calendar: CAL, deadlines: [], safetyUrgent: false, now: chicago(2, 18, 30) });
    expect(p.flagAt.toISOString()).toBe(chicago(7, 17).toISOString()); // Mon+Tue+Wed
    expect(p.promiseAt.toISOString()).toBe(chicago(12, 17).toISOString()); // 6 business days (Mon 5 – Mon 12)
    expect(p.immediate).toBeNull();
  });

  it("c44: 12h flag / 24h promise", () => {
    const p = planReplyClock({ startedAt: chicago(5, 9), tier: "deadline", settings: CLOCK_SETTINGS, calendar: CAL, deadlines: [], safetyUrgent: false, now: chicago(5, 9) });
    expect(p.flagAt.toISOString()).toBe(chicago(6, 13).toISOString());
    expect(p.promiseAt.toISOString()).toBe(chicago(7, 17).toISOString());
  });

  it("c44 acceptance 2: Friday 17:00 question about a confirmed Monday 09:00 filing alerts immediately", () => {
    const filing = { at: chicago(5, 9), source: "calendar" as const, title: "Filing deadline", calendarEventId: "e1" };
    const p = planReplyClock({ startedAt: chicago(2, 17), tier: "deadline", settings: CLOCK_SETTINGS, calendar: CAL, deadlines: [filing], safetyUrgent: false, now: chicago(2, 17) });
    expect(p.immediate).toEqual({ reason: "deadline_before_reply", deadline: filing });
  });

  it("c44: a client-stated date in the past alerts immediately; client-stated dates are ignored by the standard tier", () => {
    const stated = { at: chicago(1, 0), source: "client_stated" as const, title: "Hearing (client-stated)" };
    const deadline = planReplyClock({ startedAt: chicago(2, 10), tier: "deadline", settings: CLOCK_SETTINGS, calendar: CAL, deadlines: [stated], safetyUrgent: false, now: chicago(2, 10) });
    expect(deadline.immediate?.reason).toBe("deadline_passed");
    const standard = planReplyClock({ startedAt: chicago(2, 10), tier: "standard", settings: CLOCK_SETTINGS, calendar: CAL, deadlines: [stated], safetyUrgent: false, now: chicago(2, 10) });
    expect(standard.immediate).toBeNull();
  });

  it("c43 rule 8: a confirmed hearing inside the 48 BH window and the safety flag both alert immediately", () => {
    const hearing = { at: chicago(6, 10), source: "calendar" as const, title: "Hearing" };
    expect(planReplyClock({ startedAt: chicago(5, 9), tier: "standard", settings: CLOCK_SETTINGS, calendar: CAL, deadlines: [hearing], safetyUrgent: false, now: chicago(5, 9) }).immediate?.reason).toBe("deadline_in_window");
    expect(planReplyClock({ startedAt: chicago(5, 9), tier: "standard", settings: CLOCK_SETTINGS, calendar: CAL, deadlines: [], safetyUrgent: true, now: chicago(5, 9) }).immediate?.reason).toBe("safety");
  });
});

describe("checkpoints and recipients", () => {
  const clock = { status: "open", flagAt: chicago(6, 9), promiseAt: chicago(7, 9), flaggedAt: null, promiseMissedAt: null };
  it("fires each step once, only while open", () => {
    expect(checkpointDue(clock, "flag", chicago(6, 8))).toBe(false);
    expect(checkpointDue(clock, "flag", chicago(6, 9))).toBe(true);
    expect(checkpointDue({ ...clock, flaggedAt: chicago(6, 9) }, "flag", chicago(6, 10))).toBe(false);
    expect(checkpointDue({ ...clock, status: "replied" }, "promise", chicago(8, 9))).toBe(false);
  });
  it("routes per tier and falls back to the firm admin", () => {
    const base = { lawyerId: "L", adminIds: ["A"], managingIds: ["M"] };
    expect(replyFlagRecipients({ ...base, tier: "standard", step: "flag" })).toEqual(["L", "A"]);
    expect(replyFlagRecipients({ ...base, tier: "standard", step: "promise" })).toEqual(["A", "M"]);
    expect(replyFlagRecipients({ ...base, tier: "deadline", step: "flag" })).toEqual(["L"]);
    expect(replyFlagRecipients({ ...base, tier: "deadline", step: "promise" })).toEqual(["L", "A"]);
    expect(replyFlagRecipients({ ...base, lawyerId: null, tier: "deadline", step: "immediate" })).toEqual(["A"]);
  });
  it("formats the concrete promise in the firm's zone", () => {
    expect(formatReplyBy(chicago(7, 17), TZ)).toBe("Wednesday, October 7 at 5:00 PM CDT");
  });
});
