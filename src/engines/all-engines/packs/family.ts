// c103 — the Family Law pack (pilot practice area, Texas), as DATA against
// PracticeAreaPack (./types.ts).
//
// STATUS: DRAFT. Nothing here is legal advice or settled Texas law, and the
// whole pack is pending review by a licensed Texas family-law attorney
// (gate `rules.all-engines.family.pack_content`).
//  - Every client-facing sentence is a `draft` behind a copy gate and renders
//    as a visible "[PENDING ATTORNEY REVIEW …]" placeholder until approved.
//  - Texas-specific legal rules (waiting periods, residency, answer dates,
//    protective-order timing, child-support guidelines, possession schedules,
//    enforcement time limits, statutory forms) are RuleReferences only: a gate
//    key and a staff note, NO values. They are lawyer tools, never told to a
//    client as advice; the engine that owns the value calls requireApproval().
//  - Task "dueBusinessDays" are firm workflow suggestions in business days,
//    never legal deadlines.
//  - Safety first: safety questions are asked before any case detail, any
//    concerning answer routes to the emergency flow (c66) and marks the client
//    contact DV-sensitive, and client contact defaults are the most
//    conservative ones (safe address required, no SMS/voicemail by default).

import type { ClientCopy, PracticeAreaPack } from "./types";

const COPY = "copy.all-engines.family";
const RULE = "rules.all-engines.family";

/** Shared gate keys (src/compliance/gates.ts) used by this pack. Kept as strings so this file stays pure data. */
export const SHARED_RULE_KEYS = {
  courtDeadlines: "rules.court_deadlines",
  limitationPeriods: "rules.limitation_periods",
  feeAgreementTerms: "rules.fee_agreement_terms",
  trustAccounting: "rules.trust_accounting",
} as const;

/** Rule gates this pack defines (see ../gates.ts). */
export const FAMILY_RULE_KEYS = {
  packContent: `${RULE}.pack_content`,
  starterTemplates: `${RULE}.starter_templates`,
  divorceWaitingPeriod: `${RULE}.divorce_waiting_period`,
  residencyVenue: `${RULE}.residency_venue`,
  childSupportGuidelines: `${RULE}.child_support_guidelines`,
  possessionSchedule: `${RULE}.possession_schedule`,
  protectiveOrderTiming: `${RULE}.protective_order_timing`,
  modificationEligibility: `${RULE}.modification_eligibility`,
  statutoryForms: `${RULE}.statutory_forms`,
} as const;

function copy(id: string, draft: string): ClientCopy {
  return { copyKey: `${COPY}.${id}`, draft };
}

const LITIGATION_TYPES = ["divorce", "custody_visitation", "child_support", "modification", "enforcement"];
const CHILD_TYPES = ["divorce", "custody_visitation", "child_support", "modification", "enforcement"];
const ALL = ["*"];

