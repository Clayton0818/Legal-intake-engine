import { describe, it, expect } from "vitest";
import { compareRuleSets, decideFit, declineTerminalState, defaultFitRules, evaluateRule, matchReferrals, validateFitRules, type FitFacts, type FitGuards, type FitRule } from "./rules";

const rules = defaultFitRules({ enabledPracticeAreas: ["family"], counties: ["travis", "hays"] });
const facts = (over: Partial<FitFacts> = {}): FitFacts => ({
  practiceArea: "family",
  matterType: "family_divorce",
  county: "travis",
  language: "en",
  answers: {},
  enabledPracticeAreas: ["family"],
  capacityAvailable: true,
  ...over,
});
const guards = (over: Partial<FitGuards> = {}): FitGuards => ({
  confidence: 0.95,
  confidenceThreshold: 0.85,
  autoDeclineEnabled: true,
  autoDeclineApproved: true,
  emergencyOpen: false,
  conflictPending: false,
  ...over,
});

describe("c73 rule evaluation", () => {
  it("pass / fail / unknown / skipped", () => {
    const county = rules.find((r) => r.id === "county_served")!;
    expect(evaluateRule(county, facts())).toBe("pass");
    expect(evaluateRule(county, facts({ county: "harris" }))).toBe("fail");
    expect(evaluateRule(county, facts({ county: null }))).toBe("unknown");
    expect(evaluateRule({ ...county, enabled: false }, facts())).toBe("skipped");
    const cap = rules.find((r) => r.kind === "capacity")!;
    expect(evaluateRule(cap, facts({ capacityAvailable: null }))).toBe("skipped");
    expect(evaluateRule(cap, facts({ capacityAvailable: false }))).toBe("fail");
  });

  it("a practice area switched off for the firm fails the practice-area rule (c102)", () => {
    const r: FitRule = { id: "pa", kind: "practice_area", field: "practiceArea", operator: "exists", autoDeclineAllowed: true, description: "x" };
    expect(evaluateRule(r, facts({ practiceArea: "personal_injury" }))).toBe("fail");
  });

  it("firm-defined minimum criteria on answers", () => {
    const r: FitRule = { id: "min_res", kind: "criteria", field: "answers.monthsInTexas", operator: "gte", value: 6, autoDeclineAllowed: false, description: "Six months' Texas residence" };
    expect(evaluateRule(r, facts({ answers: { monthsInTexas: 8 } }))).toBe("pass");
    expect(evaluateRule(r, facts({ answers: { monthsInTexas: "2" } }))).toBe("fail");
    expect(evaluateRule(r, facts({ answers: { monthsInTexas: "soon" } }))).toBe("unknown");
    expect(evaluateRule(r, facts())).toBe("unknown");
  });
});

