import { describe, it, expect } from "vitest";
import {
  DEFAULT_PRACTICE_AREAS,
  enabledPracticeAreas,
  isPracticeAreaEnabled,
  practiceAreaForClassifierLabel,
  practiceAreaLabel,
  validatePracticeAreas,
} from "./practiceAreas";

describe("practice areas (c102)", () => {
  it("defaults to Family Law only (pilot, c103)", () => {
    expect(DEFAULT_PRACTICE_AREAS).toEqual(["family"]);
    expect(practiceAreaLabel("family")).toBe("Family Law");
  });

  it("reads enabled areas in canonical order and ignores unknown values", () => {
    expect(enabledPracticeAreas({ enabledPracticeAreas: ["personal_injury", "retired_area", "family"] })).toEqual([
      "family",
      "personal_injury",
    ]);
    expect(isPracticeAreaEnabled({ enabledPracticeAreas: ["family"] }, "immigration")).toBe(false);
  });

  it("validates settings input", () => {
    expect(validatePracticeAreas(["immigration", "family", "family"])).toEqual(["family", "immigration"]);
    expect(() => validatePracticeAreas(["tax"])).toThrow(/tax/);
  });

  it("maps classifier labels onto packs", () => {
    expect(practiceAreaForClassifierLabel("family_divorce")).toBe("family");
    expect(practiceAreaForClassifierLabel("immigration")).toBe("immigration");
    expect(practiceAreaForClassifierLabel("expunction")).toBeNull();
    expect(practiceAreaForClassifierLabel(null)).toBeNull();
  });
});
