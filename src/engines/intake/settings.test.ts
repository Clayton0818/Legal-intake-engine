import { describe, it, expect } from "vitest";
import { applyIntakeSettingsPatch, DEFAULT_INTAKE_SETTINGS, intakeSettingsFrom, settingsVersion, stableStringify, validateFollowUpSequence, validateIntakeSettings } from "./settings";

describe("intake settings", () => {
  it("defaults are valid and include the founder's numbers as settings, not gates", () => {
    expect(validateIntakeSettings(DEFAULT_INTAKE_SETTINGS)).toEqual([]);
    expect(DEFAULT_INTAKE_SETTINGS.followUp.enabled).toBe(false);
    expect(DEFAULT_INTAKE_SETTINGS.booking.consultFeeDestination).toBeNull();
  });

  it("merges stored sections over defaults", () => {
    const s = intakeSettingsFrom({ engineSettings: { intake: { booking: { durationMinutes: 45 } } } });
    expect(s.booking.durationMinutes).toBe(45);
    expect(s.booking.bufferMinutes).toBe(DEFAULT_INTAKE_SETTINGS.booking.bufferMinutes);
    expect(s.assignment).toEqual(DEFAULT_INTAKE_SETTINGS.assignment);
  });

  it("rejects invalid patches with every error", () => {
    expect(() => applyIntakeSettingsPatch(DEFAULT_INTAKE_SETTINGS, { assignment: { weights: { cadence: 50, workload: 50, other: 50 } } })).toThrow(/sum to 100/);
    expect(() => applyIntakeSettingsPatch(DEFAULT_INTAKE_SETTINGS, { emergency: { ackWindowMinutes: 60 } })).toThrow(/between 5 and 30/);
    expect(() => applyIntakeSettingsPatch(DEFAULT_INTAKE_SETTINGS, { nope: {} } as never)).toThrow(/Unknown/);
    expect(applyIntakeSettingsPatch(DEFAULT_INTAKE_SETTINGS, { booking: { rebookOffers: 0 } }).booking.rebookOffers).toBe(0);
  });

  it("follow-up sequences can be shortened, never exceed the product caps", () => {
    expect(validateFollowUpSequence("x", { dayOffsets: [1, 3], channels: ["email"] })).toEqual([]);
    expect(validateFollowUpSequence("x", { dayOffsets: [1, 2, 3, 4, 5], channels: ["email"] }).join(" ")).toMatch(/at most 4/);
    expect(validateFollowUpSequence("x", { dayOffsets: [1, 20], channels: ["email"] }).join(" ")).toMatch(/14 days/);
    expect(validateFollowUpSequence("x", { dayOffsets: [4, 2], channels: ["email"] }).join(" ")).toMatch(/increase/);
    expect(validateFollowUpSequence("x", { dayOffsets: [1], channels: [] }).join(" ")).toMatch(/channel/);
  });

  it("settings hash is stable regardless of key order", () => {
    expect(stableStringify({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
    expect(settingsVersion({ a: 1, b: 2 })).toBe(settingsVersion({ b: 2, a: 1 }));
    expect(settingsVersion({ a: 1 })).not.toBe(settingsVersion({ a: 2 }));
  });
});
