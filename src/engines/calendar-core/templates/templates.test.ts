import { describe, expect, it } from "vitest";
import { readyToRelease, resolveOwner, runComplete, taskKindFor, topologicalOrder, validateTaskListTemplate, type TaskListTemplateInput } from "./taskLists";
import { checkTransition, closingBlockers, firstStage, validateStageDefinition } from "./stages";
import { DRAFT_NOTICE, FAMILY_LAW_DRAFT_STAGES, FAMILY_LAW_DRAFT_TASK_LISTS } from "./familyLawDrafts";
import { validateNewTask } from "@/core";

const base: TaskListTemplateInput = {
  key: "family.test",
  name: "Test",
  practiceArea: "family",
  triggerStageKey: "filed",
  items: [
    { key: "a", title: "A", owner: "responsible_lawyer", dueHours: 8, clock: "business", dependsOn: [] },
    { key: "b", title: "B", owner: "firm", dueHours: 8, clock: "business", dependsOn: ["a"] },
  ],
};

describe("task-list templates (c94)", () => {
  it("accepts a valid template", () => expect(validateTaskListTemplate(base)).toEqual([]));
  it("rejects loops, unknown dependencies and bad owners", () => {
    const loop = { ...base, items: [{ ...base.items[0]!, dependsOn: ["b"] }, base.items[1]!] };
    expect(validateTaskListTemplate(loop)).toContain("The dependencies form a loop.");
    expect(validateTaskListTemplate({ ...base, items: [{ ...base.items[0]!, dependsOn: ["zzz"] }] }).join()).toMatch(/unknown item/);
    expect(validateTaskListTemplate({ ...base, items: [{ ...base.items[0]!, owner: "boss" as never }] }).join()).toMatch(/owner/);
    expect(validateTaskListTemplate({ ...base, practiceArea: "tax" }).join()).toMatch(/practice area/);
  });
  it("deadline-critical items run on the real clock and never belong to the client", () => {
    const e = validateTaskListTemplate({ ...base, items: [{ ...base.items[0]!, deadlineCritical: true, owner: "client" }] }).join(" ");
    expect(e).toMatch(/real clock/);
    expect(e).toMatch(/client task cannot be deadline-critical/);
  });
  it("orders dependencies", () => expect(topologicalOrder(base.items)).toEqual(["a", "b"]));
  it("resolves owners, falling back to the firm pool", () => {
    expect(resolveOwner("responsible_lawyer", { responsibleUserId: "u", clientPartyId: null })).toEqual({ owner: { type: "user", userId: "u" }, visibility: "internal" });
    expect(resolveOwner("responsible_lawyer", { responsibleUserId: null, clientPartyId: null }).owner).toEqual({ type: "firm" });
    expect(resolveOwner("client", { responsibleUserId: null, clientPartyId: "p" })).toEqual({ owner: { type: "client", partyId: "p" }, visibility: "client" });
  });
  it("releases dependents only once prerequisites are finished", () => {
    const items = [
      { itemKey: "a", dependsOn: [], status: "released" as const, taskClosed: false },
      { itemKey: "b", dependsOn: ["a"], status: "waiting" as const },
    ];
    expect(readyToRelease(items)).toEqual([]);
    expect(readyToRelease([{ ...items[0]!, taskClosed: true }, items[1]!])).toEqual(["b"]);
    expect(runComplete([{ ...items[0]!, taskClosed: true }, { ...items[1]!, status: "skipped" }])).toBe(true);
  });
  it("task kinds fit the shared tasks.kind format", () => {
    const kind = taskKindFor("family.petition_filed", "serve_respondent");
    expect(validateNewTask({ tenantId: "t", kind, title: "x", owner: { type: "firm" }, due: { hours: 1, clock: "business" } })).toEqual([]);
  });
});

describe("matter stages (c95)", () => {
  it("the DRAFT family lifecycle is valid, ends with the closing stage", () => {
    expect(validateStageDefinition(FAMILY_LAW_DRAFT_STAGES)).toEqual([]);
    expect(firstStage(FAMILY_LAW_DRAFT_STAGES).key).toBe("opened");
  });
  it("needs exactly one closing stage, last", () => {
    const noClose = FAMILY_LAW_DRAFT_STAGES.map((s) => ({ ...s, closing: false }));
    expect(validateStageDefinition(noClose).join()).toMatch(/Exactly one/);
    const early = FAMILY_LAW_DRAFT_STAGES.map((s) => ({ ...s, closing: s.key === "filed" }));
    expect(validateStageDefinition(early).join()).toMatch(/last stage/);
  });
  it("transitions: forward freely, back with a reason, closing only via the closing flow", () => {
    expect(checkTransition(FAMILY_LAW_DRAFT_STAGES, "opened", "filed", "open", null)).toMatchObject({ ok: true, backwards: false });
    expect(checkTransition(FAMILY_LAW_DRAFT_STAGES, "filed", "opened", "open", null).ok).toBe(false);
    expect(checkTransition(FAMILY_LAW_DRAFT_STAGES, "filed", "opened", "open", "Petition withdrawn and refiled")).toMatchObject({ ok: true, backwards: true });
    expect(checkTransition(FAMILY_LAW_DRAFT_STAGES, "final_orders", "closed", "open", null).ok).toBe(false);
    expect(checkTransition(FAMILY_LAW_DRAFT_STAGES, "filed", "filed", "open", null).ok).toBe(false);
    expect(checkTransition(FAMILY_LAW_DRAFT_STAGES, "filed", "mediation", "closed", null).ok).toBe(false);
  });
  it("closing requires the checklist, trust at zero and nothing pending", () => {
    expect(closingBlockers({ checklistDone: true, trustZeroConfirmed: true, openDeadlineTasks: 0, futureEvents: 0, openLimitations: 0 })).toEqual([]);
    const b = closingBlockers({ checklistDone: false, trustZeroConfirmed: false, openDeadlineTasks: 1, futureEvents: 2, openLimitations: 1 });
    expect(b).toHaveLength(5);
  });
});

describe("DRAFT Family Law defaults", () => {
  it("every draft task list is valid and triggered by a real stage", () => {
    const stageKeys = new Set(FAMILY_LAW_DRAFT_STAGES.map((s) => s.key));
    for (const t of FAMILY_LAW_DRAFT_TASK_LISTS) {
      expect(validateTaskListTemplate({ ...t, practiceArea: "family" })).toEqual([]);
      if (t.triggerStageKey) expect(stageKeys.has(t.triggerStageKey)).toBe(true);
    }
  });
  it("every stage's task lists exist", () => {
    const keys = new Set(FAMILY_LAW_DRAFT_TASK_LISTS.map((t) => t.key));
    for (const s of FAMILY_LAW_DRAFT_STAGES) for (const k of s.onEnter.taskLists) expect(keys.has(k)).toBe(true);
  });
  it("includes the card's example and computes no court deadline", () => {
    const filed = FAMILY_LAW_DRAFT_TASK_LISTS.find((t) => t.key === "family.petition_filed")!;
    expect(filed.items.map((i) => i.key)).toEqual(["serve_respondent", "calendar_answer_date", "client_update_filed"]);
    expect(FAMILY_LAW_DRAFT_TASK_LISTS.flatMap((t) => t.items).some((i) => i.deadlineCritical)).toBe(false);
    expect(DRAFT_NOTICE).toMatch(/DRAFT/);
  });
});
