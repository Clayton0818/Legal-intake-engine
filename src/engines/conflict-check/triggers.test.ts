import { describe, expect, it } from "vitest";
import { detectReopened, isClosedState, mattersToRecheck, nextRecheckAt } from "./triggers";
import { worker } from "./worker";
import { CHECK_TRIGGERS } from "./types";
import { entry, matterInv, inquiryInv } from "./testFixtures";

describe("c58 triggers", () => {
  it("covers every point a conflict can appear", () => {
    expect(CHECK_TRIGGERS).toEqual(expect.arrayContaining(["intake", "party_added", "reopened", "lateral_hire", "periodic"]));
    const hooks = worker.tickHooks!.map((h) => h.name);
    expect(hooks).toEqual(expect.arrayContaining(["conflict-check.index_sync", "conflict-check.reopened_matters", "conflict-check.ensure_periodic_recheck"]));
    expect(Object.keys(worker.scheduledTaskHandlers!)).toContain("conflict-check.periodic_recheck");
  });

  it("detects a reopened matter only after it was seen closed", () => {
    expect(detectReopened(undefined, { stage: "retained", closedAt: null })).toBe(false);
    expect(detectReopened({ lastStage: "closed", lastClosedAt: new Date() }, { stage: "retained", closedAt: null })).toBe(true);
    expect(detectReopened({ lastStage: "retained", lastClosedAt: null }, { stage: "retained", closedAt: null })).toBe(false);
    expect(detectReopened({ lastStage: "closed", lastClosedAt: null }, { stage: "closed", closedAt: null })).toBe(false);
    expect(isClosedState({ stage: "retained", closedAt: new Date() })).toBe(true);
  });

  it("schedules the next periodic run on the real clock", () => {
    const now = new Date("2026-10-03T12:00:00Z"); // a Saturday: still runs
    expect(nextRecheckAt(now, 24).toISOString()).toBe("2026-10-04T12:00:00.000Z");
  });

  it("re-checks only open matters that match a newly indexed party", () => {
    const newcomer = entry({ displayName: "Robert Smith", partyId: "p-new", involvements: [inquiryInv("s-new")] });
    const open = [
      { matterId: "m1", searched: [{ name: "Bob Smith", role: "opposing_party", partyId: "p1" }] },
      { matterId: "m2", searched: [{ name: "Jane Doe", role: "opposing_party", partyId: "p2" }] },
    ];
    expect([...mattersToRecheck(open, [newcomer]).keys()]).toEqual(["m1"]);
  });

  it("ignores a new party known only from the matter itself, and self-matches", () => {
    const addedHere = entry({ displayName: "Robert Smith", partyId: "p-new", involvements: [matterInv("m1", "opposing_party")] });
    const open = [{ matterId: "m1", searched: [{ name: "Robert Smith", role: "opposing_party", partyId: "p-new" }] }];
    expect(mattersToRecheck(open, [addedHere]).size).toBe(0);
    expect(mattersToRecheck(open, []).size).toBe(0);
  });
});
