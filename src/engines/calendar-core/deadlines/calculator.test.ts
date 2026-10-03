import { describe, expect, it } from "vitest";
import type { DeadlineRuleSetConfig } from "@/db/tables/calendar-core";
import { addCourtDays, calculateDeadlines, courtCalendarFor, effectiveTriggerDate, isCourtDay, rollToCourtDay } from "./calculator";
import { EXAMPLE_RULE_SET, StubCourtRulesProvider, validateRuleSetConfig } from "./ruleSets";

// A TEST rule set (made-up values) — the calculator is exercised, not the law.
const config: DeadlineRuleSetConfig = {
  timeZone: "America/Chicago",
  nonCourtWeekdays: ["sat", "sun"],
  courtHolidays: ["2026-11-26"], // test holiday (Thursday)
  lateServiceCutoff: { localTime: "17:00", methods: ["e_service"], shiftDays: 1 },
  triggers: [{ key: "served", label: "Served", serviceMethods: ["e_service", "mail", "personal"] }],
  rules: [
    { key: "ten_days", label: "10 days", trigger: "served", eventType: "response_deadline", steps: [{ op: "add", amount: 10, unit: "calendar_days" }, { op: "roll", direction: "forward" }], dueTime: null, citation: "test" },
    { key: "five_court", label: "5 court days", trigger: "served", eventType: "response_deadline", steps: [{ op: "add", amount: 5, unit: "court_days" }], dueTime: "17:00", citation: "test" },
    {
      key: "mail_days",
      label: "7 days + mail",
      trigger: "served",
      eventType: "response_deadline",
      steps: [{ op: "add", amount: 7, unit: "calendar_days" }, { op: "add_for_service_method", days: { mail: 3 } }, { op: "roll", direction: "forward" }],
      dueTime: null,
      citation: "test",
    },
    { key: "monday_after", label: "Monday after 20", trigger: "served", eventType: "response_deadline", steps: [{ op: "add", amount: 20, unit: "calendar_days" }, { op: "next_weekday", weekday: "mon" }], dueTime: "10:00", citation: "test" },
  ],
};
const cal = courtCalendarFor(config);
const NOW = new Date("2026-10-01T12:00:00Z");

describe("court-day arithmetic", () => {
  it("knows weekends and holidays", () => {
    expect(isCourtDay("2026-10-03", cal)).toBe(false); // Saturday
    expect(isCourtDay("2026-11-26", cal)).toBe(false); // holiday
    expect(isCourtDay("2026-10-05", cal)).toBe(true);
  });
  it("counts court days, skipping weekends and holidays", () => {
    expect(addCourtDays("2026-10-02", 1, cal)).toBe("2026-10-05"); // Fri → Mon
    expect(addCourtDays("2026-11-25", 1, cal)).toBe("2026-11-27"); // skips the holiday
    expect(addCourtDays("2026-10-05", -1, cal)).toBe("2026-10-02");
  });
  it("rolls to the next or previous court day", () => {
    expect(rollToCourtDay("2026-10-03", "forward", cal)).toBe("2026-10-05");
    expect(rollToCourtDay("2026-10-03", "backward", cal)).toBe("2026-10-02");
  });
});

describe("late-service cutoff (configured, not hard-coded)", () => {
  it("e-service at/after the cutoff counts from the next day", () => {
    const at = new Date("2026-10-02T22:15:00Z"); // Fri 17:15 Chicago
    expect(effectiveTriggerDate(config, { key: "served", at, serviceMethod: "e_service" }).date).toBe("2026-10-03");
    expect(effectiveTriggerDate(config, { key: "served", at, serviceMethod: "personal" }).date).toBe("2026-10-02");
    expect(effectiveTriggerDate(config, { key: "served", at: new Date("2026-10-02T21:59:00Z"), serviceMethod: "e_service" }).date).toBe("2026-10-02");
  });
  it("a rule set without the cutoff never shifts", () => {
    const at = new Date("2026-10-02T23:30:00Z");
    expect(effectiveTriggerDate({ ...config, lateServiceCutoff: null }, { key: "served", at, serviceMethod: "e_service" }).date).toBe("2026-10-02");
  });
});

describe("calculateDeadlines", () => {
  const out = calculateDeadlines(config, { key: "served", at: new Date("2026-10-02T15:00:00Z"), serviceMethod: "mail" }, { now: NOW });
  const by = Object.fromEntries(out.results.map((r) => [r.ruleKey, r]));
  it("applies each step and explains it", () => {
    expect(out.triggerDate).toBe("2026-10-02");
    expect(by.ten_days!.date).toBe("2026-10-12"); // Oct 12 is a Monday
    expect(by.five_court!.date).toBe("2026-10-09");
    expect(by.five_court!.dueAt.toISOString()).toBe("2026-10-09T22:00:00.000Z");
    expect(by.mail_days!.date).toBe("2026-10-12"); // 9 + 3 = Oct 12
    expect(by.mail_days!.explanation.join(" ")).toMatch(/\+ 3 day\(s\) for service by mail/);
    expect(by.monday_after!.date).toBe("2026-10-26");
    expect(by.ten_days!.allDay).toBe(true);
  });
  it("warns when a result lands on a non-court day without a roll step", () => {
    const sat = calculateDeadlines(
      { ...config, rules: [{ ...config.rules[1]!, key: "x", steps: [{ op: "add", amount: 1, unit: "calendar_days" }] }] },
      { key: "served", at: new Date("2026-10-02T15:00:00Z") },
      { now: NOW }
    );
    expect(sat.results[0]!.warnings.join(" ")).toMatch(/sat/);
  });
  it("rejects unknown triggers and unlisted service methods", () => {
    expect(() => calculateDeadlines(config, { key: "nope", at: NOW })).toThrow(/Unknown trigger/);
    expect(() => calculateDeadlines(config, { key: "served", at: NOW, serviceMethod: "pigeon" })).toThrow(/not listed/);
  });
  it("can limit to chosen rules", () => {
    expect(calculateDeadlines(config, { key: "served", at: NOW }, { ruleKeys: ["ten_days"], now: NOW }).results).toHaveLength(1);
  });
});

describe("rule-set validation", () => {
  it("accepts the test set and the shipped example", () => {
    expect(validateRuleSetConfig(config)).toEqual([]);
    expect(validateRuleSetConfig(EXAMPLE_RULE_SET.config)).toEqual([]);
  });
  it("requires citations, known triggers and sane steps", () => {
    const bad = { ...config, rules: [{ ...config.rules[0]!, citation: "", trigger: "x", steps: [{ op: "add", amount: -1, unit: "calendar_days" } as const] }] };
    const errs = validateRuleSetConfig(bad).join(" ");
    expect(errs).toMatch(/citation/);
    expect(errs).toMatch(/unknown trigger/);
    expect(errs).toMatch(/amount/);
  });
  it("the example is clearly labelled unverified", () => {
    expect(EXAMPLE_RULE_SET.name).toMatch(/UNVERIFIED/);
    expect(EXAMPLE_RULE_SET.config.rules.every((r) => /VERIFY/.test(r.citation))).toBe(true);
  });
  it("the licensed-provider stub records and never fetches", async () => {
    const p = new StubCourtRulesProvider();
    expect((await p.fetchRuleSet("tx")).outcome).toBe("held");
    expect(p.requests).toEqual(["tx"]);
  });
});