describe("c73 outcomes", () => {
  it("fit when every rule passes", () => {
    expect(decideFit(rules, facts(), guards()).outcome).toBe("fit");
  });

  it("clear no-fit with high confidence declines (acceptance 1) and names the rule", () => {
    const d = decideFit(rules, facts({ practiceArea: "personal_injury" }), guards());
    expect(d.outcome).toBe("no_fit");
    expect(d.decliningRuleIds).toEqual(["practice_area_offered"]);
    expect(declineTerminalState(d.results)).toBe("out_of_scope");
  });

  it("low confidence goes to a lawyer (acceptance 2)", () => {
    expect(decideFit(rules, facts({ practiceArea: "personal_injury" }), guards({ confidence: 0.6 })).outcome).toBe("borderline");
    expect(decideFit(rules, facts({ practiceArea: "personal_injury" }), guards({ confidence: null })).outcome).toBe("borderline");
  });

  it("unknown county is borderline, never declined (acceptance 3)", () => {
    expect(decideFit(rules, facts({ county: null }), guards()).outcome).toBe("borderline");
  });

  it("capacity alone never declines (acceptance 4)", () => {
    const d = decideFit(rules, facts({ capacityAvailable: false }), guards());
    expect(d.outcome).toBe("borderline");
    expect(d.reasons).toContain("capacity");
  });

  it("emergency, pending conflict, firm switch or pending attorney review keep it with a lawyer", () => {
    const pi = facts({ practiceArea: "personal_injury" });
    expect(decideFit(rules, pi, guards({ emergencyOpen: true })).outcome).toBe("borderline");
    expect(decideFit(rules, pi, guards({ conflictPending: true })).outcome).toBe("borderline");
    expect(decideFit(rules, pi, guards({ autoDeclineEnabled: false })).outcome).toBe("borderline");
    const pending = decideFit(rules, pi, guards({ autoDeclineApproved: false }));
    expect(pending.outcome).toBe("borderline");
    expect(pending.reasons).toContain("borderline:auto_decline_pending_review");
  });

  it("a fail on a rule not marked auto-decline is borderline", () => {
    const d = decideFit(rules, facts({ language: "vi" }), guards());
    expect(defaultFitRules({ enabledPracticeAreas: ["family"], languages: ["en", "es"] }).find((r) => r.id === "language_supported")?.autoDeclineAllowed).toBe(false);
    expect(d.outcome).toBe("fit"); // default rules have no language rule without a list
    const withLang = defaultFitRules({ enabledPracticeAreas: ["family"], languages: ["en", "es"] });
    expect(decideFit(withLang, facts({ language: "vi" }), guards()).outcome).toBe("borderline");
    expect(declineTerminalState([{ ruleId: "c", kind: "county", status: "fail", autoDeclineAllowed: true, description: "", field: "county" }])).toBe("not_eligible");
  });
});

describe("c73 rule editing", () => {
  it("validates rules: ids, fields, conflicts never a rule, capacity never auto-declines", () => {
    expect(validateFitRules(rules)).toEqual([]);
    const bad: FitRule[] = [
      { id: "Bad", kind: "county", field: "county", operator: "in", value: ["x"], autoDeclineAllowed: true, description: "d" },
      { id: "conflict_check", kind: "criteria", field: "answers.x", operator: "exists", autoDeclineAllowed: false, description: "d" },
      { id: "cap", kind: "capacity", field: "capacity", operator: "exists", autoDeclineAllowed: true, description: "d" },
      { id: "f", kind: "criteria", field: "secret", operator: "in", autoDeclineAllowed: false, description: "" },
    ];
    const errors = validateFitRules(bad).join(" ");
    expect(errors).toMatch(/lowercase/);
    expect(errors).toMatch(/never a fit rule/);
    expect(errors).toMatch(/capacity can never decline/);
    expect(errors).toMatch(/not supported/);
    expect(errors).toMatch(/needs a description/);
    expect(errors).toMatch(/needs a value/);
  });

  it("the test panel shows only what would change", () => {
    const draft = rules.filter((r) => r.id !== "county_served");
    const changes = compareRuleSets([{ id: "s1", facts: facts({ county: "harris" }), guards: guards() }, { id: "s2", facts: facts(), guards: guards() }], rules, draft);
    expect(changes).toEqual([{ id: "s1", before: "no_fit", after: "fit" }]);
  });
});

describe("c73 referrals (the firm's own list)", () => {
  it("matches by practice area and county, most specific first, active only", () => {
    const entries = [
      { id: "1", name: "Any Law", practiceAreas: [], counties: [], contact: "x", active: true },
      { id: "2", name: "PI Travis", practiceAreas: ["personal_injury"], counties: ["travis"], contact: "x", active: true },
      { id: "3", name: "PI Hays", practiceAreas: ["personal_injury"], counties: ["hays"], contact: "x", active: true },
      { id: "4", name: "Old", practiceAreas: [], counties: [], contact: "x", active: false },
    ];
    expect(matchReferrals(entries, "personal_injury", "travis").map((e) => e.id)).toEqual(["2", "1"]);
    expect(matchReferrals(entries, null, null).map((e) => e.id)).toEqual(["1"]);
  });
});
