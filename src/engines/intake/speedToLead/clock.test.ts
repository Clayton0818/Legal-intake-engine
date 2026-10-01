import { describe, it, expect } from "vitest";
import { CAL, chi } from "../__tests__/fixtures";
import { attemptsSatisfy, businessMinutesRemaining, computeDueSoonAt, computeResponseTarget, summarizeResponseTimes } from "./clock";

const targets = { inHoursMinutes: 15, afterHoursMinutesAfterOpen: 60 };

describe("c69 response target (business hours)", () => {
  it("in hours: arrival + 15 business minutes", () => {
    expect(computeResponseTarget(chi(2026, 10, 5, 10, 0), CAL, targets)).toEqual(chi(2026, 10, 5, 10, 15));
  });

  it("near closing the target rolls into the next business morning", () => {
    expect(computeResponseTarget(chi(2026, 10, 5, 16, 55), CAL, targets)).toEqual(chi(2026, 10, 6, 9, 10));
  });

  it("after hours / weekend / holiday: next opening + 60 business minutes", () => {
    expect(computeResponseTarget(chi(2026, 10, 9, 18, 0), CAL, targets)).toEqual(chi(2026, 10, 12, 10, 0));
    expect(computeResponseTarget(chi(2026, 11, 25, 20, 0), CAL, targets)).toEqual(chi(2026, 11, 27, 10, 0));
  });

  it("due-soon at half the business time; remaining minutes go negative when overdue", () => {
    const start = chi(2026, 10, 5, 10, 0);
    const target = computeResponseTarget(start, CAL, targets);
    expect(computeDueSoonAt(start, target, 0.5, CAL)).toEqual(new Date(start.getTime() + 7.5 * 60_000));
    expect(businessMinutesRemaining(chi(2026, 10, 5, 10, 5), target, CAL)).toBe(10);
    expect(businessMinutesRemaining(chi(2026, 10, 5, 10, 45), target, CAL)).toBe(-30);
  });
});

describe("c69 attempts", () => {
  it("two attempts count when on different channels or spaced far enough apart", () => {
    const rule = { needed: 2, minSpacingMinutes: 60 };
    expect(attemptsSatisfy([{ at: chi(2026, 10, 5, 10), channel: "phone" }, { at: chi(2026, 10, 5, 10, 5), channel: "phone" }], rule, CAL)).toBe(false);
    expect(attemptsSatisfy([{ at: chi(2026, 10, 5, 10), channel: "phone" }, { at: chi(2026, 10, 5, 10, 5), channel: "sms" }], rule, CAL)).toBe(true);
    expect(attemptsSatisfy([{ at: chi(2026, 10, 5, 10), channel: "phone" }, { at: chi(2026, 10, 5, 11, 30), channel: "phone" }], rule, CAL)).toBe(true);
  });
});

describe("c69 metrics", () => {
  it("excludes emergencies and non-inquiries; median in business minutes", () => {
    const s = chi(2026, 10, 5, 10);
    const t = chi(2026, 10, 5, 10, 15);
    const rows = [
      { channel: "sms", startedAt: s, targetAt: t, firstHumanContactAt: chi(2026, 10, 5, 10, 10), outcome: "contacted" as const },
      { channel: "sms", startedAt: s, targetAt: t, firstHumanContactAt: chi(2026, 10, 5, 10, 30), outcome: "contacted" as const },
      { channel: "sms", startedAt: s, targetAt: t, firstHumanContactAt: null, outcome: "attempted" as const },
      { channel: "sms", startedAt: s, targetAt: t, firstHumanContactAt: null, outcome: "bypassed_emergency" as const },
      { channel: "web_chat", startedAt: s, targetAt: t, firstHumanContactAt: null, outcome: "not_an_inquiry" as const },
    ];
    expect(summarizeResponseTimes(rows, CAL)).toEqual([
      { channel: "sms", inquiries: 3, contacted: 2, attempted: 1, metTarget: 1, medianBusinessMinutes: 20 },
    ]);
  });
});
