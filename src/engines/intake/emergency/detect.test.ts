import { describe, it, expect } from "vitest";
import "../gates";
import { activePhraseList, detectEmergencies, detectionsByTrack, mergePhraseLists, normalizeForMatch, parsePhraseList, trackFor } from "./detect";

describe("c66 emergency detection", () => {
  const { lists, approved } = activePhraseList();

  it("uses the draft list while attorney review is pending (fails towards alerting)", () => {
    expect(approved).toBe(false);
    expect(lists.safety_dv?.length).toBeGreaterThan(0);
  });

  it("detects safety, urgent legal and deadline risk, case- and accent-insensitively", () => {
    expect(detectEmergencies("He CHOKED ME last night", lists).map((d) => d.category)).toEqual(["safety_dv"]);
    expect(detectEmergencies("Tengo una audiencia mañana", lists).map((d) => d.category)).toEqual(["urgent_court_soon"]);
    expect(detectEmergencies("me pego ayer", lists).map((d) => d.category)).toEqual(["safety_dv"]);
    expect(detectEmergencies("this happened years ago, is it too late?", lists).map((d) => d.track)).toEqual(["deadline_risk"]);
    expect(detectEmergencies("I want to ask about custody schedules", lists)).toEqual([]);
  });

  it("matches whole words only", () => {
    expect(detectEmergencies("the kidnapped plot in my novel", lists).length).toBe(1);
    expect(detectEmergencies("unsuitable schedule", lists)).toEqual([]);
  });

  it("the classifier's safety flag alone also triggers (either detector counts)", () => {
    const d = detectEmergencies("nothing obvious", lists, { safetyFlag: true });
    expect(d).toEqual([{ category: "safety_threat", track: "safety", detector: "classifier", matchedPhrase: null }]);
    expect(detectEmergencies("x", lists, { categories: ["urgent_served", "bogus"] }).map((x) => x.category)).toEqual(["urgent_served"]);
  });

  it("groups by track with safety first", () => {
    const d = detectEmergencies("he has a gun and I have court tomorrow", lists);
    expect(detectionsByTrack(d).map((g) => g.track)).toEqual(["safety", "urgent_legal"]);
  });

  it("parses the gate format and lets firms add (never remove) phrases", () => {
    const parsed = parsePhraseList("safety_dv: a | b\nnot_a_category: x\nno colon line");
    expect(parsed).toEqual({ safety_dv: ["a", "b"] });
    const merged = mergePhraseLists(parsed, { safety_dv: [" c "], junk: ["y"] });
    expect(merged.safety_dv).toEqual(["a", "b", "c"]);
    expect(trackFor("urgent_lockout")).toBe("urgent_legal");
    expect(normalizeForMatch("  Él  ME   Golpeó! ")).toBe(" el me golpeo ");
  });
});
