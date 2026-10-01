import { describe, expect, it } from "vitest";
import {
  classifyOutcome,
  combineGates,
  computeCheckGate,
  interestOwners,
  validateDecision,
  waiverTimerAction,
  type DecisionContext,
  type DecisionInput,
} from "./decisions";
import { UNAPPLIED_ASSESSMENT, type RuleAssessment } from "./ruleTable";
import { hit } from "./testFixtures";

const loaded = { historyImportConfirmed: true, assessment: UNAPPLIED_ASSESSMENT, trigger: "intake" as const };

describe("classifyOutcome (the system never clears a conflict it has doubts about)", () => {
  it("is clear only with no hits, every party named, history loaded and the index write ok", () => {
    expect(classifyOutcome({ ...loaded, hits: [], searched: [{ name: "A", role: "prospective_client" }] })).toEqual({ outcome: "clear", reasons: [] });
  });

  it("is possible for any hit while the rule table is not approved", () => {
    expect(classifyOutcome({ ...loaded, hits: [hit()], searched: [] }).outcome).toBe("possible");
  });

  it("is possible when a party was not named (c56 rule 7)", () => {
    const r = classifyOutcome({ ...loaded, hits: [], searched: [{ name: "", role: "opposing_party", nameUnknown: true }] });
    expect(r).toEqual({ outcome: "possible", reasons: ["name_unknown"] });
  });

  it("is possible until the firm's history import is confirmed (c56 rule 9)", () => {
    expect(classifyOutcome({ ...loaded, historyImportConfirmed: false, hits: [], searched: [] }).reasons).toEqual(["history_not_loaded"]);
  });

  it("is possible when the index write failed", () => {
    expect(classifyOutcome({ ...loaded, indexWriteFailed: true, hits: [], searched: [] }).outcome).toBe("possible");
  });

  it("is definite only when an APPLIED rule table says so", () => {
    const applied: RuleAssessment = { applied: true, rows: [], definite: true, consent: "allowed" };
    expect(classifyOutcome({ ...loaded, assessment: applied, hits: [hit()], searched: [] }).outcome).toBe("definite");
    const unapplied = { ...UNAPPLIED_ASSESSMENT, definite: true };
    expect(classifyOutcome({ ...loaded, assessment: unapplied, hits: [hit()], searched: [] }).outcome).toBe("possible");
  });
});

describe("interestOwners", () => {
  it("collects lawyers whose own interests a check concerns", () => {
    expect(
      interestOwners([
        hit({ sourceType: "interest", ownerUserId: "u1" }),
        hit({ searchedRole: "lawyer_interest", ownerUserId: "u2" }),
        hit({ ownerUserId: "u3" }),
        hit({ sourceType: "interest", ownerUserId: "u1" }),
      ])
    ).toEqual(["u1", "u2"]);
  });
});

function ctx(over: Partial<DecisionContext> = {}): DecisionContext {
  return {
    check: { outcome: "possible", status: "open", hits: [hit()] },
    decider: { userId: "atty", canDecide: true },
    assessment: UNAPPLIED_ASSESSMENT,
    overrideGateApproved: false,
    otherDecidersAvailable: true,
    ...over,
  };
}

const clearIt: DecisionInput = { decision: "cleared", reasonCode: "false_positive_different_person" };

