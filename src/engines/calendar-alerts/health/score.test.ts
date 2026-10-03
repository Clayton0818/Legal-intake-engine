import { describe, expect, it } from "vitest";
import { DEFAULT_HEALTH } from "../settings";
import { bandFor, computeHealth, fallingSharply, rankValue, shouldRaiseHealthFlag, silenceScore, subscore, type HealthSignals } from "./score";

const healthy: HealthSignals = {
  replyTargetsMissed: 0,
  replyPromisesMissed: 0,
  overdueFirmTasks: 0,
  overdueCriticalFirmTasks: 0,
  openStalls: 0,
  businessDaysSinceUpdate: 2,
  openNonResponses: 0,
  overdueClientTasks: 0,
  missingDocuments: null,
  delayedSignOffs: null,
  retainerIssues: null,
  businessDaysSinceClientActivity: 1,
};

describe("computeHealth (c53)", () => {
  it("a quiet, healthy matter is green with no reasons; unmeasured signals are listed", () => {
    const r = computeHealth(healthy, DEFAULT_HEALTH, { newMatter: false });
    expect(r).toMatchObject({ score: 100, band: "green", firmReasons: [], clientReasons: [] });
    expect(r.notMeasured).toEqual(["missingDocuments", "signOffs", "retainer"]);
  });

  it("acceptance 1: client silence and missing documents are both explained in plain words", () => {
    const r = computeHealth({ ...healthy, businessDaysSinceClientActivity: 6.4, missingDocuments: 2 }, DEFAULT_HEALTH, { newMatter: false });
    expect(r.clientReasons).toEqual(expect.arrayContaining(["client hasn't replied in 6 business days", "2 document requests outstanding"]));
  });

  it("overall = the lower sub-score, so a problem on either side shows", () => {
    const r = computeHealth({ ...healthy, replyPromisesMissed: 2, overdueCriticalFirmTasks: 1, overdueFirmTasks: 1, businessDaysSinceUpdate: 25 }, DEFAULT_HEALTH, { newMatter: false });
    expect(r.firmSubscore).toBeLessThan(r.clientSubscore!);
    expect(r.score).toBe(r.firmSubscore);
    expect(r.band).toBe("red");
    expect(r.firmReasons[0]).toMatch(/reply promises to the client missed|firm task overdue|last update/);
    expect(r.firmReasons).toHaveLength(3);
  });

  it("new matters show 'not enough data' and are never banded", () => {
    expect(computeHealth({ ...healthy, openStalls: 5 }, DEFAULT_HEALTH, { newMatter: true })).toMatchObject({ score: null, band: "insufficient_data" });
  });

  it("acceptance 6: unmeasured signals have their weight redistributed", () => {
    // Only the two silence components measured on the client side, weights 30+… → the score is their weighted mean.
    expect(subscore([{ key: "a", weight: 30, score: 50, reason: null }, { key: "b", weight: 10, score: null, reason: null }])).toBe(50);
    expect(subscore([{ key: "b", weight: 10, score: null, reason: null }])).toBeNull();
  });

  it("DV fairness: an unmeasured activity signal never costs points", () => {
    const r = computeHealth({ ...healthy, businessDaysSinceClientActivity: null }, DEFAULT_HEALTH, { newMatter: false });
    expect(r.notMeasured).toContain("sinceClientActivity");
    expect(r.clientSubscore).toBe(100);
  });
});

describe("bands, trend, ranking", () => {
  it("bands at 70/40", () => {
    expect([bandFor(70, DEFAULT_HEALTH), bandFor(69, DEFAULT_HEALTH), bandFor(39, DEFAULT_HEALTH), bandFor(null, DEFAULT_HEALTH)]).toEqual(["green", "amber", "red", "insufficient_data"]);
  });

  it("acceptance 3: a 25-point drop inside the window is 'falling sharply' even while amber", () => {
    expect(fallingSharply(55, [80, 70, null], DEFAULT_HEALTH)).toBe(true);
    expect(fallingSharply(55, [70], DEFAULT_HEALTH)).toBe(false);
    expect(fallingSharply(null, [90], DEFAULT_HEALTH)).toBe(false);
    expect(fallingSharply(55, [], DEFAULT_HEALTH)).toBe(false);
  });

  it("acceptance 4: an equal score with a near court deadline ranks higher", () => {
    expect(rankValue(30, true, DEFAULT_HEALTH)).toEqual({ multiplierPct: 150, rank: 105 });
    expect(rankValue(30, false, DEFAULT_HEALTH)).toEqual({ multiplierPct: 100, rank: 70 });
  });

  it("silence: full marks up to 5 business days, zero at 20", () => {
    expect([silenceScore(5), silenceScore(12.5), silenceScore(20)]).toEqual([100, 50, 0]);
  });
});

describe("shouldRaiseHealthFlag (one flag per transition)", () => {
  const now = new Date("2026-10-14T15:00:00Z");
  const base = { unhealthy: true, openFlag: false, checkBackAt: null, everFlagged: false, healthyRunBusinessDays: 0, quietBusinessDays: 5, now };
  it("acceptance 2: the first transition to red flags once", () => {
    expect(shouldRaiseHealthFlag(base)).toBe(true);
    expect(shouldRaiseHealthFlag({ ...base, openFlag: true })).toBe(false);
    expect(shouldRaiseHealthFlag({ ...base, unhealthy: false })).toBe(false);
  });
  it("re-flags only after a healthy quiet period, and never before a check-back date", () => {
    expect(shouldRaiseHealthFlag({ ...base, everFlagged: true, healthyRunBusinessDays: 2 })).toBe(false);
    expect(shouldRaiseHealthFlag({ ...base, everFlagged: true, healthyRunBusinessDays: 5 })).toBe(true);
    expect(shouldRaiseHealthFlag({ ...base, checkBackAt: new Date("2026-10-20T00:00:00Z") })).toBe(false);
  });
});
