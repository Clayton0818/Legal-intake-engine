import { describe, expect, it } from "vitest";
import { conditionsFor, DEFAULT_ROLE_MATRIX, evaluateRoleMatrix, intakeDirective, resolveRoleSought, sideOf } from "./coreCheck";
import { classifyOutcome } from "./decisions";
import { UNAPPLIED_ASSESSMENT } from "./ruleTable";
import { isRoleMatrix, readConflictSettings, validateConflictSettingsPatch } from "./settings";
import { hit, inquiryInv, matterInv } from "./testFixtures";

const priorConsultWithCaller = hit({ searchedRole: "prospective_client", strength: 1, involvements: [inquiryInv("s-old")] });
const priorClientIsOpposing = hit({ searchedRole: "opposing_party", strength: 1, involvements: [matterInv("m1", "client", "former")] });

describe("role matrix (c3)", () => {
  it("resolves the role sought, falling back to every row for unknown roles", () => {
    expect(resolveRoleSought(null, DEFAULT_ROLE_MATRIX)).toEqual({ key: "representation", known: true });
    expect(resolveRoleSought("mediator", DEFAULT_ROLE_MATRIX)).toEqual({ key: "mediation", known: true });
    expect(resolveRoleSought("arbitrator", DEFAULT_ROLE_MATRIX)).toEqual({ key: null, known: false });
  });

  it("classifies sides of the new matter", () => {
    expect(sideOf("prospective_client")).toBe("caller");
    expect(sideOf("opposing_party")).toBe("opposing");
    expect(sideOf("related_party")).toBe("other");
  });

  it("treats a prior consultation as a barring contact even without engagement", () => {
    expect(conditionsFor("opposing", inquiryInv("s1"), ["clients", "matters", "prior_consultations"])).toContain(
      "prior_consultation_with_opposing_party"
    );
    expect(conditionsFor("opposing", inquiryInv("s1"), ["clients", "matters"])).toEqual([]);
  });

  it("the same prior contact is harmless for representation but bars mediation", () => {
    const rep = evaluateRoleMatrix({ hits: [priorConsultWithCaller], roleSought: "representation", applied: true });
    expect(rep.barred).toBe(false);
    const med = evaluateRoleMatrix({ hits: [priorConsultWithCaller], roleSought: "mediation", applied: true });
    expect(med.barred).toBe(true);
    expect(med.findings.map((f) => f.condition)).toContain("prior_initial_meeting_with_either_party");
  });

  it("bars representation against a former client", () => {
    const ev = evaluateRoleMatrix({ hits: [priorClientIsOpposing], roleSought: "petitioner", applied: true });
    expect(ev.barred).toBe(true);
    expect(ev.findings[0]!.condition).toBe("prior_representation_of_opposing_party");
  });

  it("weak matches never make a finding strong enough for 'definite'", () => {
    const ev = evaluateRoleMatrix({ hits: [{ ...priorClientIsOpposing, strength: 0.6 }], roleSought: "representation", applied: true });
    expect(ev.findings.length).toBeGreaterThan(0);
    expect(ev.barred).toBe(false);
  });
});

describe("tri-state outcome (c3)", () => {
  const base = { searched: [{ name: "X", role: "opposing_party" }], trigger: "intake" as const, historyImportConfirmed: true, assessment: UNAPPLIED_ASSESSMENT };

  it("is clear only with no hits and nothing unknown", () => {
    expect(classifyOutcome({ ...base, hits: [] }).outcome).toBe("clear");
  });

  it("stays 'possible' while the role matrix is not applied (rules.conflicts pending)", () => {
    const roleEvaluation = evaluateRoleMatrix({ hits: [priorClientIsOpposing], applied: false });
    expect(roleEvaluation.barred).toBe(true);
    expect(classifyOutcome({ ...base, hits: [priorClientIsOpposing], roleEvaluation }).outcome).toBe("possible");
  });

  it("becomes 'definite' once the matrix is applied and a strong hit meets a barring condition", () => {
    const roleEvaluation = evaluateRoleMatrix({ hits: [priorClientIsOpposing], applied: true });
    expect(classifyOutcome({ ...base, hits: [priorClientIsOpposing], roleEvaluation }).outcome).toBe("definite");
  });
});

describe("intake directive (c3 / intake-flow.yaml)", () => {
  const opts = { pendingCopyKey: "p", definiteCopyKey: "d", referral: { name: "Bar LRS", contact: "555-0100" } };
  it("clear proceeds", () => {
    expect(intakeDirective("clear", opts)).toMatchObject({ next: "practice_area_router", intake: "proceed", scheduling: "allowed" });
  });
  it("possible pauses, escalates to a human, allows only a callback", () => {
    expect(intakeDirective("possible", opts)).toMatchObject({ next: "escalate_conflict", intake: "pause", scheduling: "callback_only", requiresHuman: true, clientCopyKey: "p" });
  });
  it("definite stops, blocks scheduling and gives a neutral referral", () => {
    const d = intakeDirective("definite", opts);
    expect(d).toMatchObject({ next: "declined_conflict", intake: "stop", scheduling: "blocked", clientCopyKey: "d" });
    expect(d.referral).toEqual({ destination: "state_bar_referral_service", name: "Bar LRS", contact: "555-0100" });
  });
});

describe("role matrix settings (c3)", () => {
  it("defaults to the spec's example matrix", () => {
    expect(readConflictSettings({ engineSettings: {} }).roleMatrix).toEqual(DEFAULT_ROLE_MATRIX);
  });
  it("refuses unknown conditions and weak definite thresholds", () => {
    expect(isRoleMatrix({ representation: { barred_by: ["made_up"] } })).toBe(false);
    const { errors } = validateConflictSettingsPatch({ roleMatrix: { x: { barred_by: ["nope"] } }, definiteMinStrength: 0.3, conflictSources: ["gossip"] });
    expect(errors).toHaveLength(3);
    const ok = validateConflictSettingsPatch({ roleMatrix: { arbitration: { barred_by: ["prior_representation_of_either_party"] } } });
    expect(ok.errors).toEqual([]);
  });
});
