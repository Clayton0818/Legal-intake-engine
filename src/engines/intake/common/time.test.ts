import { describe, it, expect } from "vitest";
import { CAL, chi } from "../__tests__/fixtures";
import { addBusinessDays, businessWindows, localWeekday, overlaps } from "./time";

describe("calendar helpers", () => {
  it("business windows skip weekends and holidays", () => {
    const w = businessWindows(CAL, chi(2026, 11, 25, 12), chi(2026, 11, 30, 10));
    expect(w.map((x) => x.date)).toEqual(["2026-11-25", "2026-11-27", "2026-11-30"]);
    expect(w[0]!.start).toEqual(chi(2026, 11, 25, 12));
    expect(w[2]!.end).toEqual(chi(2026, 11, 30, 10));
  });

  it("adds business days (end of the Nth business day)", () => {
    expect(addBusinessDays(chi(2026, 10, 9, 10), 1, CAL)).toEqual(chi(2026, 10, 12, 17));
    expect(addBusinessDays(chi(2026, 11, 25, 10), 1, CAL)).toEqual(chi(2026, 11, 27, 17));
    expect(addBusinessDays(chi(2026, 10, 5, 10), 0, CAL)).toEqual(chi(2026, 10, 5, 10));
  });

  it("weekday and overlap", () => {
    expect(localWeekday(chi(2026, 10, 5, 1), "America/Chicago")).toBe("mon");
    expect(overlaps(chi(2026, 10, 5, 9), chi(2026, 10, 5, 10), chi(2026, 10, 5, 10), chi(2026, 10, 5, 11))).toBe(false);
    expect(overlaps(chi(2026, 10, 5, 9), chi(2026, 10, 5, 10, 1), chi(2026, 10, 5, 10), chi(2026, 10, 5, 11))).toBe(true);
  });
});
