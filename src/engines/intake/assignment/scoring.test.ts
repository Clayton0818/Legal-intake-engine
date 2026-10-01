import { describe, it, expect } from "vitest";
import { DEFAULT_INTAKE_SETTINGS } from "../settings";
import { decideAssignment, eligibilityCodes, normalize, overrideCheck, rankCandidates, type AssignmentMatter, type Candidate } from "./scoring";

const S = DEFAULT_INTAKE_SETTINGS.assignment;
const matter: AssignmentMatter = { practiceArea: "family", matterType: "family_custody", language: "en", county: "travis" };

const lawyer = (userId: string, over: Partial<Candidate> = {}): Candidate => ({
  userId,
  displayName: userId.toUpperCase(),
  role: "attorney",
  status: "active",
  restrictedToUnassignedMatters: false,
  block: null,
  hasProfile: true,
  acceptsNewMatters: true,
  practiceAreas: ["family"],
  languages: ["en"],
  counties: [],
  seniority: 3,
  weeklyCap: null,
  outOfOffice: false,
  businessHoursSinceLastAssignment: 10,
  newMattersLast7Days: 0,
  weightedOpenMatters: 5,
  openMatterCount: 5,
  openTasks: 3,
  overdueTasks: 0,
  upcomingDeadlines: 1,
  isContinuityLawyer: false,
  ...over,
});

describe("c48 eligibility (hard filters)", () => {
  it("an ordinary family lawyer is eligible", () => {
    expect(eligibilityCodes(lawyer("a"), matter, S)).toEqual([]);
  });

  it("screened, restricted, blocked and inactive lawyers are never eligible", () => {
    expect(eligibilityCodes(lawyer("a", { block: "screened" }), matter, S)).toContain("screened");
    expect(eligibilityCodes(lawyer("a", { restrictedToUnassignedMatters: true }), matter, S)).toContain("restricted_to_unassigned");
    expect(eligibilityCodes(lawyer("a", { block: "other" }), matter, S)).toContain("blocked");
    expect(eligibilityCodes(lawyer("a", { status: "disabled" }), matter, S)).toContain("inactive");
    expect(eligibilityCodes(lawyer("a", { role: "intake_staff" }), matter, S)).toContain("not_attorney");
  });

  it("practice area, sub-type, language, county and out-of-office filter", () => {
    expect(eligibilityCodes(lawyer("a", { practiceAreas: ["immigration"] }), matter, S)).toContain("practice_area");
    expect(eligibilityCodes(lawyer("a", { practiceAreas: ["family", "family_divorce"] }), matter, S)).toContain("practice_area");
    expect(eligibilityCodes(lawyer("a", { practiceAreas: ["family", "family_custody"] }), matter, S)).toEqual([]);
    expect(eligibilityCodes(lawyer("a"), { ...matter, language: "es" }, S)).toContain("language");
    expect(eligibilityCodes(lawyer("a", { languages: ["en", "es"] }), { ...matter, language: "es" }, S)).toEqual([]);
    expect(eligibilityCodes(lawyer("a", { counties: ["hays"] }), matter, S)).toContain("jurisdiction");
    expect(eligibilityCodes(lawyer("a", { counties: ["hays"] }), { ...matter, county: null }, S)).toContain("jurisdiction");
    expect(eligibilityCodes(lawyer("a", { outOfOffice: true }), matter, S)).toContain("out_of_office");
    expect(eligibilityCodes(lawyer("a", { hasProfile: false }), matter, S)).toContain("no_profile");
  });

  it("cadence: weekly cap and minimum gap between new assignments", () => {
    expect(eligibilityCodes(lawyer("a", { newMattersLast7Days: 5 }), matter, S)).toContain("over_weekly_cap");
    expect(eligibilityCodes(lawyer("a", { newMattersLast7Days: 5, weeklyCap: 8 }), matter, S)).toEqual([]);
    expect(eligibilityCodes(lawyer("a", { businessHoursSinceLastAssignment: 1 }), matter, S)).toContain("min_gap");
  });
});

describe("c48 ranking", () => {
  it("normalises 0–100 across the set; all-equal is 100", () => {
    expect(normalize([1, 2, 3], true)).toEqual([0, 50, 100]);
    expect(normalize([1, 2, 3], false)).toEqual([100, 50, 0]);
    expect(normalize([4, 4], true)).toEqual([100, 100]);
  });

  it("prefers the lighter workload and longer time since last assignment", () => {
    const ranked = rankCandidates([lawyer("busy", { weightedOpenMatters: 20, openTasks: 10 }), lawyer("light", { weightedOpenMatters: 2, openTasks: 1 })], matter, S);
    expect(ranked[0]!.userId).toBe("light");
    expect(ranked[0]!.weighted.workload).toBeGreaterThan(ranked[1]!.weighted.workload);
    expect(ranked[0]!.total).toBeCloseTo(ranked[0]!.weighted.cadence + ranked[0]!.weighted.workload + ranked[0]!.weighted.other, 5);
  });

  it("client continuity and firm priorities count under 'other'", () => {
    const s = { ...S, weights: { cadence: 0, workload: 0, other: 100 }, priorities: [{ matterType: "family_custody", userIds: ["p"], bonus: 100 }] };
    expect(rankCandidates([lawyer("x"), lawyer("c", { isContinuityLawyer: true })], matter, s)[0]!.userId).toBe("c");
    expect(rankCandidates([lawyer("x"), lawyer("p")], matter, s)[0]!.userId).toBe("p");
  });

  it("ties break deterministically (longest since last assignment, fewer matters, id)", () => {
    const r = rankCandidates([lawyer("b"), lawyer("a")], matter, S);
    expect(r.map((x) => x.userId)).toEqual(["a", "b"]);
  });

  it("nobody eligible → unassigned, distinguishing 'over capacity' from 'no eligible'", () => {
    const cap = decideAssignment([lawyer("a", { newMattersLast7Days: 9 })], matter, S);
    expect(cap).toMatchObject({ winner: null, unassignedReason: "all_over_capacity" });
    const none = decideAssignment([lawyer("a", { practiceAreas: ["immigration"] })], matter, S);
    expect(none.unassignedReason).toBe("no_eligible");
  });

  it("notes when the continuity lawyer is not eligible", () => {
    const d = decideAssignment([lawyer("a"), lawyer("c", { isContinuityLawyer: true, outOfOffice: true })], matter, S);
    expect(d.winner?.userId).toBe("a");
    expect(d.notes[0]).toMatch(/Continuity ignored/);
  });

  it("overrides: screened/restricted never; others outside the list with a warning", () => {
    const d = decideAssignment([lawyer("a"), lawyer("s", { block: "screened" }), lawyer("o", { outOfOffice: true })], matter, S);
    expect(overrideCheck(d, "a")).toEqual({ allowed: true, warning: null, reason: null });
    expect(overrideCheck(d, "s").allowed).toBe(false);
    expect(overrideCheck(d, "o")).toMatchObject({ allowed: true, warning: expect.stringMatching(/out_of_office/) });
    expect(overrideCheck(d, "zzz").allowed).toBe(false);
  });
});
