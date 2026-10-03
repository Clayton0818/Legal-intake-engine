// c102 — what a practice-area pack is. A pack is DATA: it describes what one
// practice area contributes to each of the five engines. Engines never
// import a pack. The All-engines engine publishes the firm's ACCEPTED pack
// versions into firm settings (see ./published.ts), and each engine reads
// them from there — the same way they read every other firm setting.
//
// Rules for pack authors (enforced by validatePack()):
//  - Staff-facing labels are plain text. Anything a CLIENT reads (intake
//    questions, document requests, safety notices) carries a `copyKey` for a
//    defineGate()/legalCopy() gate and a `draft`: it renders as a visible
//    "[PENDING ATTORNEY REVIEW …]" placeholder until an attorney approves it.
//  - Legal-rule content (waiting periods, deadlines, limitation periods,
//    support guidelines, statutory forms) is NEVER a value in a pack. It is a
//    RuleReference: a gate key the engine must requireApproval() before
//    applying the rule, plus where the gated value will live. Rule references
//    are lawyer tools only, never shown to a client as advice.
//  - Workflow numbers (e.g. "draft the petition within 5 business days") are
//    firm-editable suggestions, not legal deadlines; they never use the real
//    clock and never become a deadline without a lawyer.

import type { PracticeAreaId } from "@/core/practiceAreas";

/** Party roles in the shared `party_role` enum (schema.ts). */
export type SharedPartyRole =
  | "caller"
  | "opposing_party"
  | "co_party"
  | "client"
  | "opposing_counsel"
  | "child"
  | "related_party"
  | "witness"
  | "expert"
  | "guardian_ad_litem"
  | "court"
  | "other";

/** Index roles used by the conflict-check party index (c56). */
export type ConflictIndexRole =
  | "prospective_client"
  | "client"
  | "former_client"
  | "opposing_party"
  | "opposing_counsel"
  | "related_party"
  | "co_party"
  | "insurer"
  | "co_defendant"
  | "other";

/** Client-facing wording: rendered only through legalCopy(copyKey). */
export interface ClientCopy {
  /** Gate key, `copy.all-engines.<area>.<…>`. */
  copyKey: string;
  /** Proposed wording for the attorney reviewer (NOT approved text). */
  draft: string;
}

/** A pointer to a gated legal rule. Carries no rule value. */
export interface RuleReference {
  id: string;
  /** Staff-facing name of the tool, e.g. "Divorce waiting-period calculator". */
  label: string;
  kind: "waiting_period" | "court_deadline" | "limitation_period" | "guideline_calculator" | "statutory_form" | "eligibility_rule";
  /** Gate the consuming engine must requireApproval() before applying it: `rules.all-engines.<area>.*` or a shared RULE_GATES key. */
  gateKey: string;
  /** Engine that will own the gated rule values (they never live in the pack). */
  ownerEngine: "intake" | "conflict-check" | "document" | "calendar-alerts" | "calendar-core" | "billing-trust" | "all-engines";
  /** Matter types the tool applies to. */
  matterTypes: string[];
  /** Always 'lawyer_tool': output is proposed to a lawyer, never told to a client. */
  audience: "lawyer_tool";
  /** What the lawyer is told the tool is for (staff-facing). */
  note: string;
}

export interface MatterTypeDef {
  id: string;
  label: string;
  description: string;
  /** Intake classifier labels (src/llm) that map to this type. */
  classifierLabels: string[];
  /** Stage track used by this type (MatterStageTrack.id). */
  stageTrackId: string;
  /** Required-document checklist ids. */
  checklistIds: string[];
  /** Task list ids created when the matter opens. */
  openingTaskListIds: string[];
}

export type QuestionAnswerType = "yes_no" | "yes_no_unsure" | "short_text" | "long_text" | "number" | "date" | "choice" | "multi_choice";

export interface IntakeQuestion {
  id: string;
  /** Lower runs first. Safety and children questions come first (c103). */
  order: number;
  /** 'safety' questions route to the emergency flow (c66) on a concerning answer. */
  group: "safety" | "parties" | "children" | "existing_orders" | "case" | "finances" | "logistics";
  /** Client-facing wording (gated). */
  prompt: ClientCopy;
  answerType: QuestionAnswerType;
  /** Choice values (staff-facing ids; client labels are part of the gated prompt). */
  choices?: string[];
  /** Matter types that ask it ('*' = all). */
  matterTypes: string[];
  required: boolean;
  /** Answers that are safety signals: route to c66, mark the contact DV-sensitive. */
  safetySignalAnswers?: string[];
  /** Answers that are urgent-legal signals (e.g. a hearing soon): route to c66 urgent track. */
  urgentSignalAnswers?: string[];
  /** Ask only when another answer matches. */
  askWhen?: { questionId: string; answers: string[] };
  /** Staff-only note on why it is asked. */
  staffNote?: string;
}

export interface SafetyHandling {
  /** Safety questions are asked before any case detail. */
  askSafetyFirst: boolean;
  /** Where a safety signal goes (task/flag kinds the intake engine already uses). */
  routeTo: { emergencyCategory: string; flagType: string };
  /** On any safety signal: set parties.dv_sensitive on the client contact. */
  markClientDvSensitive: boolean;
  /** Safe-contact defaults applied to every client contact in this area (SafeContactPreferences shape). */
  safeContactDefaults: {
    requireSafeEmail: boolean;
    emailAllowed: boolean;
    smsAllowed: boolean;
    voicemailAllowed: boolean;
    sensitiveByEmail: boolean;
  };
  /** Never send anything to an address/number the opposing party may share or see. */
  neverUseSharedDevices: boolean;
  /** Shown to the client at the start of intake (gated). */
  notice: ClientCopy;
  /** Shown when a safety signal is detected (gated). */
  signalResponse: ClientCopy;
}

