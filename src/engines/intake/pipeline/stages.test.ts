import { describe, it, expect } from "vitest";
import {
  defaultPipeline,
  labelAt,
  resolveFirmStage,
  sortStages,
  SYSTEM_STAGES,
  validateHideMoves,
  validateMove,
  validatePipeline,
  type PipelineStageDef,
} from "./stages";

const split = (): PipelineStageDef[] => {
  const base = defaultPipeline();
  return [
    ...base,
    { key: "consult_booked_paid", label: "Paid consult booked", systemStage: "consultation_scheduled", order: 1.5, colour: "#123456", isDefaultForSystemStage: false, hidden: false },
  ];
};

describe("c14 pipeline stages", () => {
  it("the default pipeline has one valid firm stage per system stage", () => {
    const p = defaultPipeline();
    expect(p).toHaveLength(SYSTEM_STAGES.length);
    expect(validatePipeline(p)).toEqual([]);
  });

  it("firms can relabel, reorder and split a system stage", () => {
    const p = split().map((s) => (s.key === "prospective" ? { ...s, label: "New lead" } : s));
    expect(validatePipeline(p)).toEqual([]);
    expect(sortStages(p).map((s) => s.key).indexOf("consult_booked_paid")).toBe(2);
  });

  it("required system stages can never be hidden", () => {
    const p = defaultPipeline().map((s) => (s.systemStage === "retained" ? { ...s, hidden: true } : s));
    expect(validatePipeline(p).join(" ")).toMatch(/'retained' is required/);
  });

  it("optional system stages may be hidden but still need a firm stage", () => {
    const hidden = defaultPipeline().map((s) => (s.systemStage === "did_not_schedule" ? { ...s, hidden: true } : s));
    expect(validatePipeline(hidden)).toEqual([]);
    const removed = defaultPipeline().filter((s) => s.systemStage !== "did_not_schedule");
    expect(validatePipeline(removed).join(" ")).toMatch(/needs at least one firm stage/);
  });

  it("labels are unique ignoring case and keys must be well-formed", () => {
    const p = split().map((s) => (s.key === "consult_booked_paid" ? { ...s, label: "PROSPECTIVE" } : s));
    expect(validatePipeline(p).join(" ")).toMatch(/used twice/);
    expect(validatePipeline([{ ...defaultPipeline()[0]!, key: "Bad Key" }, ...defaultPipeline().slice(1)]).join(" ")).toMatch(/lowercase/);
  });

  it("client labels on conflict-sensitive stages may not mention conflicts (Rule 1.05)", () => {
    const p = defaultPipeline().map((s) => (s.systemStage === "declined_conflict" ? { ...s, clientLabel: "Conflict found" } : s));
    expect(validatePipeline(p).join(" ")).toMatch(/never mention conflicts/);
  });

  it("each system stage has exactly one default firm stage", () => {
    const p = split().map((s) => (s.key === "consult_booked_paid" ? { ...s, isDefaultForSystemStage: true } : s));
    expect(validatePipeline(p).join(" ")).toMatch(/exactly one default/);
  });

  it("a cap on the number of stages applies", () => {
    expect(validatePipeline(split(), 5).join(" ")).toMatch(/At most 5/);
  });

  it("Retained and Declined (conflict) are reachable only through their product steps", () => {
    const p = defaultPipeline();
    expect(validateMove(p, "retained", "manual")).toMatchObject({ ok: false });
    expect(validateMove(p, "retained", "open_matter")).toMatchObject({ ok: true });
    expect(validateMove(p, "declined_conflict", "system")).toMatchObject({ ok: false });
    expect(validateMove(p, "declined_conflict", "conflict_decision")).toMatchObject({ ok: true });
    expect(validateMove(p, "pending_review", "manual")).toMatchObject({ ok: true });
    expect(validateMove(p, "nope", "manual")).toMatchObject({ ok: false });
  });

  it("hidden stages cannot be targeted manually", () => {
    const p = defaultPipeline().map((s) => (s.key === "did_not_schedule" ? { ...s, hidden: true } : s));
    expect(validateMove(p, "did_not_schedule", "manual")).toMatchObject({ ok: false });
    expect(validateMove(p, "did_not_schedule", "system")).toMatchObject({ ok: true });
  });

  it("a stored firm stage that no longer maps falls back to the default", () => {
    const p = split();
    expect(resolveFirmStage(p, "consultation_scheduled", "consult_booked_paid")?.key).toBe("consult_booked_paid");
    expect(resolveFirmStage(p, "prospective", "consult_booked_paid")?.key).toBe("prospective");
    expect(resolveFirmStage(p, "consultation_scheduled", null)?.key).toBe("consultation_scheduled");
  });

  it("hiding a stage with matters requires a target in the same system stage", () => {
    const prev = split();
    const next = prev.map((s) => (s.key === "consult_booked_paid" ? { ...s, hidden: true } : s));
    const counts = { consult_booked_paid: 3 };
    expect(validateHideMoves(prev, next, counts, {})).toHaveLength(1);
    expect(validateHideMoves(prev, next, counts, { consult_booked_paid: "prospective" })[0]?.reason).toMatch(/same system stage/);
    expect(validateHideMoves(prev, next, counts, { consult_booked_paid: "consultation_scheduled" })).toEqual([]);
    expect(validateHideMoves(prev, next, {}, {})).toEqual([]);
  });

  it("history shows the label that applied at the time", () => {
    const v1 = { effectiveFrom: new Date("2026-01-01"), stages: defaultPipeline() };
    const v2 = { effectiveFrom: new Date("2026-06-01"), stages: defaultPipeline().map((s) => (s.key === "prospective" ? { ...s, label: "New lead" } : s)) };
    expect(labelAt([v1, v2], new Date("2026-03-01"), "prospective")).toBe("Prospective");
    expect(labelAt([v1, v2], new Date("2026-07-01"), "prospective")).toBe("New lead");
  });
});
