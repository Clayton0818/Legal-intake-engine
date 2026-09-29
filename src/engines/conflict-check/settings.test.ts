import { describe, expect, it } from "vitest";
import { DEFAULT_CONFLICT_SETTINGS, readConflictSettings } from "./settings";

describe("readConflictSettings", () => {
  it("returns the spec defaults (business hours: 1 day intake, 2 days open matters)", () => {
    const s = readConflictSettings({ engineSettings: {} });
    expect(s).toEqual({ ...DEFAULT_CONFLICT_SETTINGS });
    expect(s.decisionDueBusinessHoursIntake).toBe(8);
    expect(s.decisionDueBusinessHoursMatter).toBe(16);
  });

  it("reads firm overrides and clamps unsafe values", () => {
    const s = readConflictSettings({
      engineSettings: { "conflict-check": { orgLinkDepth: 9, exportLinkHours: 1000, lateralEntryMaxChars: 5, waiverDueBusinessHours: 24 } },
    });
    expect(s.orgLinkDepth).toBe(3);
    expect(s.exportLinkHours).toBe(168);
    expect(s.lateralEntryMaxChars).toBe(20);
    expect(s.waiverDueBusinessHours).toBe(24);
  });

  it("never lets conflict declines auto-send (c62 rule 4)", () => {
    const s = readConflictSettings({ engineSettings: { "conflict-check": { letterAutoSendTypes: ["conflict", "out_of_scope"] } } });
    expect(s.letterAutoSendTypes).toEqual(["out_of_scope"]);
  });

  it("defaults export redaction to summary for anything but 'full'", () => {
    expect(readConflictSettings({ engineSettings: { "conflict-check": { defaultExportRedaction: "names" } } }).defaultExportRedaction).toBe("summary");
  });
});

describe("validateConflictSettingsPatch", () => {
  it("accepts known settings with valid values", async () => {
    const { validateConflictSettingsPatch } = await import("./settings");
    const r = validateConflictSettingsPatch({ decisionDueBusinessHoursIntake: 4, letterAutoSendTypes: ["out_of_scope"], defaultExportRedaction: "full" });
    expect(r.errors).toEqual([]);
    expect(r.values.decisionDueBusinessHoursIntake).toBe(4);
  });

  it("refuses unknown keys, the history-import flag, bad values and auto-sending conflict letters", async () => {
    const { validateConflictSettingsPatch } = await import("./settings");
    const r = validateConflictSettingsPatch({
      nope: 1,
      historyImportConfirmedAt: "2026-01-01",
      decisionDueBusinessHoursIntake: -1,
      letterAutoSendTypes: ["conflict"],
      referralSources: [{ name: "x" }],
    });
    expect(r.errors).toHaveLength(5);
    expect(r.values).toEqual({});
  });
});
