import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryApprovalSource, hasGate, isPlaceholder, legalCopy, refreshApprovals, resetApprovalStateForTests, setApprovalSource, requireApproval, PendingApprovalError } from "@/compliance/approvals";
import { PRACTICE_AREA_IDS } from "@/core/practiceAreas";
import { ALL_ENGINES_GATE_KEYS, FAMILY_RULE_GATES, PACK_COPY_GATES } from "../gates";
import { packCopyItems, uniqueCopyItems } from "./copy";
import { FAMILY_LAW_PACK, FAMILY_RULE_KEYS } from "./family";
import { applicableQuestions, evaluateSignals, missingRequired, renderQuestion } from "./questions";
import { PACK_REGISTRY, availablePracticeAreaIds, getPack, listPacks, packContentHash } from "./registry";
import type { PracticeAreaPack } from "./types";
import { stableStringify, validatePack } from "./validate";

const clone = (): PracticeAreaPack => JSON.parse(JSON.stringify(FAMILY_LAW_PACK)) as PracticeAreaPack;

describe("registry", () => {
  it("every registered pack is valid against the real gate registry", () => {
    for (const pack of listPacks()) expect(validatePack(pack, hasGate)).toEqual([]);
  });

  it("registers packs only under known practice areas, with matching ids", () => {
    for (const [id, pack] of Object.entries(PACK_REGISTRY)) {
      expect(PRACTICE_AREA_IDS).toContain(id);
      expect(pack!.id).toBe(id);
    }
    expect(availablePracticeAreaIds()).toEqual(["family"]);
    expect(getPack("family")).toBe(FAMILY_LAW_PACK);
    expect(getPack("immigration")).toBeNull();
    expect(getPack("nope")).toBeNull();
  });

  it("hashes content deterministically and changes with content", () => {
    expect(packContentHash(FAMILY_LAW_PACK)).toBe(packContentHash(clone()));
    const changed = clone();
    changed.intake.questions[0]!.order = 9;
    expect(packContentHash(changed)).not.toBe(packContentHash(FAMILY_LAW_PACK));
    expect(stableStringify({ b: 1, a: [2, { d: undefined, c: 3 }] })).toBe('{"a":[2,{"c":3}],"b":1}');
  });
});

