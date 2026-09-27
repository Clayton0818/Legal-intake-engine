import { describe, it, expect } from "vitest";
import { DEFAULT_FIRM_SETTINGS, engineSetting, toBusinessCalendar, validateSettingsPatch, withDefaults } from "./firmSettings";
import { addBusinessHours, fromLocal } from "./businessHours";

describe("firm settings defaults (founder decisions, not gates)", () => {
  it("carries the founder's numbers", () => {
    expect(DEFAULT_FIRM_SETTINGS).toMatchObject({
      timeZone: "America/Chicago",
      firmReplyHours: 24,
      clientPromiseHours: 48,
      deadlineQuestionReplyHours: 24,
      retainerFloorCents: 450_000,
      enabledPracticeAreas: ["family"],
    });
  });

  it("withDefaults() marks a firm with no row as not persisted", () => {
    const s = withDefaults(undefined, "t-1");
    expect(s).toMatchObject({ tenantId: "t-1", persisted: false, retainerFloorCents: 450_000 });
  });

  it("builds a working business calendar (Mon–Fri 9–5 Chicago)", () => {
    const cal = toBusinessCalendar(DEFAULT_FIRM_SETTINGS);
    const friEvening = fromLocal(2026, 9, 25, 18, 0, "America/Chicago");
    expect(addBusinessHours(friEvening, 1, cal)).toEqual(fromLocal(2026, 9, 28, 10, 0, "America/Chicago"));
  });
});

describe("validateSettingsPatch", () => {
  it("accepts valid changes and normalises practice areas", () => {
    expect(validateSettingsPatch({ enabledPracticeAreas: ["immigration", "family"] }).enabledPracticeAreas).toEqual([
      "family",
      "immigration",
    ]);
  });

  it("rejects bad numbers, calendars and an internal target later than the client promise", () => {
    expect(() => validateSettingsPatch({ firmReplyHours: 0 })).toThrow(/positive/);
    expect(() => validateSettingsPatch({ retainerFloorCents: 10.5 })).toThrow(/cents/);
    expect(() => validateSettingsPatch({ timeZone: "Nowhere/Land" })).toThrow(/time zone/);
    expect(() => validateSettingsPatch({ firmReplyHours: 72, clientPromiseHours: 48 })).toThrow(/promised/);
    expect(() => validateSettingsPatch({ enabledPracticeAreas: ["tax"] })).toThrow(/tax/);
  });
});

describe("engineSetting", () => {
  it("reads one engine's bag with a fallback", () => {
    const s = { engineSettings: { "billing-trust": { invoiceDay: 1 } } };
    expect(engineSetting(s, "billing-trust", "invoiceDay", 15)).toBe(1);
    expect(engineSetting(s, "billing-trust", "missing", 15)).toBe(15);
    expect(engineSetting(s, "intake", "invoiceDay", 15)).toBe(15);
  });
});
