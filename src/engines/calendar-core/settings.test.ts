import { describe, expect, it } from "vitest";
import { readCalendarCoreSettings, validateCalendarCoreSettingsPatch, DEFAULT_CALENDAR_CORE_SETTINGS } from "./settings";
import { addDays, addMonths, daysBetween, endOfLocalDay, instantAt, parseDate, weekdayOf } from "./dates";
import { isIsoDate, mapHandledError } from "./http";
import { CalendarCoreError } from "./errors";

describe("calendar-core settings", () => {
  it("defaults to the 180/90/60/30/14/7-day reminder ladder", () => {
    expect(readCalendarCoreSettings({ engineSettings: {} })).toEqual(DEFAULT_CALENDAR_CORE_SETTINGS);
  });
  it("normalises stored values and drops junk", () => {
    const s = readCalendarCoreSettings({
      engineSettings: { "calendar-core": { limitationReminderDays: [7, 30, 30, -1, "x"], limitationTaskDueLocalTime: "25:00", limitationVerifierUserIds: ["nope"] } },
    });
    expect(s.limitationReminderDays).toEqual([30, 7]);
    expect(s.limitationTaskDueLocalTime).toBe("00:00");
    expect(s.limitationVerifierUserIds).toEqual([]);
  });
  it("validates patches strictly", () => {
    expect(validateCalendarCoreSettingsPatch({ limitationReminderDays: [90, 30] }).errors).toEqual([]);
    expect(validateCalendarCoreSettingsPatch({ nope: 1 }).errors[0]).toMatch(/Unknown/);
    expect(validateCalendarCoreSettingsPatch({ limitationPeriods: [{ key: "pi", label: "PI", years: 2, months: 0, days: 0, citation: "" }] }).errors).toHaveLength(1);
    expect(validateCalendarCoreSettingsPatch({ limitationSupervisorAtDays: 5, limitationCriticalAtDays: 10 }).errors[0]).toMatch(/must not be larger/);
  });
});

describe("calendar dates", () => {
  it("adds days and months, clamping month ends", () => {
    expect(addDays("2026-12-30", 3)).toBe("2027-01-02");
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2024-01-31", 1)).toBe("2024-02-29");
    expect(daysBetween("2026-01-01", "2027-01-01")).toBe(365);
    expect(weekdayOf("2026-10-03")).toBe("sat");
  });
  it("rejects impossible dates", () => {
    expect(() => parseDate("2026-02-29")).toThrow();
    expect(isIsoDate("2026-02-29")).toBe(false);
    expect(isIsoDate("2028-02-29")).toBe(true);
  });
  it("converts local times at the edge", () => {
    expect(instantAt("2026-10-05", "17:00", "America/Chicago").toISOString()).toBe("2026-10-05T22:00:00.000Z");
    expect(endOfLocalDay("2026-10-05", "America/Chicago").toISOString()).toBe("2026-10-06T04:59:59.999Z");
  });
  it("maps engine errors to HTTP", () => {
    expect(mapHandledError(new CalendarCoreError("x", 403))?.status).toBe(403);
    expect(mapHandledError(new Error("x"))).toBeNull();
  });
});
