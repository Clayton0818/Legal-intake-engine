import { describe, expect, it } from "vitest";
import { DEFAULT_FIRM_SETTINGS } from "@/core/firmSettings";
import { FAMILY_LAW_PACK } from "../packs/family";
import type { PracticeAreaPack } from "../packs/types";
import { diffPacks, packState, planAreaChange, validateAcceptance } from "./plan";
import { activePack, activePacks, readPublishedPacks, withPublishedPacks, type PublishedPack } from "./published";

describe("planAreaChange", () => {
  const available = ["family"] as const;

  it("enables and disables in canonical order", () => {
    const p = planAreaChange({ current: ["family"], requested: ["family", "family"], available });
    expect(p).toMatchObject({ ok: true, next: ["family"], enabled: [], disabled: [] });
  });

  it("requires at least one area", () => {
    expect(planAreaChange({ current: ["family"], requested: [], available }).errors).toContain("At least one practice area must stay switched on.");
  });

  it("rejects unknown ids", () => {
    const p = planAreaChange({ current: ["family"], requested: ["family", "tax", 3], available });
    expect(p.ok).toBe(false);
    expect(p.errors[0]).toMatch(/Unknown practice area\(s\): tax, 3/);
  });

  it("cannot switch on an area whose pack has not shipped, but an area already on stays allowed", () => {
    const on = planAreaChange({ current: ["family"], requested: ["family", "immigration"], available });
    expect(on.ok).toBe(false);
    expect(on.errors[0]).toMatch(/Immigration is not available yet/);
    const keep = planAreaChange({ current: ["family", "immigration"], requested: ["immigration"], available });
    expect(keep).toMatchObject({ ok: true, next: ["immigration"], disabled: ["family"], enabled: [] });
  });

  it("reports what was switched on", () => {
    const p = planAreaChange({ current: ["immigration"], requested: ["immigration", "family"], available });
    expect(p).toMatchObject({ ok: true, next: ["family", "immigration"], enabled: ["family"] });
  });
});

describe("pack versions", () => {
  const latest = { version: "0.2.0", contentHash: "h2" };
  it("packState", () => {
    expect(packState(null, null)).toBe("no_pack");
    expect(packState(latest, null)).toBe("not_accepted");
    expect(packState(latest, { version: "0.2.0", contentHash: "h2" })).toBe("current");
    expect(packState(latest, { version: "0.1.0", contentHash: "h1" })).toBe("update_available");
    expect(packState(latest, { version: "0.2.0", contentHash: "other" })).toBe("update_available");
  });

  it("validateAcceptance requires the reviewed version to be the current one", () => {
    expect(validateAcceptance({ latest, accepted: { version: "0.1.0", contentHash: "h1" }, version: "0.2.0", contentHash: "h2" })).toEqual([]);
    expect(validateAcceptance({ latest, accepted: null, version: "0.1.0", contentHash: "h1" })[0]).toMatch(/changed since you reviewed/);
    expect(validateAcceptance({ latest, accepted: latest, version: "0.2.0", contentHash: "h2" })).toContain("This version is already accepted.");
    expect(validateAcceptance({ latest: null, accepted: null, version: "x", contentHash: "y" })).toEqual(["There is no pack for this practice area."]);
  });

  it("diffPacks summarises what changed per section", () => {
    expect(diffPacks(FAMILY_LAW_PACK, FAMILY_LAW_PACK)).toEqual([]);
    const next = JSON.parse(JSON.stringify(FAMILY_LAW_PACK)) as PracticeAreaPack;
    next.version = "0.2.0";
    next.intake.questions = next.intake.questions.filter((q) => q.id !== "major_assets");
    next.intake.questions[0]!.prompt.draft = "Changed wording";
    next.deadlines.rules.push({ ...next.deadlines.rules[0]!, id: "new_rule" });
    next.billing.offeredFeeTypes = ["retainer_hourly"];
    const d = diffPacks(FAMILY_LAW_PACK, next);
    expect(d.find((s) => s.section === "Intake questions")).toEqual({ section: "Intake questions", added: [], removed: ["major_assets"], changed: ["safe_now"] });
    expect(d.find((s) => s.section === "Rule references")!.added).toEqual(["new_rule"]);
    expect(d.find((s) => s.section === "Billing defaults")!.changed).toEqual(["billing"]);
  });
});

describe("published packs (the consumption contract)", () => {
  const pub: PublishedPack = { practiceArea: "family", version: "0.1.0", contentHash: "h", acceptedAt: "2026-10-01T00:00:00.000Z", pack: FAMILY_LAW_PACK };

  it("round-trips through engine settings without touching other engines' bags", () => {
    const es = withPublishedPacks({ intake: { a: 1 }, "all-engines": { other: true } }, { family: pub });
    expect(es.intake).toEqual({ a: 1 });
    expect(es["all-engines"]!.other).toBe(true);
    const settings = { ...DEFAULT_FIRM_SETTINGS, engineSettings: es };
    expect(readPublishedPacks(settings).family?.version).toBe("0.1.0");
    expect(activePack(settings, "family")?.pack.id).toBe("family");
    expect(activePacks(settings)).toHaveLength(1);
  });

  it("a switched-off area is not active but keeps its snapshot", () => {
    const settings = { ...DEFAULT_FIRM_SETTINGS, enabledPracticeAreas: ["immigration"], engineSettings: withPublishedPacks({}, { family: pub }) };
    expect(activePack(settings, "family")).toBeNull();
    expect(activePacks(settings)).toEqual([]);
    expect(readPublishedPacks(settings).family).toBeDefined();
  });

  it("ignores junk", () => {
    expect(readPublishedPacks({ engineSettings: {} })).toEqual({});
    expect(readPublishedPacks({ engineSettings: { "all-engines": { practiceAreaPacks: [1] } } })).toEqual({});
    expect(readPublishedPacks({ engineSettings: { "all-engines": { practiceAreaPacks: { tax: pub, family: { version: 1 } } } } })).toEqual({});
  });
});
