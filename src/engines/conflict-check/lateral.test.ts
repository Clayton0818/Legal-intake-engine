import { describe, expect, it } from "vitest";
import { localDateString, toLocal } from "@/core";
import { lateralChecksComplete, lateralDueAt, lateralMatterAccess, screenPriorMatterEntry, startDatePassedIncomplete, type PriorMatterEntry } from "./lateral";
import { CAL } from "./testFixtures";

const ok: PriorMatterEntry = {
  clientNames: ["Maria Lopez"],
  adversePartyNames: ["Jose Lopez"],
  subjectCategory: "divorce",
  role: "lawyer",
  fromYear: 2021,
  toYear: 2023,
};

describe("screenPriorMatterEntry (c61 rule 2: names and general subject only)", () => {
  it("accepts names, a general subject, role and years", () => {
    expect(screenPriorMatterEntry(ok, 80, 2026)).toEqual({ ok: true, problems: [] });
    expect(screenPriorMatterEntry({ ...ok, subjectNote: "custody of two children" }, 80, 2026).ok).toBe(true);
  });

  it("refuses amounts, case numbers, contact details and facts", () => {
    for (const note of ["settled for $40,000", "Cause No. 2023-CI-12345", "call her at 512-555-0100", "because of the affair"]) {
      expect(screenPriorMatterEntry({ ...ok, subjectNote: note }, 80, 2026).ok, note).toBe(false);
    }
  });

  it("needs a client name and a subject from the list", () => {
    expect(screenPriorMatterEntry({ ...ok, clientNames: [" "] }, 80, 2026).problems).toContain("Enter at least one client name.");
    expect(screenPriorMatterEntry({ ...ok, subjectCategory: "murder trial" }, 80, 2026).ok).toBe(false);
  });

  it("limits free text and checks years", () => {
    expect(screenPriorMatterEntry({ ...ok, subjectNote: "x".repeat(81) }, 80, 2026).ok).toBe(false);
    expect(screenPriorMatterEntry({ ...ok, fromYear: 2024, toYear: 2020 }, 80, 2026).ok).toBe(false);
    expect(screenPriorMatterEntry({ ...ok, fromYear: 20 }, 80, 2026).ok).toBe(false);
  });
});

describe("lateralDueAt (c61 rule 4: business days before the start date)", () => {
  it("counts back over the weekend to the opening of the business day", () => {
    // Start Monday 2026-10-12; 5 business days earlier is Monday 2026-10-05, 09:00 Chicago.
    const due = lateralDueAt("2026-10-12", 5, CAL);
    expect(localDateString(due, CAL.timeZone)).toBe("2026-10-05");
    expect(toLocal(due, CAL.timeZone).hour).toBe(9);
  });

  it("skips firm holidays", () => {
    const due = lateralDueAt("2026-10-12", 1, { ...CAL, holidays: ["2026-10-09"] });
    expect(localDateString(due, CAL.timeZone)).toBe("2026-10-08");
  });

  it("rejects a malformed date", () => {
    expect(() => lateralDueAt("12/10/2026", 5, CAL)).toThrow();
  });
});

describe("lateral access and completion", () => {
  it("restricts matter access until complete, except the firm's exception list", () => {
    expect(lateralMatterAccess("awaiting_decisions", ["m1"])).toEqual({ unrestricted: false, allowedMatterIds: ["m1"] });
    expect(lateralMatterAccess("complete", ["m1"]).unrestricted).toBe(true);
    expect(lateralMatterAccess(null, []).unrestricted).toBe(true);
  });

  it("is complete when every check is open or declined (the hire is kept off that matter)", () => {
    expect(lateralChecksComplete([{ state: "open", closedReason: null }, { state: "closed", closedReason: "declined" }])).toBe(true);
    expect(lateralChecksComplete([{ state: "closed", closedReason: "pending_review" }])).toBe(false);
    expect(lateralChecksComplete([])).toBe(true);
  });

  it("flags a start date reached before completion, in the firm's time zone", () => {
    const now = new Date("2026-10-12T06:00:00Z"); // 01:00 on Oct 12 in Chicago
    expect(startDatePassedIncomplete("awaiting_list", "2026-10-12", now, CAL.timeZone)).toBe(true);
    expect(startDatePassedIncomplete("awaiting_list", "2026-10-13", now, CAL.timeZone)).toBe(false);
    expect(startDatePassedIncomplete("complete", "2026-10-01", now, CAL.timeZone)).toBe(false);
  });
});