export interface PackPartyRole {
  id: string;
  label: string;
  partyRole: SharedPartyRole;
  indexRole: ConflictIndexRole;
  /** Free-text relationship stored on matter_parties.relationship. */
  relationship: string;
  /** Usually adverse to the client (drives c3 rule severity). */
  adverseByDefault: boolean;
  /** Intake asks for this person by name before case details (c58). */
  askAtIntake: boolean;
  /** Added to the conflict party index by default (children: firm decision, c56 open question 3). */
  indexByDefault: boolean;
  /** An unnamed person in this role keeps the check from coming back clear (c56 rule 7). */
  blocksClearIfUnnamed: boolean;
  matterTypes: string[];
}

export interface FolderNode {
  id: string;
  name: string;
  /** Default privilege tag for documents filed here (c88 vocabulary). */
  defaultPrivilege?: "none" | "privileged" | "work_product" | "confidential" | "sealed";
  /** Visible in the client portal by default (documents still need a lawyer to share). */
  clientVisibleFolder?: boolean;
  children?: FolderNode[];
}

export interface ChecklistItem {
  id: string;
  label: string;
  providedBy: "client" | "firm" | "opposing_party" | "court" | "third_party";
  required: boolean;
  /** Folder (FolderNode.id) it is filed into. */
  folderId: string;
  /** Client-facing request wording (gated), for items the client provides. */
  clientRequest?: ClientCopy;
  /** The item is a firm template a lawyer must review before use (c85). */
  templateId?: string;
  matterTypes?: string[];
}

export interface RequiredDocumentChecklist {
  id: string;
  label: string;
  items: ChecklistItem[];
}

export interface DocumentTemplateRef {
  id: string;
  label: string;
  /** Statutory/court forms and petitions are references to gated, attorney-reviewed templates; the pack holds no form text. */
  kind: "petition" | "order" | "agreement" | "disclosure" | "letter" | "worksheet";
  /** Approval gate for using the template (attorney review of the content). */
  gateKey: string;
  matterTypes: string[];
}

export interface TaskTemplate {
  id: string;
  title: string;
  assigneeRole: "lawyer" | "paralegal" | "intake_staff" | "bookkeeper" | "admin";
  /** Firm workflow target in BUSINESS days from the trigger. Never a legal deadline. */
  dueBusinessDays?: number;
  /** Task kind written to the shared tasks table (namespaced). */
  kind: string;
  /** Points at a gated rule the lawyer applies; the task itself never computes the date. */
  ruleRef?: string;
  visibility: "internal" | "client";
}

export interface TaskListTemplate {
  id: string;
  label: string;
  trigger: { on: "matter_opened" } | { on: "stage_entered"; stageId: string };
  matterTypes: string[];
  tasks: TaskTemplate[];
}

export interface MatterStageDef {
  id: string;
  label: string;
  /** The shared matter_stage value this maps onto, when one fits. */
  systemStage?: "prospective" | "retained" | "closed";
  /** Client-facing name of the stage in the portal (gated). */
  clientLabel?: ClientCopy;
}

export interface MatterStageTrack {
  id: string;
  label: string;
  stages: MatterStageDef[];
}

export type FeeType = "retainer_hourly" | "hourly" | "flat_fee" | "contingency" | "hybrid";

export interface BillingDefaults {
  defaultFeeType: FeeType;
  offeredFeeTypes: FeeType[];
  /** Fee types the product does not offer in this area until an attorney reviews the question. */
  withheldFeeTypes: { feeType: FeeType; gateKey: string; why: string }[];
  /** Retainer floor comes from firm_settings.retainerFloorCents (founder setting), not the pack. */
  retainerFloorFromFirmSettings: true;
  /** Gate for fee-agreement terms (shared). */
  feeTermsGateKey: string;
  /** Gate for anything that moves trust money (shared). */
  trustGateKey: string;
  /** Matter types usually billed differently (staff hint only). */
  perMatterType?: Record<string, FeeType>;
}

export interface PracticeAreaPack {
  id: PracticeAreaId;
  /** Semver. Bump on ANY content change; firms review and accept updates. */
  version: string;
  label: string;
  jurisdiction: "TX";
  cardId: string;
  /** Staff-facing summary of what changed in this version. */
  changelog: string[];
  /** Gate recording the attorney's review of the pack's legal content as a whole. */
  contentReviewGateKey: string;
  intake: {
    matterTypes: MatterTypeDef[];
    questions: IntakeQuestion[];
    safety: SafetyHandling;
  };
  conflicts: {
    partyRoles: PackPartyRole[];
  };
  documents: {
    folderTemplate: FolderNode[];
    checklists: RequiredDocumentChecklist[];
    templates: DocumentTemplateRef[];
  };
  tasks: {
    lists: TaskListTemplate[];
  };
  stages: {
    tracks: MatterStageTrack[];
  };
  deadlines: {
    rules: RuleReference[];
  };
  billing: BillingDefaults;
}
