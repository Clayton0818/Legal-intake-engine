import { describe, expect, it } from "vitest";
import { mustKeepList, reconfirmDueAt, validateDisclosure } from "./interests";

describe("validateDisclosure (c97)", () => {
  const ok = { interestType: "business", name: "Hill Country Title LLC", relationship: "owner" };

  it("accepts a business, family or other interest", () => {
    expect(validateDisclosure(ok)).toEqual([]);
    expect(validateDisclosure({ interestType: "family", name: "Sam Rivera", relationship: "sibling", startsOn: "2020-01-01" })).toEqual([]);
  });

  it("never accepts amounts, values or percentages", () => {
    expect(validateDisclosure({ ...ok, relationship: "owns 40%" })).toContain("Do not enter amounts, values or percentages.");
    expect(validateDisclosure({ ...ok, identifiers: { registration: "$50,000" } })).toContain("Do not enter amounts, values or percentages.");
  });

  it("validates type, required fields, identifiers and dates", () => {
    expect(validateDisclosure({ ...ok, interestType: "crypto" }).length).toBeGreaterThan(0);
    expect(validateDisclosure({ ...ok, name: " " }).length).toBeGreaterThan(0);
    expect(validateDisclosure({ ...ok, identifiers: { ssn: "x" } })).toContain("Unknown identifier 'ssn'.");
    expect(validateDisclosure({ ...ok, startsOn: "2024-05-01", endsOn: "2023-01-01" })).toContain("The end date is before the start date.");
    expect(validateDisclosure({ ...ok, startsOn: "May 2024" })).toContain("Dates must be YYYY-MM-DD.");
  });
});

describe("reconfirmDueAt", () => {
  it("adds calendar months, clamping to the month's last day", () => {
    expect(reconfirmDueAt(new Date("2026-01-31T12:00:00Z"), 1).toISOString()).toBe("2026-02-28T12:00:00.000Z");
    expect(reconfirmDueAt(new Date("2026-03-15T12:00:00Z"), 12).toISOString()).toBe("2027-03-15T12:00:00.000Z");
  });
});

describe("mustKeepList", () => {
  it("covers lawyers by default, staff only when the firm includes them", () => {
    expect(mustKeepList("attorney")).toBe(true);
    expect(mustKeepList("intake_staff")).toBe(false);
    expect(mustKeepList("intake_staff", true)).toBe(true);
    expect(mustKeepList("read_only", true)).toBe(false);
  });
});