describe("validateDecision (c59)", () => {
  it("accepts a valid clearance by a conflicts attorney", () => {
    expect(validateDecision(clearIt, ctx())).toEqual({ ok: true, overrideFlag: false });
  });

  it("rejects anyone without the conflicts-attorney role (acceptance 7)", () => {
    const r = validateDecision(clearIt, ctx({ decider: { userId: "x", canDecide: false } }));
    expect(r.ok).toBe(false);
  });

  it("refuses to edit a decided check; a superseding decision is the only way (acceptance 8)", () => {
    expect(validateDecision(clearIt, ctx({ check: { outcome: "possible", status: "decided", hits: [hit()] } })).ok).toBe(false);
    expect(
      validateDecision({ ...clearIt, supersedesDecisionId: "d1" }, ctx({ check: { outcome: "possible", status: "decided", hits: [hit()] }, supersedesValid: true })).ok
    ).toBe(true);
    expect(validateDecision({ ...clearIt, supersedesDecisionId: "d1" }, ctx({ supersedesValid: false })).ok).toBe(false);
  });

  it("requires a reason code valid for the decision, and text for 'other'", () => {
    expect(validateDecision({ decision: "cleared", reasonCode: "consent_permitted" }, ctx()).ok).toBe(false);
    expect(validateDecision({ decision: "cleared", reasonCode: "other" }, ctx()).ok).toBe(false);
    expect(validateDecision({ decision: "cleared", reasonCode: "other", reasonText: "Explained" }, ctx()).ok).toBe(true);
  });

  it("requires every consenting client for 'proceed with written consent'", () => {
    expect(validateDecision({ decision: "proceed_with_consent", reasonCode: "consent_permitted" }, ctx()).ok).toBe(false);
    expect(validateDecision({ decision: "proceed_with_consent", reasonCode: "consent_permitted", consentPartyIds: ["c1", "c2"] }, ctx()).ok).toBe(true);
  });

  it("hard-blocks consent when the applied rule table says not waivable (acceptance 4)", () => {
    const notWaivable: RuleAssessment = {
      applied: true,
      definite: false,
      consent: "not_waivable",
      rows: [{ id: "x", situation: "adverse_current_client", ruleRef: "Rule X", waivability: "not_waivable", definite: false, summary: "" }],
    };
    const input: DecisionInput = { decision: "proceed_with_consent", reasonCode: "consent_permitted", consentPartyIds: ["c1"] };
    const blocked = validateDecision(input, ctx({ assessment: notWaivable }));
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.errors.join(" ")).toContain("Rule X");

    // Asking to override while the override policy is unapproved stays blocked.
    expect(validateDecision({ ...input, overrideRuleTable: true, reasonText: "These facts differ in a documented way." }, ctx({ assessment: notWaivable })).ok).toBe(false);

    // Once the founder and attorney approve overrides, it is allowed with an explanation and flagged.
    expect(validateDecision({ ...input, overrideRuleTable: true, reasonText: "These facts differ in a documented way." }, ctx({ assessment: notWaivable, overrideGateApproved: true }))).toEqual({
      ok: true,
      overrideFlag: true,
    });
  });

  it("lets a definite result only be declined, or cleared with a written explanation (flagged)", () => {
    const definite = ctx({ check: { outcome: "definite", status: "open", hits: [hit()] } });
    expect(validateDecision({ decision: "proceed_with_screen", reasonCode: "other", reasonText: "x", screenedUserIds: ["u"] }, definite).ok).toBe(false);
    expect(validateDecision(clearIt, definite).ok).toBe(false);
    expect(validateDecision({ ...clearIt, reasonText: "Different person: dates of birth differ." }, definite)).toEqual({ ok: true, overrideFlag: true });
    expect(validateDecision({ decision: "declined", reasonCode: "conflict_not_waivable" }, definite).ok).toBe(true);
  });

  it("stops a lawyer deciding a hit on their own interests when someone else can", () => {
    const own = ctx({ check: { outcome: "possible", status: "open", hits: [hit({ sourceType: "interest", ownerUserId: "atty" })] } });
    expect(validateDecision(clearIt, own).ok).toBe(false);
    expect(validateDecision(clearIt, { ...own, otherDecidersAvailable: false }).ok).toBe(true);
  });

  it("needs screened users for a screen and forbids them on cleared/declined", () => {
    expect(validateDecision({ decision: "proceed_with_screen", reasonCode: "lateral_hire" }, ctx()).ok).toBe(false);
    expect(validateDecision({ decision: "proceed_with_screen", reasonCode: "lateral_hire", screenedUserIds: ["u"] }, ctx()).ok).toBe(true);
    expect(validateDecision({ ...clearIt, screenedUserIds: ["u"] }, ctx()).ok).toBe(false);
  });

  it("has nothing to decide on a clear check", () => {
    expect(validateDecision(clearIt, ctx({ check: { outcome: "clear", status: "not_required", hits: [] } })).ok).toBe(false);
  });
});