export const FAMILY_LAW_PACK: PracticeAreaPack = {
  id: "family",
  version: "0.1.0",
  label: "Family Law",
  jurisdiction: "TX",
  cardId: "c103",
  changelog: ["0.1.0 — first draft for the pilot. Pending Texas family-law attorney review."],
  contentReviewGateKey: FAMILY_RULE_KEYS.packContent,

  // -------------------------------------------------------------------------
  // Intake (c12/c13, c66, c73)
  // -------------------------------------------------------------------------
  intake: {
    matterTypes: [
      {
        id: "divorce",
        label: "Divorce",
        description: "Ending a marriage, with or without children; property and debts; may include custody and support.",
        classifierLabels: ["family_divorce"],
        stageTrackId: "family_litigation",
        checklistIds: ["divorce_core", "children_core"],
        openingTaskListIds: ["family_opening"],
      },
      {
        id: "custody_visitation",
        label: "Custody and visitation",
        description: "Who the children live with, decision-making and parenting time, between parents or with relatives.",
        classifierLabels: ["family_custody"],
        stageTrackId: "family_litigation",
        checklistIds: ["children_core"],
        openingTaskListIds: ["family_opening"],
      },
      {
        id: "child_support",
        label: "Child support",
        description: "Setting child support and medical support where no order exists yet. Staff choose this type; the classifier has no separate label.",
        classifierLabels: [],
        stageTrackId: "family_litigation",
        checklistIds: ["children_core"],
        openingTaskListIds: ["family_opening"],
      },
      {
        id: "protective_order",
        label: "Protective order",
        description: "Protection from family violence. Always handled on the safety track (c66) and the real clock.",
        classifierLabels: [],
        stageTrackId: "family_protective_order",
        checklistIds: ["protective_order_core"],
        openingTaskListIds: ["family_opening", "protective_order_opening"],
      },
      {
        id: "modification",
        label: "Modification",
        description: "Changing an existing custody, visitation or support order.",
        classifierLabels: ["family_modification"],
        stageTrackId: "family_litigation",
        checklistIds: ["order_change_core", "children_core"],
        openingTaskListIds: ["family_opening"],
      },
      {
        id: "enforcement",
        label: "Enforcement",
        description: "An existing order is not being followed (support, visitation, property division).",
        classifierLabels: ["family_enforcement"],
        stageTrackId: "family_litigation",
        checklistIds: ["order_change_core"],
        openingTaskListIds: ["family_opening"],
      },
    ],

    questions: [
      // --- Safety first (c66) ---
      {
        id: "safe_now",
        order: 10,
        group: "safety",
        prompt: copy("q.safe_now", "Before we start: are you safe right now? If you are in danger, please call 911."),
        answerType: "yes_no_unsure",
        matterTypes: ALL,
        required: true,
        safetySignalAnswers: ["no", "unsure"],
        staffNote: "Asked before anything else. 'No' or 'unsure' routes to the emergency flow immediately.",
      },
      {
        id: "safe_to_contact",
        order: 11,
        group: "safety",
        prompt: copy("q.safe_to_contact", "Is it safe for us to contact you at the email address and phone number you gave us? Could anyone else read your messages or hear your voicemail?"),
        answerType: "choice",
        choices: ["safe", "not_safe", "unsure"],
        matterTypes: ALL,
        required: true,
        safetySignalAnswers: ["not_safe", "unsure"],
        staffNote: "Any answer other than 'safe' marks the contact DV-sensitive and requires a safe contact method.",
      },
      {
        id: "safe_contact_method",
        order: 12,
        group: "safety",
        prompt: copy("q.safe_contact_method", "Please tell us a safe way to reach you, and any times we should not contact you."),
        answerType: "short_text",
        matterTypes: ALL,
        required: true,
        askWhen: { questionId: "safe_to_contact", answers: ["not_safe", "unsure"] },
        staffNote: "Stored only in parties.safe_contact (never in free-text notes).",
      },
      {
        id: "harm_or_threats",
        order: 13,
        group: "safety",
        prompt: copy("q.harm_or_threats", "Has anyone in this situation hurt you or your children, or threatened to?"),
        answerType: "yes_no_unsure",
        matterTypes: ALL,
        required: true,
        safetySignalAnswers: ["yes", "unsure"],
      },
      {
        id: "children_safety",
        order: 14,
        group: "safety",
        prompt: copy("q.children_safety", "Are you worried about any child's safety right now?"),
        answerType: "yes_no_unsure",
        matterTypes: ALL,
        required: true,
        safetySignalAnswers: ["yes", "unsure"],
      },
      // --- Parties, before case details (c58, c56) ---
      {
        id: "other_party_name",
        order: 20,
        group: "parties",
        prompt: copy("q.other_party_name", "What is the full name of your spouse or the other parent? If you are not sure, tell us what you know."),
        answerType: "short_text",
        matterTypes: ALL,
        required: true,
        staffNote: "Needed for the conflict check before any case details. An unnamed other party keeps the check from coming back clear.",
      },
      {
        id: "other_party_other_names",
        order: 21,
        group: "parties",
        prompt: copy("q.other_party_other_names", "Has that person used any other names, such as a maiden or former married name?"),
        answerType: "short_text",
        matterTypes: ALL,
        required: false,
      },
      {
        id: "new_partner",
        order: 22,
        group: "parties",
        prompt: copy("q.new_partner", "Does your spouse or the other parent have a new partner or spouse? If so, what is their name?"),
        answerType: "short_text",
        matterTypes: LITIGATION_TYPES,
        required: false,
      },
      {
        id: "relatives_involved",
        order: 23,
        group: "parties",
        prompt: copy("q.relatives_involved", "Is a grandparent or other relative asking to have the children live with them or to visit them? If so, what are their names?"),
        answerType: "short_text",
        matterTypes: ["custody_visitation", "modification", "divorce"],
        required: false,
      },
      {
        id: "other_side_lawyer",
        order: 24,
        group: "parties",
        prompt: copy("q.other_side_lawyer", "Does the other person have a lawyer? If so, who?"),
        answerType: "short_text",
        matterTypes: ALL,
        required: false,
      },
      // --- Children ---
      {
        id: "has_children",
        order: 30,
        group: "children",
        prompt: copy("q.has_children", "Do you and the other person have children together who are under 18?"),
        answerType: "yes_no",
        matterTypes: CHILD_TYPES,
        required: true,
        staffNote: "Children's names are NOT added to the conflict index by default (c56 open question 3).",
      },
      {
        id: "children_count_ages",
        order: 31,
        group: "children",
        prompt: copy("q.children_count_ages", "How many children are involved, and how old are they?"),
        answerType: "short_text",
        matterTypes: CHILD_TYPES,
        required: true,
        askWhen: { questionId: "has_children", answers: ["yes"] },
      },
      {
        id: "children_live_with",
        order: 32,
        group: "children",
        prompt: copy("q.children_live_with", "Who do the children live with now?"),
        answerType: "short_text",
        matterTypes: CHILD_TYPES,
        required: true,
        askWhen: { questionId: "has_children", answers: ["yes"] },
      },
      // --- Existing orders and court dates (asked early, c103) ---
      {
        id: "existing_orders",
        order: 40,
        group: "existing_orders",
        prompt: copy("q.existing_orders", "Is there already a court order about your marriage, your children, child support or protection?"),
        answerType: "yes_no_unsure",
        matterTypes: ALL,
        required: true,
      },
      {
        id: "existing_order_details",
        order: 41,
        group: "existing_orders",
        prompt: copy("q.existing_order_details", "Which court and county made the order, and what is the case number if you know it?"),
        answerType: "short_text",
        matterTypes: ALL,
        required: false,
        askWhen: { questionId: "existing_orders", answers: ["yes", "unsure"] },
      },
      {
        id: "protective_order_exists",
        order: 42,
        group: "existing_orders",
        prompt: copy("q.protective_order_exists", "Is there a protective order or restraining order between you and anyone involved?"),
        answerType: "yes_no_unsure",
        matterTypes: ALL,
        required: true,
        safetySignalAnswers: ["yes"],
        staffNote: "A 'yes' is treated as a safety signal: DV-safe contact settings apply.",
      },
      {
        id: "upcoming_court_date",
        order: 43,
        group: "existing_orders",
        prompt: copy("q.upcoming_court_date", "Do you have a court date coming up?"),
        answerType: "yes_no_unsure",
        matterTypes: ALL,
        required: true,
        urgentSignalAnswers: ["yes"],
        staffNote: "Routes to the urgent-legal track (c66). Staff never tell the client what the date means.",
      },
      {
        id: "upcoming_court_date_when",
        order: 44,
        group: "existing_orders",
        prompt: copy("q.upcoming_court_date_when", "When is it, and which court?"),
        answerType: "short_text",
        matterTypes: ALL,
        required: false,
        askWhen: { questionId: "upcoming_court_date", answers: ["yes", "unsure"] },
      },
      {
        id: "served_papers",
        order: 45,
        group: "existing_orders",
        prompt: copy("q.served_papers", "Have you received court papers about this, for example from a process server or constable?"),
        answerType: "yes_no_unsure",
        matterTypes: ALL,
        required: true,
        urgentSignalAnswers: ["yes", "unsure"],
        staffNote: "Possible response deadline: urgent track; a lawyer reviews it (rules.court_deadlines).",
      },
      // --- The case ---
      {
        id: "help_wanted",
        order: 50,
        group: "case",
        prompt: copy("q.help_wanted", "In a few sentences, what would you like help with?"),
        answerType: "long_text",
        matterTypes: ALL,
        required: true,
      },
      {
        id: "county_and_time",
        order: 51,
        group: "case",
        prompt: copy("q.county_and_time", "Which county do you live in, and about how long have you lived there and in Texas?"),
        answerType: "short_text",
        matterTypes: ALL,
        required: true,
        staffNote: "Facts only. Whether residency or venue requirements are met is a lawyer decision (rules.all-engines.family.residency_venue).",
      },
      {
        id: "other_party_county",
        order: 52,
        group: "case",
        prompt: copy("q.other_party_county", "Which county or state does the other person live in, if you know?"),
        answerType: "short_text",
        matterTypes: ALL,
        required: false,
      },
      {
        id: "marriage_and_separation",
        order: 53,
        group: "case",
        prompt: copy("q.marriage_and_separation", "When did you marry, and are you living apart now? If so, since when?"),
        answerType: "short_text",
        matterTypes: ["divorce"],
        required: false,
      },
      {
        id: "support_now",
        order: 54,
        group: "case",
        prompt: copy("q.support_now", "Is anyone paying child support now, under a court order or an informal arrangement?"),
        answerType: "choice",
        choices: ["court_order", "informal", "none", "unsure"],
        matterTypes: CHILD_TYPES,
        required: false,
      },
      {
        id: "what_changed",
        order: 55,
        group: "case",
        prompt: copy("q.what_changed", "What has changed since the current order was made?"),
        answerType: "long_text",
        matterTypes: ["modification"],
        required: true,
      },
      {
        id: "order_not_followed",
        order: 56,
        group: "case",
        prompt: copy("q.order_not_followed", "Which part of the order is not being followed, and since when?"),
        answerType: "long_text",
        matterTypes: ["enforcement"],
        required: true,
      },
      // --- Finances (divorce) ---
      {
        id: "major_assets",
        order: 60,
        group: "finances",
        prompt: copy("q.major_assets", "Do you or your spouse own any of these: a home, retirement accounts, a business, other real estate?"),
        answerType: "multi_choice",
        choices: ["home", "retirement", "business", "other_real_estate", "none", "unsure"],
        matterTypes: ["divorce"],
        required: false,
      },
      {
        id: "records_access",
        order: 61,
        group: "finances",
        prompt: copy("q.records_access", "Can you safely get copies of recent financial records, such as pay stubs, bank statements and tax returns?"),
        answerType: "yes_no_unsure",
        matterTypes: ["divorce", "child_support", "modification"],
        required: false,
        staffNote: "The word 'safely' matters: never ask a DV-sensitive client to collect records in a way that could put them at risk.",
      },
    ],

    safety: {
      askSafetyFirst: true,
      routeTo: { emergencyCategory: "safety_dv", flagType: "intake.emergency" },
      markClientDvSensitive: true,
      safeContactDefaults: {
        requireSafeEmail: true,
        emailAllowed: true,
        smsAllowed: false,
        voicemailAllowed: false,
        sensitiveByEmail: false,
      },
      neverUseSharedDevices: true,
      notice: copy(
        "safety_notice",
        "Your safety comes first. If you are in danger, call 911. If someone may be reading your email or texts, tell us a safer way to reach you before you share details."
      ),
      signalResponse: copy(
        "safety_signal_response",
        "Thank you for telling us. A member of our team has been alerted and will contact you using the safe method you chose. If you are in danger now, call 911."
      ),
    },
  },

  // -------------------------------------------------------------------------
  // Conflict check (c56, c3): both spouses, the other parent, new partners and
  // grandparents are indexed because firms often hear from both sides.
  // -------------------------------------------------------------------------
  conflicts: {
    partyRoles: [
      { id: "client", label: "Client", partyRole: "client", indexRole: "client", relationship: "client", adverseByDefault: false, askAtIntake: false, indexByDefault: true, blocksClearIfUnnamed: false, matterTypes: ALL },
      { id: "spouse", label: "Spouse", partyRole: "opposing_party", indexRole: "opposing_party", relationship: "spouse", adverseByDefault: true, askAtIntake: true, indexByDefault: true, blocksClearIfUnnamed: true, matterTypes: ["divorce", "protective_order"] },
      { id: "other_parent", label: "Other parent of the child", partyRole: "opposing_party", indexRole: "opposing_party", relationship: "other parent", adverseByDefault: true, askAtIntake: true, indexByDefault: true, blocksClearIfUnnamed: true, matterTypes: CHILD_TYPES },
      { id: "protective_order_respondent", label: "Person the protection is sought from", partyRole: "opposing_party", indexRole: "opposing_party", relationship: "protective order respondent", adverseByDefault: true, askAtIntake: true, indexByDefault: true, blocksClearIfUnnamed: true, matterTypes: ["protective_order"] },
      { id: "new_partner", label: "New partner or spouse of the other party", partyRole: "related_party", indexRole: "related_party", relationship: "new partner", adverseByDefault: false, askAtIntake: true, indexByDefault: true, blocksClearIfUnnamed: false, matterTypes: LITIGATION_TYPES },
      { id: "grandparent", label: "Grandparent seeking custody or access", partyRole: "related_party", indexRole: "related_party", relationship: "grandparent", adverseByDefault: false, askAtIntake: true, indexByDefault: true, blocksClearIfUnnamed: false, matterTypes: ["custody_visitation", "modification", "divorce"] },
      { id: "other_relative", label: "Other relative seeking custody or access", partyRole: "related_party", indexRole: "related_party", relationship: "relative", adverseByDefault: false, askAtIntake: true, indexByDefault: true, blocksClearIfUnnamed: false, matterTypes: ["custody_visitation", "modification"] },
      { id: "child", label: "Child", partyRole: "child", indexRole: "related_party", relationship: "child", adverseByDefault: false, askAtIntake: false, indexByDefault: false, blocksClearIfUnnamed: false, matterTypes: CHILD_TYPES },
      { id: "opposing_counsel", label: "Other side's lawyer", partyRole: "opposing_counsel", indexRole: "opposing_counsel", relationship: "opposing counsel", adverseByDefault: true, askAtIntake: true, indexByDefault: true, blocksClearIfUnnamed: false, matterTypes: ALL },
      { id: "guardian_ad_litem", label: "Guardian ad litem / amicus attorney", partyRole: "guardian_ad_litem", indexRole: "other", relationship: "court appointee", adverseByDefault: false, askAtIntake: false, indexByDefault: true, blocksClearIfUnnamed: false, matterTypes: CHILD_TYPES },
    ],
  },

  // -------------------------------------------------------------------------
  // Documents (c84 folders, c49 checklists, c85 templates)
  // -------------------------------------------------------------------------
  documents: {
    folderTemplate: [
      { id: "engagement", name: "Engagement and intake", defaultPrivilege: "confidential" },
      {
        id: "client_provided",
        name: "From the client",
        defaultPrivilege: "confidential",
        clientVisibleFolder: true,
        children: [
          { id: "client_financial", name: "Financial records", defaultPrivilege: "confidential", clientVisibleFolder: true },
          { id: "client_children", name: "Children's records", defaultPrivilege: "confidential", clientVisibleFolder: true },
          { id: "client_orders", name: "Existing orders and court papers", defaultPrivilege: "none", clientVisibleFolder: true },
        ],
      },
      { id: "safety", name: "Safety (restricted)", defaultPrivilege: "confidential" },
      { id: "pleadings", name: "Pleadings and filings", defaultPrivilege: "none" },
      { id: "orders", name: "Court orders", defaultPrivilege: "none" },
      { id: "disclosures", name: "Inventory, disclosures and discovery", defaultPrivilege: "confidential" },
      { id: "mediation", name: "Mediation", defaultPrivilege: "confidential" },
      { id: "correspondence", name: "Correspondence", defaultPrivilege: "confidential" },
      { id: "work_product", name: "Attorney notes and work product", defaultPrivilege: "work_product" },
      { id: "billing", name: "Billing", defaultPrivilege: "confidential" },
    ],
    checklists: [
      {
        id: "divorce_core",
        label: "Divorce: financial disclosure and inventory",
        items: [
          { id: "pay_records", label: "Recent pay stubs or proof of income", providedBy: "client", required: true, folderId: "client_financial", clientRequest: copy("doc.pay_records", "Recent pay stubs or other proof of your income.") },
          { id: "tax_returns", label: "Recent tax returns", providedBy: "client", required: true, folderId: "client_financial", clientRequest: copy("doc.tax_returns", "Your recent tax returns, if you can get them safely.") },
          { id: "bank_statements", label: "Bank and credit-card statements", providedBy: "client", required: true, folderId: "client_financial", clientRequest: copy("doc.bank_statements", "Recent statements for bank accounts and credit cards in your name or shared with your spouse.") },
          { id: "retirement_statements", label: "Retirement and investment statements", providedBy: "client", required: false, folderId: "client_financial", clientRequest: copy("doc.retirement_statements", "Recent statements for any retirement or investment accounts.") },
          { id: "property_records", label: "Home, vehicle and other property records", providedBy: "client", required: false, folderId: "client_financial", clientRequest: copy("doc.property_records", "Papers for a home, vehicles or other property, such as a deed, mortgage statement or title.") },
          { id: "debt_records", label: "Debt statements (loans, mortgages, cards)", providedBy: "client", required: false, folderId: "client_financial", clientRequest: copy("doc.debt_records", "Statements for loans or other debts.") },
          { id: "marital_agreements", label: "Any premarital or marital property agreement", providedBy: "client", required: false, folderId: "client_financial", clientRequest: copy("doc.marital_agreements", "Any agreement you and your spouse signed about property, before or during the marriage.") },
          { id: "inventory", label: "Inventory and appraisement (draft)", providedBy: "firm", required: true, folderId: "disclosures", templateId: "inventory" },
          { id: "financial_disclosure", label: "Financial disclosures (draft)", providedBy: "firm", required: true, folderId: "disclosures", templateId: "financial_disclosure" },
          { id: "divorce_petition", label: "Petition (lawyer-reviewed template)", providedBy: "firm", required: true, folderId: "pleadings", templateId: "divorce_petition" },
          { id: "service_proof", label: "Proof of service or waiver", providedBy: "court", required: true, folderId: "pleadings" },
          { id: "final_decree", label: "Final decree (signed)", providedBy: "court", required: true, folderId: "orders" },
        ],
      },
      {
        id: "children_core",
        label: "Children: custody, visitation and support",
        items: [
          { id: "birth_certificates", label: "Children's birth certificates", providedBy: "client", required: false, folderId: "client_children", clientRequest: copy("doc.birth_certificates", "Your children's birth certificates, if you have them.") },
          { id: "school_medical", label: "Current schools, doctors and health insurance", providedBy: "client", required: true, folderId: "client_children", clientRequest: copy("doc.school_medical", "The names of your children's current schools and doctors, and their health insurance details.") },
          { id: "child_costs", label: "Child-care, health-insurance and other child costs", providedBy: "client", required: false, folderId: "client_children", clientRequest: copy("doc.child_costs", "What you pay for child care, the children's health insurance and other regular child costs.") },
          { id: "current_orders", label: "Existing custody or support orders", providedBy: "client", required: false, folderId: "client_orders", clientRequest: copy("doc.current_orders", "Copies of any court orders about your children or child support.") },
          { id: "parenting_plan", label: "Parenting plan (draft)", providedBy: "firm", required: true, folderId: "pleadings", templateId: "parenting_plan" },
          { id: "support_worksheet", label: "Child-support worksheet (lawyer tool)", providedBy: "firm", required: false, folderId: "work_product", templateId: "support_worksheet" },
        ],
      },
      {
        id: "protective_order_core",
        label: "Protective order",
        items: [
          { id: "incident_records", label: "Records of incidents (photos, messages, notes)", providedBy: "client", required: false, folderId: "safety", clientRequest: copy("doc.incident_records", "Only if it is safe to do so: photos, messages or notes about what happened. Do not take risks to collect them.") },
          { id: "police_reports", label: "Police or medical reports", providedBy: "third_party", required: false, folderId: "safety" },
          { id: "existing_protective_orders", label: "Any existing protective or restraining orders", providedBy: "client", required: false, folderId: "client_orders", clientRequest: copy("doc.existing_protective_orders", "Copies of any protective or restraining orders, if you have them.") },
          { id: "po_application", label: "Application (lawyer-reviewed template)", providedBy: "firm", required: true, folderId: "pleadings", templateId: "protective_order_application" },
        ],
      },
      {
        id: "order_change_core",
        label: "Modification or enforcement",
        items: [
          { id: "order_to_change", label: "The current order", providedBy: "client", required: true, folderId: "client_orders", clientRequest: copy("doc.order_to_change", "A copy of the court order you want changed or enforced, if you have it.") },
          { id: "payment_history", label: "Payment history (support)", providedBy: "client", required: false, folderId: "client_financial", clientRequest: copy("doc.payment_history", "Any record of child-support payments made or missed.") },
          { id: "missed_time_log", label: "Record of missed or denied parenting time", providedBy: "client", required: false, folderId: "client_children", clientRequest: copy("doc.missed_time_log", "A list of dates when parenting time was missed or refused, with any messages about it.") },
          { id: "motion", label: "Motion or petition (lawyer-reviewed template)", providedBy: "firm", required: true, folderId: "pleadings", templateId: "modification_or_enforcement_motion" },
        ],
      },
    ],
    templates: [
      { id: "divorce_petition", label: "Divorce petition", kind: "petition", gateKey: FAMILY_RULE_KEYS.starterTemplates, matterTypes: ["divorce"] },
      { id: "custody_petition", label: "Custody / parent-child petition", kind: "petition", gateKey: FAMILY_RULE_KEYS.starterTemplates, matterTypes: ["custody_visitation", "child_support"] },
      { id: "protective_order_application", label: "Protective-order application", kind: "petition", gateKey: FAMILY_RULE_KEYS.starterTemplates, matterTypes: ["protective_order"] },
      { id: "modification_or_enforcement_motion", label: "Modification / enforcement petition or motion", kind: "petition", gateKey: FAMILY_RULE_KEYS.starterTemplates, matterTypes: ["modification", "enforcement"] },
      { id: "parenting_plan", label: "Parenting plan", kind: "agreement", gateKey: FAMILY_RULE_KEYS.starterTemplates, matterTypes: CHILD_TYPES },
      { id: "inventory", label: "Inventory and appraisement", kind: "disclosure", gateKey: FAMILY_RULE_KEYS.starterTemplates, matterTypes: ["divorce"] },
      { id: "financial_disclosure", label: "Financial disclosure", kind: "disclosure", gateKey: FAMILY_RULE_KEYS.starterTemplates, matterTypes: ["divorce", "child_support", "modification"] },
      { id: "support_worksheet", label: "Child-support worksheet", kind: "worksheet", gateKey: FAMILY_RULE_KEYS.childSupportGuidelines, matterTypes: CHILD_TYPES },
      { id: "final_decree", label: "Final decree / final order", kind: "order", gateKey: FAMILY_RULE_KEYS.starterTemplates, matterTypes: LITIGATION_TYPES },
    ],
  },

  // -------------------------------------------------------------------------
  // Task lists (c94) — workflow suggestions, internal, business days
  // -------------------------------------------------------------------------
  tasks: {
    lists: [
      {
        id: "family_opening",
        label: "Every new family matter",
        trigger: { on: "matter_opened" },
        matterTypes: ALL,
        tasks: [
          { id: "confirm_safe_contact", title: "Confirm the client's safe-contact settings before any outbound message", assigneeRole: "intake_staff", dueBusinessDays: 1, kind: "all-engines.family.confirm_safe_contact", visibility: "internal" },
          { id: "confirm_parties_indexed", title: "Check every party (spouse/other parent, new partners, relatives) is on the matter and in the conflict index", assigneeRole: "paralegal", dueBusinessDays: 1, kind: "all-engines.family.confirm_parties_indexed", visibility: "internal" },
          { id: "review_reported_dates", title: "Lawyer reviews any court date or served papers the client reported", assigneeRole: "lawyer", dueBusinessDays: 1, kind: "all-engines.family.review_reported_dates", ruleRef: "answer_deadline", visibility: "internal" },
          { id: "send_checklist", title: "Send the document checklist through the portal", assigneeRole: "paralegal", dueBusinessDays: 2, kind: "all-engines.family.send_checklist", visibility: "internal" },
          { id: "retainer_check", title: "Check the retainer and engagement agreement are in place", assigneeRole: "bookkeeper", dueBusinessDays: 2, kind: "all-engines.family.retainer_check", visibility: "internal" },
        ],
      },
      {
        id: "protective_order_opening",
        label: "Protective order: first steps",
        trigger: { on: "matter_opened" },
        matterTypes: ["protective_order"],
        tasks: [
          { id: "safety_handoff", title: "Confirm the safety hand-off (c66) was completed and the client has a safe contact method", assigneeRole: "lawyer", dueBusinessDays: 0, kind: "all-engines.family.safety_handoff", visibility: "internal" },
          { id: "po_timing_review", title: "Lawyer reviews protective-order timing for this court", assigneeRole: "lawyer", dueBusinessDays: 0, kind: "all-engines.family.po_timing_review", ruleRef: "protective_order_timing", visibility: "internal" },
        ],
      },
      {
        id: "preparing_filing",
        label: "Preparing to file",
        trigger: { on: "stage_entered", stageId: "preparing_filing" },
        matterTypes: LITIGATION_TYPES,
        tasks: [
          { id: "residency_review", title: "Lawyer reviews residency and venue facts", assigneeRole: "lawyer", dueBusinessDays: 2, kind: "all-engines.family.residency_review", ruleRef: "residency_venue", visibility: "internal" },
          { id: "draft_petition", title: "Draft the petition from the reviewed template", assigneeRole: "paralegal", dueBusinessDays: 5, kind: "all-engines.family.draft_petition", visibility: "internal" },
          { id: "review_petition", title: "Lawyer reviews and approves the petition", assigneeRole: "lawyer", dueBusinessDays: 7, kind: "all-engines.family.review_petition", visibility: "internal" },
          { id: "modification_review", title: "Lawyer reviews whether a modification can be brought now", assigneeRole: "lawyer", dueBusinessDays: 3, kind: "all-engines.family.modification_review", ruleRef: "modification_eligibility", visibility: "internal" },
        ],
      },
      {
        id: "filed_and_serving",
        label: "Filed and serving",
        trigger: { on: "stage_entered", stageId: "filed_and_serving" },
        matterTypes: LITIGATION_TYPES,
        tasks: [
          { id: "arrange_service", title: "Arrange service or a waiver (DV-safe: never through the client)", assigneeRole: "paralegal", dueBusinessDays: 2, kind: "all-engines.family.arrange_service", visibility: "internal" },
          { id: "waiting_period_review", title: "Lawyer reviews the earliest final-hearing date (proposed only)", assigneeRole: "lawyer", dueBusinessDays: 3, kind: "all-engines.family.waiting_period_review", ruleRef: "divorce_waiting_period", visibility: "internal" },
        ],
      },
      {
        id: "temporary_orders",
        label: "Temporary orders",
        trigger: { on: "stage_entered", stageId: "temporary_orders" },
        matterTypes: LITIGATION_TYPES,
        tasks: [
          { id: "support_worksheet", title: "Lawyer prepares the child-support worksheet", assigneeRole: "lawyer", dueBusinessDays: 3, kind: "all-engines.family.support_worksheet", ruleRef: "child_support_guidelines", visibility: "internal" },
          { id: "possession_review", title: "Lawyer reviews the proposed parenting-time schedule", assigneeRole: "lawyer", dueBusinessDays: 3, kind: "all-engines.family.possession_review", ruleRef: "possession_schedule", visibility: "internal" },
        ],
      },
      {
        id: "disclosures",
        label: "Inventory and disclosures",
        trigger: { on: "stage_entered", stageId: "disclosures" },
        matterTypes: ["divorce", "child_support", "modification"],
        tasks: [
          { id: "prepare_inventory", title: "Prepare the inventory and financial disclosures from client records", assigneeRole: "paralegal", dueBusinessDays: 10, kind: "all-engines.family.prepare_inventory", visibility: "internal" },
          { id: "review_disclosures", title: "Lawyer reviews the disclosures before they are served", assigneeRole: "lawyer", dueBusinessDays: 12, kind: "all-engines.family.review_disclosures", ruleRef: "answer_deadline", visibility: "internal" },
        ],
      },
      {
        id: "mediation",
        label: "Mediation",
        trigger: { on: "stage_entered", stageId: "mediation" },
        matterTypes: LITIGATION_TYPES,
        tasks: [
          { id: "schedule_mediation", title: "Schedule mediation (check safety arrangements, e.g. separate rooms)", assigneeRole: "paralegal", dueBusinessDays: 5, kind: "all-engines.family.schedule_mediation", visibility: "internal" },
          { id: "mediation_summary", title: "Prepare the mediation summary", assigneeRole: "lawyer", dueBusinessDays: 10, kind: "all-engines.family.mediation_summary", visibility: "internal" },
        ],
      },
      {
        id: "final_orders",
        label: "Final orders",
        trigger: { on: "stage_entered", stageId: "final_orders" },
        matterTypes: LITIGATION_TYPES,
        tasks: [
          { id: "draft_final_order", title: "Draft the final decree or order", assigneeRole: "paralegal", dueBusinessDays: 5, kind: "all-engines.family.draft_final_order", visibility: "internal" },
          { id: "review_final_order", title: "Lawyer reviews and approves the final order", assigneeRole: "lawyer", dueBusinessDays: 7, kind: "all-engines.family.review_final_order", visibility: "internal" },
          { id: "post_order_review", title: "Lawyer reviews post-order items (support set-up, enforcement time limits)", assigneeRole: "lawyer", dueBusinessDays: 10, kind: "all-engines.family.post_order_review", ruleRef: "enforcement_time_limits", visibility: "internal" },
        ],
      },
    ],
  },

  // -------------------------------------------------------------------------
  // Stages (c95)
  // -------------------------------------------------------------------------
  stages: {
    tracks: [
      {
        id: "family_litigation",
        label: "Family case (filing to final order)",
        stages: [
          { id: "consultation", label: "Consultation", systemStage: "prospective", clientLabel: copy("stage.consultation", "Consultation") },
          { id: "retained", label: "Retained", systemStage: "retained", clientLabel: copy("stage.retained", "Getting started") },
          { id: "preparing_filing", label: "Preparing to file", clientLabel: copy("stage.preparing_filing", "Preparing your papers") },
          { id: "filed_and_serving", label: "Filed and serving", clientLabel: copy("stage.filed_and_serving", "Filed with the court") },
          { id: "temporary_orders", label: "Temporary orders", clientLabel: copy("stage.temporary_orders", "Temporary orders") },
          { id: "disclosures", label: "Inventory, disclosures and discovery", clientLabel: copy("stage.disclosures", "Exchanging information") },
          { id: "mediation", label: "Mediation", clientLabel: copy("stage.mediation", "Mediation") },
          { id: "final_hearing", label: "Final hearing or trial", clientLabel: copy("stage.final_hearing", "Final hearing") },
          { id: "final_orders", label: "Final orders", clientLabel: copy("stage.final_orders", "Final order") },
          { id: "post_order", label: "After the order", clientLabel: copy("stage.post_order", "After your order") },
          { id: "closed", label: "Closed", systemStage: "closed", clientLabel: copy("stage.closed", "Closed") },
        ],
      },
      {
        id: "family_protective_order",
        label: "Protective order",
        stages: [
          { id: "consultation", label: "Consultation", systemStage: "prospective", clientLabel: copy("stage.consultation", "Consultation") },
          { id: "retained", label: "Retained", systemStage: "retained", clientLabel: copy("stage.retained", "Getting started") },
          { id: "application_prepared", label: "Application prepared", clientLabel: copy("stage.application_prepared", "Preparing your application") },
          { id: "application_filed", label: "Application filed", clientLabel: copy("stage.application_filed", "Filed with the court") },
          { id: "hearing", label: "Hearing", clientLabel: copy("stage.hearing", "Hearing") },
          { id: "order_decided", label: "Order decided", clientLabel: copy("stage.order_decided", "Court decision") },
          { id: "post_order", label: "After the order", clientLabel: copy("stage.post_order", "After your order") },
          { id: "closed", label: "Closed", systemStage: "closed", clientLabel: copy("stage.closed", "Closed") },
        ],
      },
    ],
  },

  // -------------------------------------------------------------------------
  // Deadlines and Texas rules (c92, c93) — REFERENCES ONLY, lawyer tools.
  // -------------------------------------------------------------------------
  deadlines: {
    rules: [
      { id: "divorce_waiting_period", label: "Divorce waiting-period calculator", kind: "waiting_period", gateKey: FAMILY_RULE_KEYS.divorceWaitingPeriod, ownerEngine: "calendar-core", matterTypes: ["divorce"], audience: "lawyer_tool", note: "Proposes the earliest date a divorce could be granted, for a lawyer to confirm. Value and exceptions pending attorney review; never told to the client as a date." },
      { id: "residency_venue", label: "Residency and venue check", kind: "eligibility_rule", gateKey: FAMILY_RULE_KEYS.residencyVenue, ownerEngine: "intake", matterTypes: LITIGATION_TYPES, audience: "lawyer_tool", note: "Shows the lawyer the residency facts gathered at intake against the attorney-reviewed rule. Never an automatic decline." },
      { id: "answer_deadline", label: "Response / answer date after service", kind: "court_deadline", gateKey: SHARED_RULE_KEYS.courtDeadlines, ownerEngine: "calendar-core", matterTypes: ALL, audience: "lawyer_tool", note: "Uses the shared court-deadline rules; the date is proposed until a lawyer confirms it." },
      { id: "protective_order_timing", label: "Protective-order hearing and temporary-order timing", kind: "court_deadline", gateKey: FAMILY_RULE_KEYS.protectiveOrderTiming, ownerEngine: "calendar-core", matterTypes: ["protective_order"], audience: "lawyer_tool", note: "Real clock. Hearing timing and how long temporary orders last vary by court; pending attorney review." },
      { id: "child_support_guidelines", label: "Child-support guideline calculator", kind: "guideline_calculator", gateKey: FAMILY_RULE_KEYS.childSupportGuidelines, ownerEngine: "all-engines", matterTypes: CHILD_TYPES, audience: "lawyer_tool", note: "Lawyer worksheet only. Percentages, caps and income definitions live in gated config and change by law; never shown to a client as an amount they will get or pay." },
      { id: "possession_schedule", label: "Standard parenting-time schedule reference", kind: "guideline_calculator", gateKey: FAMILY_RULE_KEYS.possessionSchedule, ownerEngine: "all-engines", matterTypes: CHILD_TYPES, audience: "lawyer_tool", note: "Generates a draft calendar from the attorney-reviewed schedule rules for the lawyer to adjust." },
      { id: "modification_eligibility", label: "Modification timing and grounds check", kind: "eligibility_rule", gateKey: FAMILY_RULE_KEYS.modificationEligibility, ownerEngine: "all-engines", matterTypes: ["modification"], audience: "lawyer_tool", note: "Prompts the lawyer with the attorney-reviewed questions; the product never decides whether grounds exist." },
      { id: "enforcement_time_limits", label: "Enforcement time limits", kind: "limitation_period", gateKey: SHARED_RULE_KEYS.limitationPeriods, ownerEngine: "calendar-core", matterTypes: ["enforcement", "divorce"], audience: "lawyer_tool", note: "Uses the shared limitation-period rules; reminders are proposed to the lawyer." },
      { id: "statutory_forms", label: "Required notices and statutory forms", kind: "statutory_form", gateKey: FAMILY_RULE_KEYS.statutoryForms, ownerEngine: "document", matterTypes: ALL, audience: "lawyer_tool", note: "Which statutory warnings/forms a filing needs. The pack holds no form text." },
    ],
  },

  // -------------------------------------------------------------------------
  // Billing (c50/c52; trust c75) — retainer + hourly is the usual model
  // -------------------------------------------------------------------------
  billing: {
    defaultFeeType: "retainer_hourly",
    offeredFeeTypes: ["retainer_hourly", "hourly", "flat_fee"],
    withheldFeeTypes: [
      {
        feeType: "contingency",
        gateKey: SHARED_RULE_KEYS.feeAgreementTerms,
        why: "Contingent fees in family-law matters raise professional-conduct questions; not offered in this area unless an attorney's review says otherwise.",
      },
    ],
    retainerFloorFromFirmSettings: true,
    feeTermsGateKey: SHARED_RULE_KEYS.feeAgreementTerms,
    trustGateKey: SHARED_RULE_KEYS.trustAccounting,
  },
};