describe("validatePack catches unsafe or broken packs", () => {
  const expectError = (mutate: (p: PracticeAreaPack) => void, pattern: RegExp) => {
    const p = clone();
    mutate(p);
    const errors = validatePack(p, hasGate);
    expect(errors.join("\n")).toMatch(pattern);
  };

  it("structure", () => {
    expectError((p) => (p.version = "1"), /semver/);
    expectError((p) => (p.changelog = []), /changelog/);
    expectError((p) => p.intake.matterTypes.push({ ...p.intake.matterTypes[0]! }), /duplicate matter type/);
    expectError((p) => (p.intake.matterTypes[0]!.stageTrackId = "x"), /unknown stage track/);
    expectError((p) => (p.intake.matterTypes[0]!.checklistIds = ["x"]), /unknown checklist/);
    expectError((p) => (p.intake.matterTypes[0]!.openingTaskListIds = ["x"]), /unknown task list/);
    expectError((p) => (p.intake.matterTypes[0]!.classifierLabels = ["immigration_visa"]), /does not belong/);
    expectError((p) => (p.intake.questions[0]!.matterTypes = ["x"]), /unknown matter type/);
    expectError((p) => (p.intake.questions.find((q) => q.answerType === "choice")!.choices = []), /needs choices/);
    expectError((p) => (p.intake.questions.find((q) => q.askWhen)!.askWhen!.questionId = "x"), /unknown question/);
    expectError((p) => (p.documents.checklists[0]!.items[0]!.folderId = "x"), /unknown folder/);
    expectError((p) => (p.documents.checklists[0]!.items.find((i) => i.templateId)!.templateId = "x"), /unknown template/);
    expectError((p) => (p.tasks.lists.find((l) => l.trigger.on === "stage_entered")!.trigger = { on: "stage_entered", stageId: "x" }), /unknown stage/);
    expectError((p) => p.stages.tracks[0]!.stages.pop(), /closed stage/);
    expectError((p) => (p.billing.defaultFeeType = "contingency"), /default fee type/);
  });

  it("safety first and DV-safe defaults", () => {
    expectError((p) => (p.intake.questions.find((q) => q.id === "help_wanted")!.order = 1), /before the safety questions/);
    expectError((p) => (p.intake.questions.find((q) => q.id === "other_party_name")!.order = 99), /before case details/);
    expectError((p) => (p.intake.safety.markClientDvSensitive = false), /DV-sensitive/);
    expectError((p) => (p.intake.safety.safeContactDefaults.smsAllowed = true), /SMS and voicemail/);
    expectError((p) => (p.intake.safety.neverUseSharedDevices = false), /neverUseSharedDevices/);
    expectError((p) => (p.intake.questions.find((q) => q.id === "safe_now")!.safetySignalAnswers = []), /no safety-signal/);
  });

  it("legal content stays gated", () => {
    expectError((p) => (p.intake.questions[0]!.prompt.copyKey = "copy.intake.whatever"), /must start with 'copy.all-engines.family./);
    expectError((p) => (p.intake.questions[0]!.prompt.draft = " "), /empty draft/);
    expectError((p) => (p.stages.tracks[1]!.stages[0]!.clientLabel!.draft = "Different"), /reused with different wording/);
    expectError((p) => (p.deadlines.rules[0]!.gateKey = "rules.all-engines.family.not_defined"), /must be/);
    expectError((p) => (p.deadlines.rules[0]!.gateKey = "copy.all-engines.family.q.safe_now"), /must be/);
    expectError((p) => ((p.deadlines.rules[0] as unknown as Record<string, unknown>).waitingDays = 60), /carries a value field/);
    expectError((p) => ((p.deadlines.rules[0] as unknown as Record<string, unknown>).audience = "client"), /lawyer tool/);
    expectError((p) => (p.tasks.lists[0]!.tasks.find((t) => t.ruleRef)!.assigneeRole = "paralegal"), /assigned to a lawyer/);
    expectError((p) => (p.tasks.lists[0]!.tasks[0]!.ruleRef = "nope"), /unknown rule/);
    expectError((p) => (p.tasks.lists[0]!.tasks[0]!.visibility = "client"), /client-visible tasks/);
    expectError((p) => (p.tasks.lists[0]!.tasks[0]!.kind = "intake.x"), /must start with 'all-engines.family./);
    expectError((p) => (p.documents.checklists[0]!.items[0]!.clientRequest = undefined), /needs gated request wording/);
    expectError((p) => (p.documents.templates[0]!.gateKey = "rules.nope"), /not a known rules gate/);
    expectError((p) => (p.billing.trustGateKey = "rules.fee_agreement_terms"), /rules.trust_accounting/);
    expectError((p) => p.billing.offeredFeeTypes.push("contingency"), /both offered and withheld/);
    expectError((p) => p.conflicts.partyRoles.forEach((r) => (r.blocksClearIfUnnamed = false)), /block a clear result/);
  });
});

describe("Family Law pack content (c103)", () => {
  const pack = FAMILY_LAW_PACK;

  it("covers the five pilot matter areas", () => {
    expect(pack.intake.matterTypes.map((t) => t.id)).toEqual(["divorce", "custody_visitation", "child_support", "protective_order", "modification", "enforcement"]);
  });

  it("asks safety first, then parties, then children and existing orders before case details", () => {
    const order = applicableQuestions(pack, "divorce", { has_children: "yes" }).map((q) => q.group);
    const firstIndex = (g: string) => order.indexOf(g as never);
    expect(firstIndex("safety")).toBe(0);
    expect(firstIndex("parties")).toBeLessThan(firstIndex("children"));
    expect(firstIndex("children")).toBeLessThan(firstIndex("case"));
    expect(firstIndex("existing_orders")).toBeLessThan(firstIndex("case"));
  });

  it("indexes both spouses/parents, new partners and grandparents; children are not indexed by default", () => {
    const roles = new Map(pack.conflicts.partyRoles.map((r) => [r.id, r]));
    for (const id of ["spouse", "other_parent", "new_partner", "grandparent"]) expect(roles.get(id)!.indexByDefault).toBe(true);
    expect(roles.get("child")!.indexByDefault).toBe(false);
    expect(roles.get("spouse")!.blocksClearIfUnnamed).toBe(true);
  });

  it("holds no rule values: every Texas rule is a gated lawyer tool", () => {
    for (const r of pack.deadlines.rules) {
      expect(r.audience).toBe("lawyer_tool");
      expect(r.gateKey).toMatch(/^rules\./);
      expect(hasGate(r.gateKey)).toBe(true);
    }
    // nothing in the pack text states a number of days/months/years
    expect(stableStringify(pack)).not.toMatch(/\b\d+\s*(days?|months?|years?)\b/i);
  });

  it("uses retainer + hourly by default and withholds contingency behind the fee-terms gate", () => {
    expect(pack.billing.defaultFeeType).toBe("retainer_hourly");
    expect(pack.billing.withheldFeeTypes.map((w) => w.feeType)).toEqual(["contingency"]);
  });

  it("follows the conditional questions", () => {
    const base = applicableQuestions(pack, null).map((q) => q.id);
    expect(base).not.toContain("safe_contact_method");
    expect(base).not.toContain("marriage_and_separation");
    expect(applicableQuestions(pack, null, { safe_to_contact: "not_safe" }).map((q) => q.id)).toContain("safe_contact_method");
    expect(applicableQuestions(pack, "enforcement").map((q) => q.id)).toContain("order_not_followed");
    expect(applicableQuestions(pack, "modification", { has_children: ["yes"] }).map((q) => q.id)).toContain("children_count_ages");
  });

  it("evaluates safety and urgent signals, failing towards alerting", () => {
    expect(evaluateSignals(pack, {})).toMatchObject({ safety: false, urgent: false, markDvSensitive: false, emergencyCategory: null });
    const unsure = evaluateSignals(pack, { safe_now: "unsure" });
    expect(unsure).toMatchObject({ safety: true, markDvSensitive: true, emergencyCategory: "safety_dv", safetyQuestionIds: ["safe_now"] });
    expect(evaluateSignals(pack, { safe_to_contact: "not_safe" }).markDvSensitive).toBe(true);
    expect(evaluateSignals(pack, { protective_order_exists: "yes" }).safety).toBe(true);
    expect(evaluateSignals(pack, { served_papers: "yes", upcoming_court_date: "no" })).toMatchObject({ urgent: true, safety: false, urgentQuestionIds: ["served_papers"] });
  });

  it("lists missing required answers", () => {
    const missing = missingRequired(pack, "divorce", { safe_now: "yes", has_children: "yes" });
    expect(missing).toContain("safe_to_contact");
    expect(missing).toContain("children_count_ages");
    expect(missing).not.toContain("safe_now");
    expect(missingRequired(pack, null, { safe_now: " " })).toContain("safe_now");
  });
});

describe("gates", () => {
  beforeEach(() => resetApprovalStateForTests());

  it("defines one attorney copy gate per distinct client sentence, and the family rule gates", () => {
    expect(PACK_COPY_GATES.length).toBe(uniqueCopyItems(FAMILY_LAW_PACK).length);
    expect(packCopyItems(FAMILY_LAW_PACK).length).toBeGreaterThan(PACK_COPY_GATES.length); // shared stage labels
    for (const g of [...PACK_COPY_GATES, ...Object.values(FAMILY_RULE_GATES)]) expect(g.reviewers).toEqual(["attorney"]);
    expect(new Set(ALL_ENGINES_GATE_KEYS).size).toBe(ALL_ENGINES_GATE_KEYS.length);
    for (const k of ALL_ENGINES_GATE_KEYS) expect(k).toMatch(/^(copy|rules)\.all-engines\.family\./);
  });

  it("client wording is a visible placeholder until an attorney approves the draft", async () => {
    const q = FAMILY_LAW_PACK.intake.questions[0]!;
    const pending = renderQuestion(q);
    expect(pending.approved).toBe(false);
    expect(isPlaceholder(pending.text)).toBe(true);
    const src = new InMemoryApprovalSource();
    src.approve({ gateKey: q.prompt.copyKey, reviewerKind: "attorney", approvedByName: "Test Attorney" });
    setApprovalSource(src);
    await refreshApprovals();
    expect(renderQuestion(q)).toEqual({ id: q.id, text: q.prompt.draft, approved: true });
    expect(legalCopy(FAMILY_LAW_PACK.intake.safety.notice.copyKey)).toMatch(/PENDING ATTORNEY REVIEW/);
  });

  it("Texas rule references block until approved", () => {
    expect(() => requireApproval(FAMILY_RULE_KEYS.divorceWaitingPeriod, { action: "calendar.propose_final_hearing" })).toThrow(PendingApprovalError);
  });
});