describe("computeCheckGate / combineGates (c59 §4.5)", () => {
  const signed = { status: "signed", countersignRequired: true, countersignedAt: new Date() };

  it("keeps the gate closed while a review is pending", () => {
    expect(computeCheckGate({ outcome: "possible", status: "open", decision: null, waivers: [], screens: [] })).toEqual({ state: "closed", closedReason: "pending_review" });
  });

  it("opens for clear results and clearances; stays closed for declines", () => {
    expect(computeCheckGate({ outcome: "clear", status: "not_required", decision: null, waivers: [], screens: [] }).state).toBe("open");
    expect(computeCheckGate({ outcome: "possible", status: "decided", decision: { decision: "cleared" }, waivers: [], screens: [] }).state).toBe("open");
    expect(computeCheckGate({ outcome: "possible", status: "decided", decision: { decision: "declined" }, waivers: [], screens: [] })).toEqual({ state: "closed", closedReason: "declined" });
  });

  it("stays closed until EVERY affected client has signed (acceptance 3)", () => {
    const base = { outcome: "possible" as const, status: "decided", decision: { decision: "proceed_with_consent" as const }, screens: [] };
    expect(computeCheckGate({ ...base, waivers: [signed, { status: "sent", countersignRequired: true, countersignedAt: null }] }).closedReason).toBe("awaiting_consent");
    expect(computeCheckGate({ ...base, waivers: [signed, signed] }).state).toBe("open");
    expect(computeCheckGate({ ...base, waivers: [] }).closedReason).toBe("awaiting_consent");
  });

  it("waits for the firm countersignature when required", () => {
    const base = { outcome: "possible" as const, status: "decided", decision: { decision: "proceed_with_consent" as const }, screens: [] };
    expect(computeCheckGate({ ...base, waivers: [{ status: "signed", countersignRequired: true, countersignedAt: null }] }).state).toBe("closed");
    expect(computeCheckGate({ ...base, waivers: [{ status: "signed", countersignRequired: false, countersignedAt: null }] }).state).toBe("open");
  });

  it("opens a screen decision only once every screen is active", () => {
    const base = { outcome: "possible" as const, status: "decided", decision: { decision: "proceed_with_screen" as const }, waivers: [] };
    expect(computeCheckGate({ ...base, screens: [{ status: "requested" }] }).closedReason).toBe("awaiting_screen");
    expect(computeCheckGate({ ...base, screens: [{ status: "active" }, { status: "lifted" }] }).state).toBe("open");
    expect(computeCheckGate({ ...base, screens: [] }).state).toBe("closed");
  });

  it("combines: closed with no check, open only when every check is open", () => {
    expect(combineGates([])).toEqual({ state: "closed", closedReason: "no_check" });
    expect(combineGates([{ state: "open", closedReason: null }]).state).toBe("open");
    expect(
      combineGates([
        { state: "open", closedReason: null },
        { state: "closed", closedReason: "awaiting_screen" },
        { state: "closed", closedReason: "declined" },
      ])
    ).toEqual({ state: "closed", closedReason: "declined" });
  });
});

describe("waiverTimerAction", () => {
  const sentAt = new Date("2026-10-05T15:00:00Z");
  const plusDay = (d: Date) => new Date(d.getTime() + 86_400_000);
  const w = { status: "sent", sentAt, lastReminderAt: null, outerLimitAt: new Date("2026-10-20T15:00:00Z") };

  it("does nothing before the next reminder is due", () => {
    expect(waiverTimerAction(w, new Date("2026-10-05T20:00:00Z"), plusDay)).toBe("none");
  });
  it("reminds after the interval, counted from the last reminder", () => {
    expect(waiverTimerAction(w, new Date("2026-10-06T16:00:00Z"), plusDay)).toBe("remind");
    expect(waiverTimerAction({ ...w, lastReminderAt: new Date("2026-10-06T16:00:00Z") }, new Date("2026-10-06T18:00:00Z"), plusDay)).toBe("none");
  });
  it("returns to the attorney at the outer limit", () => {
    expect(waiverTimerAction(w, new Date("2026-10-21T00:00:00Z"), plusDay)).toBe("outer_limit");
  });
  it("ignores waivers that are not out for signature", () => {
    expect(waiverTimerAction({ ...w, status: "signed" }, new Date("2026-10-21T00:00:00Z"), plusDay)).toBe("none");
  });
});

describe("person-level checks (c61 lateral hires, c97 lawyer interests)", () => {
  it("a declined lateral/interest check excludes the person but does not close the client's matter", async () => {
    const { computeCheckGate } = await import("./decisions");
    const declined = { outcome: "possible" as const, status: "decided", decision: { decision: "declined" as const }, waivers: [], screens: [] };
    expect(computeCheckGate({ ...declined, trigger: "interest" }).state).toBe("open");
    expect(computeCheckGate({ ...declined, trigger: "lateral_hire" }).state).toBe("open");
    expect(computeCheckGate({ ...declined, trigger: "intake" }).closedReason).toBe("declined");
  });

  it("screens cover the check's matters, else the open matters its hits involve", async () => {
    const { matterIdsForPersonScreens } = await import("./decisions");
    const { matterInv, inquiryInv } = await import("./testFixtures");
    expect(matterIdsForPersonScreens({ matterId: "m1", affectedMatterIds: ["m2"], hits: [] })).toEqual(["m1", "m2"]);
    const hits = [hit({ involvements: [matterInv("a", "client", "current"), matterInv("b", "client", "former"), inquiryInv("s"), matterInv("c", "opposing_party", "prospective")] })];
    expect(matterIdsForPersonScreens({ matterId: null, affectedMatterIds: [], hits })).toEqual(["a", "c"]);
  });
});
