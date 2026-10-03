// DRAFT Family Law defaults for c94 (task lists) and c95 (stages).
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ DRAFT — NOT LEGAL ADVICE — FIRM-EDITABLE.                             │
// │ These are workflow starting points, not legal rules: no deadline      │
// │ below is computed from law. Court deadlines (e.g. an answer date)     │
// │ come only from a lawyer's entry or a lawyer-confirmed calculator      │
// │ result (c92). Seeded as status 'draft' with systemDraft = true; they  │
// │ never run until a lawyer or firm admin reviews and activates them.    │
// └──────────────────────────────────────────────────────────────────────┘
//
// The practice-area pack itself (c103) is built by the all-engines engine;
// this file is only calendar-core's own default content and is not shared.

import type { StageDef, TaskTemplateItem } from "@/db/tables/calendar-core";

export const DRAFT_NOTICE = "DRAFT default — review and edit before activating. Not legal advice; no court deadline is calculated here.";

const stage = (
  key: string,
  label: string,
  order: number,
  onEnter: Partial<StageDef["onEnter"]> = {},
  expectedBusinessHours: number | null = null,
  closing = false
): StageDef => ({
  key,
  label,
  order,
  closing,
  expectedBusinessHours,
  onEnter: { taskLists: onEnter.taskLists ?? [], clientUpdateTask: onEnter.clientUpdateTask ?? false, billingEvent: onEnter.billingEvent ?? null },
});

/** DRAFT family-law lifecycle (divorce / custody shaped). */
export const FAMILY_LAW_DRAFT_STAGES: StageDef[] = [
  stage("opened", "Matter opened", 10, { taskLists: ["family.matter_opened"] }, 40),
  stage("petition_prep", "Preparing petition", 20, {}, 80),
  stage("filed", "Petition filed", 30, { taskLists: ["family.petition_filed"], clientUpdateTask: true, billingEvent: "family.phase.filed" }, 80),
  stage("served", "Respondent served / waiver", 40, { taskLists: ["family.respondent_served"], clientUpdateTask: true }, 120),
  stage("temporary_orders", "Temporary orders", 50, { clientUpdateTask: true }, 160),
  stage("discovery", "Discovery and disclosures", 60, { taskLists: ["family.discovery"] }, 320),
  stage("mediation", "Mediation", 70, { taskLists: ["family.mediation"], clientUpdateTask: true, billingEvent: "family.phase.mediation" }, 160),
  stage("trial_prep", "Trial preparation", 80, { clientUpdateTask: true }, 240),
  stage("final_orders", "Final decree / orders", 90, { taskLists: ["family.final_orders"], clientUpdateTask: true, billingEvent: "family.phase.final_orders" }, 80),
  stage("closed", "Closed", 100, {}, null, true),
];

const item = (
  key: string,
  title: string,
  owner: TaskTemplateItem["owner"],
  dueHours: number,
  dependsOn: string[] = [],
  description: string | null = null
): TaskTemplateItem => ({ key, title, description, owner, dueHours, clock: "business", dependsOn });

export interface DraftTaskList {
  key: string;
  name: string;
  triggerStageKey: string | null;
  items: TaskTemplateItem[];
}

/** DRAFT family-law task lists, keyed to the stages above. */
export const FAMILY_LAW_DRAFT_TASK_LISTS: DraftTaskList[] = [
  {
    key: "family.matter_opened",
    name: "New family matter",
    triggerStageKey: "opened",
    items: [
      item("intake_review", "Review intake answers and conflict result", "responsible_lawyer", 8),
      item("limitation_decision", "Decide whether any limitation date applies (record it, or record 'not applicable')", "responsible_lawyer", 16),
      item("client_questionnaire", "Complete the family information questionnaire", "client", 40),
      item("client_financials", "Upload recent pay stubs, tax returns and account statements", "client", 80),
      item("draft_petition", "Draft the petition", "responsible_lawyer", 40, ["client_questionnaire"]),
    ],
  },
  {
    key: "family.petition_filed",
    name: "Petition filed",
    triggerStageKey: "filed",
    items: [
      item("serve_respondent", "Arrange service on the respondent (or obtain a signed waiver)", "responsible_lawyer", 16),
      item(
        "calendar_answer_date",
        "Calendar the answer date once service is complete (lawyer enters or confirms the date)",
        "responsible_lawyer",
        8,
        ["serve_respondent"],
        "Use the deadline calculator or enter the date yourself; the date is a lawyer's decision."
      ),
      item("client_update_filed", "Send the client an update that the petition was filed", "responsible_lawyer", 8),
    ],
  },
  {
    key: "family.respondent_served",
    name: "Respondent served",
    triggerStageKey: "served",
    items: [
      item("file_return", "File the return of service (or the waiver)", "firm", 16),
      item("check_temporary_orders", "Decide whether temporary orders are needed", "responsible_lawyer", 24),
    ],
  },
  {
    key: "family.discovery",
    name: "Discovery and disclosures",
    triggerStageKey: "discovery",
    items: [
      item("initial_disclosures", "Prepare required disclosures", "responsible_lawyer", 80),
      item("client_documents", "Provide the documents on the discovery checklist", "client", 80),
      item("inventory", "Prepare the inventory and appraisement", "responsible_lawyer", 120, ["client_documents"]),
    ],
  },
  {
    key: "family.mediation",
    name: "Mediation",
    triggerStageKey: "mediation",
    items: [
      item("book_mediator", "Book the mediator and calendar the session", "firm", 16),
      item("mediation_statement", "Prepare the mediation statement", "responsible_lawyer", 40, ["book_mediator"]),
      item("client_prep", "Mediation preparation meeting with the client", "responsible_lawyer", 40, ["book_mediator"]),
    ],
  },
  {
    key: "family.final_orders",
    name: "Final orders",
    triggerStageKey: "final_orders",
    items: [
      item("submit_decree", "Submit the final decree / orders for signature", "responsible_lawyer", 24),
      item("send_decree", "Send the signed decree to the client", "responsible_lawyer", 16, ["submit_decree"]),
      item("post_decree_tasks", "List post-decree actions (transfers, name change, QDRO)", "responsible_lawyer", 40, ["submit_decree"]),
      item("start_closing", "Start closing the matter", "responsible_lawyer", 80, ["send_decree", "post_decree_tasks"]),
    ],
  },
];
