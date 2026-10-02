// Tables owned by the Conflict-check engine (c3, c55–c63, c96, c97).
//
// Conventions (see ./foundation.ts): NOT NULL tenantId -> firms.id on every
// tenant-scoped table, text + CHECK for statuses, timestamptz everywhere.
// Migrations are generated once at integration time; the RLS / GRANT needs of
// these tables are listed in MIGRATION NOTES at the bottom of this file.
//
// Why a separate `conflict_checks` table instead of only
// `conflict_check_results` (schema.ts): that table requires an
// intake_session_id and a firm_config_version_id, but checks on open
// matters, lateral hires (c61) and lawyer interests (c97) have neither. The
// engine records every check here and, when the check belongs to an intake
// session, also links the legacy row (`legacyResultId`). See the PR's
// shared requests: once `conflict_check_results.intake_session_id` is made
// nullable the two can be folded together.

import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  real,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { firms, users, matters, parties, intakeSessions, conflictCheckResults, documents } from "../schema";
import { tasks } from "./foundation";

// ---------------------------------------------------------------------------
// Access: conflicts role (local stand-in for c99's role model)
// ---------------------------------------------------------------------------

/**
 * Who holds the conflicts role in a firm. `user_role` (schema.ts) has no
 * conflicts role yet (it arrives with c99); until then the engine keeps its
 * own grants. Exactly one active grant per firm may be `designated` (the
 * firm-designated conflicts attorney, c59); any number may be `backup`.
 */
export const conflictRoleGrants = pgTable("conflict_role_grants", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  userId: uuid("user_id").notNull().references(() => users.id),
  /** 'conflicts_attorney' (may decide) | 'conflicts_staff' (may search/prepare, not decide). */
  role: text("role").notNull(),
  designated: boolean("designated").notNull().default(false),
  backup: boolean("backup").notNull().default(false),
  grantedByUserId: uuid("granted_by_user_id").references(() => users.id),
  grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokedReason: text("revoked_reason"),
}, (t) => [
  index("conflict_role_grants_tenant_user_idx").on(t.tenantId, t.userId),
  uniqueIndex("conflict_role_grants_one_designated")
    .on(t.tenantId)
    .where(sql`${t.designated} and ${t.revokedAt} is null`),
  check("conflict_role_grants_role_check", sql`${t.role} in ('conflicts_attorney','conflicts_staff')`),
  check("conflict_role_grants_designated_attorney_check", sql`not ${t.designated} or ${t.role} = 'conflicts_attorney'`),
]);

// ---------------------------------------------------------------------------
// c56 — party index
// ---------------------------------------------------------------------------

/**
 * Typed name variants (c56 business rule 6). `parties.aliases` /
 * `normalized_aliases` are kept in sync as the untyped mirror other engines
 * read; this table carries the type and source.
 */
export const partyNameVariants = pgTable("party_name_variants", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  partyId: uuid("party_id").notNull().references(() => parties.id),
  name: text("name").notNull(),
  normalizedName: text("normalized_name").notNull(),
  /** 'legal' | 'alias' | 'former' | 'maiden' | 'married' | 'nickname' | 'business' | 'dba'. */
  nameType: text("name_type").notNull(),
  /** 'intake' | 'matter' | 'document' | 'import' | 'manual'. */
  source: text("source").notNull(),
  createdByUserId: uuid("created_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("party_name_variants_tenant_name_idx").on(t.tenantId, t.normalizedName),
  index("party_name_variants_tenant_party_idx").on(t.tenantId, t.partyId),
  uniqueIndex("party_name_variants_party_name_type_key").on(t.partyId, t.normalizedName, t.nameType),
  check(
    "party_name_variants_type_check",
    sql`${t.nameType} in ('legal','alias','former','maiden','married','nickname','business','dba')`
  ),
  check("party_name_variants_source_check", sql`${t.source} in ('intake','matter','document','import','manual')`),
]);

/** Organisation links (parent/subsidiary, affiliate), searched to a firm-set depth (c56 rule 10). */
export const partyOrgLinks = pgTable("party_org_links", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  parentPartyId: uuid("parent_party_id").notNull().references(() => parties.id),
  childPartyId: uuid("child_party_id").notNull().references(() => parties.id),
  /** 'parent_subsidiary' | 'affiliate'. */
  linkType: text("link_type").notNull(),
  source: text("source").notNull().default("manual"),
  createdByUserId: uuid("created_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("party_org_links_pair_key").on(t.tenantId, t.parentPartyId, t.childPartyId, t.linkType),
  check("party_org_links_type_check", sql`${t.linkType} in ('parent_subsidiary','affiliate')`),
  check("party_org_links_not_self_check", sql`${t.parentPartyId} <> ${t.childPartyId}`),
]);

/**
 * Parties linked to an intake session before (or without) a matter — every
 * prospective client, including declined and conflicted-out inquiries (c56
 * §4.3, c62). Open question 4 in the spec (prospective matter vs this table)
 * is still open; this table keeps pre-matter links without the intake engine
 * having to create a matter.
 */
export const inquiryParties = pgTable("inquiry_parties", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  intakeSessionId: uuid("intake_session_id").notNull().references(() => intakeSessions.id),
  /** Null when the caller refused / could not name the party (name_unknown). */
  partyId: uuid("party_id").references(() => parties.id),
  /** 'prospective_client' | 'opposing_party' | 'related_party' | 'co_party' | 'opposing_counsel' | 'insurer' | 'co_defendant' | 'other'. */
  role: text("role").notNull(),
  /** e.g. 'spouse', 'former_spouse', 'other_parent', 'new_partner', 'grandparent'. */
  relationship: text("relationship"),
  nameUnknown: boolean("name_unknown").notNull().default(false),
  /** 'full' | 'partial' (first name or nickname only; c57 over-flags). */
  nameCompleteness: text("name_completeness").notNull().default("full"),
  /** 'current' while the inquiry is open; 'former' once it ends (kept forever for conflicts). */
  status: text("status").notNull().default("current"),
  /** Firm users who spoke with the prospect (needed for a later Rule 1.18 analysis). */
  spokeWithUserIds: uuid("spoke_with_user_ids").array().notNull().default(sql`'{}'::uuid[]`),
  addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
}, (t) => [
  index("inquiry_parties_tenant_session_idx").on(t.tenantId, t.intakeSessionId),
  index("inquiry_parties_tenant_party_idx").on(t.tenantId, t.partyId),
  check(
    "inquiry_parties_role_check",
    sql`${t.role} in ('prospective_client','opposing_party','related_party','co_party','opposing_counsel','insurer','co_defendant','other')`
  ),
  check("inquiry_parties_status_check", sql`${t.status} in ('current','former')`),
  check("inquiry_parties_completeness_check", sql`${t.nameCompleteness} in ('full','partial')`),
  check("inquiry_parties_unknown_check", sql`${t.nameUnknown} or ${t.partyId} is not null`),
]);

/** Likely duplicates for a person to confirm or reject (never auto-merged, c56 rule 4). */
export const partyMergeSuggestions = pgTable("party_merge_suggestions", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  /** Pair is stored with partyAId < partyBId so the same pair is never suggested twice. */
  partyAId: uuid("party_a_id").notNull().references(() => parties.id),
  partyBId: uuid("party_b_id").notNull().references(() => parties.id),
  score: real("score").notNull(),
  reasons: text("reasons").array().notNull().default(sql`'{}'::text[]`),
  /** 'open' | 'confirmed' | 'rejected'. */
  status: text("status").notNull().default("open"),
  decidedByUserId: uuid("decided_by_user_id").references(() => users.id),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("party_merge_suggestions_pair_key").on(t.tenantId, t.partyAId, t.partyBId),
  index("party_merge_suggestions_tenant_status_idx").on(t.tenantId, t.status, t.createdAt),
  check("party_merge_suggestions_status_check", sql`${t.status} in ('open','confirmed','rejected')`),
  check("party_merge_suggestions_order_check", sql`${t.partyAId} < ${t.partyBId}`),
]);

/**
 * Confirmed merges. Nothing is moved or deleted: the merged record simply
 * resolves to the survivor while the merge is active, so an undo restores
 * both records and every link exactly (c56 §4.5 step 3).
 */
export const partyMerges = pgTable("party_merges", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  survivorPartyId: uuid("survivor_party_id").notNull().references(() => parties.id),
  mergedPartyId: uuid("merged_party_id").notNull().references(() => parties.id),
  suggestionId: uuid("suggestion_id").references(() => partyMergeSuggestions.id),
  mergedByUserId: uuid("merged_by_user_id").notNull().references(() => users.id),
  reason: text("reason").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  undoneAt: timestamp("undone_at", { withTimezone: true }),
  undoneByUserId: uuid("undone_by_user_id").references(() => users.id),
  undoReason: text("undo_reason"),
}, (t) => [
  uniqueIndex("party_merges_active_merged_key").on(t.tenantId, t.mergedPartyId).where(sql`${t.undoneAt} is null`),
  check("party_merges_not_self_check", sql`${t.survivorPartyId} <> ${t.mergedPartyId}`),
  check("party_merges_reason_check", sql`length(${t.reason}) > 0`),
]);

/** Deletion requests against index entries: never auto-deleted; a conflicts attorney decides (c56 §4.6). */
export const partyRetentionRequests = pgTable("party_retention_requests", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  partyId: uuid("party_id").notNull().references(() => parties.id),
  requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
  requestNote: text("request_note"),
  /** 'open' | 'kept_minimal' | 'removed'. */
  status: text("status").notNull().default("open"),
  legalBasis: text("legal_basis"),
  decidedByUserId: uuid("decided_by_user_id").references(() => users.id),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
}, (t) => [
  index("party_retention_requests_tenant_status_idx").on(t.tenantId, t.status),
  check("party_retention_requests_status_check", sql`${t.status} in ('open','kept_minimal','removed')`),
  check(
    "party_retention_requests_decided_check",
    sql`${t.status} = 'open' or (${t.decidedByUserId} is not null and ${t.legalBasis} is not null)`
  ),
]);

// ---------------------------------------------------------------------------
// c3 / c59 / c63 — checks, decisions, waivers, screens, gate
// ---------------------------------------------------------------------------

/** One record per conflict check (the c63 log reads these). */
export const conflictChecks = pgTable("conflict_checks", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  /** 'intake' | 'party_added' | 'reopened' | 'lateral_hire' | 'periodic' | 'interest' | 'manual'. */
  trigger: text("trigger").notNull(),
  intakeSessionId: uuid("intake_session_id").references(() => intakeSessions.id),
  matterId: uuid("matter_id").references(() => matters.id),
  lateralCheckId: uuid("lateral_check_id"),
  interestDisclosureId: uuid("interest_disclosure_id"),
  /**
   * Open matters whose gate this check closes besides `matterId` — e.g. a
   * lawyer adds an interest that matches a party on two open matters (c97
   * §4.3): both close for NEW actions until the attorney decides.
   */
  affectedMatterIds: uuid("affected_matter_ids").array().notNull().default(sql`'{}'::uuid[]`),
  /** The legacy conflict_check_results row, when the check belongs to an intake session. */
  legacyResultId: uuid("legacy_result_id").references(() => conflictCheckResults.id),
  /** Null = started by the system. */
  triggeredByUserId: uuid("triggered_by_user_id").references(() => users.id),
  /** Role the prospective client seeks (c3 is role-sensitive), e.g. 'petitioner'. */
  roleSought: text("role_sought"),
  /** Names as entered at check time (c63 §4.4: shown even after later merges). */
  searchedNames: jsonb("searched_names").$type<unknown[]>().notNull().default([]),
  /** ConflictHit[] (see src/engines/conflict-check/types.ts). Internal: conflicts role only. */
  hits: jsonb("hits").$type<unknown[]>().notNull().default([]),
  /** 'clear' | 'possible' | 'definite'. Never 'clear' while any hit or unknown name exists. */
  outcome: text("outcome").notNull(),
  /** Why the outcome is not clear, e.g. ['hits','name_unknown','history_not_loaded','index_write_failed']. */
  outcomeReasons: text("outcome_reasons").array().notNull().default(sql`'{}'::text[]`),
  /** True when the c55 rule table was applied (only once `rules.conflicts` is approved). */
  ruleTableApplied: boolean("rule_table_applied").notNull().default(false),
  /**
   * c3: the role-matrix evaluation (RoleEvaluation in
   * src/engines/conflict-check/coreCheck.ts): the role sought, which barring
   * conditions each hit meets, and whether the matrix was applied (only once
   * `rules.conflicts` is approved). Internal: conflicts role only.
   */
  roleEvaluation: jsonb("role_evaluation").$type<Record<string, unknown>>().notNull().default({}),
  /** 'open' (awaiting decision) | 'decided' | 'superseded' | 'not_required' (clear). */
  status: text("status").notNull(),
  decisionTaskId: uuid("decision_task_id").references(() => tasks.id),
  assignedUserId: uuid("assigned_user_id").references(() => users.id),
  dueAt: timestamp("due_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
}, (t) => [
  index("conflict_checks_tenant_status_idx").on(t.tenantId, t.status, t.createdAt),
  index("conflict_checks_tenant_session_idx").on(t.tenantId, t.intakeSessionId),
  index("conflict_checks_tenant_matter_idx").on(t.tenantId, t.matterId),
  check(
    "conflict_checks_trigger_check",
    sql`${t.trigger} in ('intake','party_added','reopened','lateral_hire','periodic','interest','manual')`
  ),
  check("conflict_checks_outcome_check", sql`${t.outcome} in ('clear','possible','definite')`),
  check("conflict_checks_status_check", sql`${t.status} in ('open','decided','superseded','not_required')`),
  // The system can never produce a clear result for a check that has hits.
  check("conflict_checks_clear_has_no_hits_check", sql`${t.outcome} <> 'clear' or jsonb_array_length(${t.hits}) = 0`),
]);

/**
 * Attorney decisions. APPEND-ONLY (no UPDATE/DELETE grant): corrections are
 * new rows with `supersedesDecisionId` (c59 business rule 4).
 */
export const conflictDecisions = pgTable("conflict_decisions", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  checkId: uuid("check_id").notNull().references(() => conflictChecks.id),
  /** 'cleared' | 'proceed_with_consent' | 'proceed_with_screen' | 'declined'. */
  decision: text("decision").notNull(),
  reasonCode: text("reason_code").notNull(),
  reasonText: text("reason_text"),
  /** Rule-table row(s) shown to the attorney (null while rules.conflicts is pending). */
  ruleTableRefs: text("rule_table_refs").array().notNull().default(sql`'{}'::text[]`),
  /** 'rule table does not fit' override, or 'cleared' on a definite result: flagged to the owner. */
  overrideFlag: boolean("override_flag").notNull().default(false),
  consentPartyIds: uuid("consent_party_ids").array().notNull().default(sql`'{}'::uuid[]`),
  screenedUserIds: uuid("screened_user_ids").array().notNull().default(sql`'{}'::uuid[]`),
  /** Always a human holding the conflicts role (the AI never decides, c59 rule 1). */
  decidedByUserId: uuid("decided_by_user_id").notNull().references(() => users.id),
  decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
  supersedesDecisionId: uuid("supersedes_decision_id"),
}, (t) => [
  index("conflict_decisions_tenant_check_idx").on(t.tenantId, t.checkId, t.decidedAt),
  check(
    "conflict_decisions_decision_check",
    sql`${t.decision} in ('cleared','proceed_with_consent','proceed_with_screen','declined')`
  ),
  check("conflict_decisions_reason_check", sql`length(${t.reasonCode}) > 0`),
  check(
    "conflict_decisions_consent_parties_check",
    sql`${t.decision} <> 'proceed_with_consent' or cardinality(${t.consentPartyIds}) > 0`
  ),
  check(
    "conflict_decisions_screen_users_check",
    sql`${t.decision} <> 'proceed_with_screen' or cardinality(${t.screenedUserIds}) > 0`
  ),
]);

/** One written-consent waiver per affected client (c59 §4.4). */
export const conflictWaivers = pgTable("conflict_waivers", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  decisionId: uuid("decision_id").notNull().references(() => conflictDecisions.id),
  checkId: uuid("check_id").notNull().references(() => conflictChecks.id),
  clientPartyId: uuid("client_party_id").notNull().references(() => parties.id),
  /** Set once the Document engine files the waiver (documents.matter_id is NOT NULL, so intake-only waivers wait). */
  documentId: uuid("document_id").references(() => documents.id),
  /** 'draft' | 'approved' | 'sent' | 'signed' | 'refused' | 'expired' | 'cancelled'. */
  status: text("status").notNull().default("draft"),
  approvedByUserId: uuid("approved_by_user_id").references(() => users.id),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  /** Signer due date (firm setting, business hours). */
  dueAt: timestamp("due_at", { withTimezone: true }),
  /** Outer limit after which the task returns to the conflicts attorney. */
  outerLimitAt: timestamp("outer_limit_at", { withTimezone: true }),
  signedAt: timestamp("signed_at", { withTimezone: true }),
  countersignRequired: boolean("countersign_required").notNull().default(true),
  countersignedAt: timestamp("countersigned_at", { withTimezone: true }),
  countersignedByUserId: uuid("countersigned_by_user_id").references(() => users.id),
  refusedAt: timestamp("refused_at", { withTimezone: true }),
  lastReminderAt: timestamp("last_reminder_at", { withTimezone: true }),
  /** E-signature provider envelope id (vendor-gated). */
  providerRef: text("provider_ref"),
  /** Why the waiver is not moving, e.g. the pending gate placeholder. Internal. */
  holdReason: text("hold_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("conflict_waivers_tenant_check_idx").on(t.tenantId, t.checkId),
  index("conflict_waivers_tenant_status_idx").on(t.tenantId, t.status, t.dueAt),
  check(
    "conflict_waivers_status_check",
    sql`${t.status} in ('draft','approved','sent','signed','refused','expired','cancelled')`
  ),
  check("conflict_waivers_signed_check", sql`${t.status} <> 'signed' or ${t.signedAt} is not null`),
]);

/**
 * Screens requested by a decision. c60 (ethical screens) owns enforcement;
 * this records the hand-off and its confirmation so the gate can open only
 * when every requested screen is active (c59 §4.3.3).
 */
export const conflictScreens = pgTable("conflict_screens", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  decisionId: uuid("decision_id").notNull().references(() => conflictDecisions.id),
  checkId: uuid("check_id").notNull().references(() => conflictChecks.id),
  screenedUserId: uuid("screened_user_id").notNull().references(() => users.id),
  matterId: uuid("matter_id").references(() => matters.id),
  intakeSessionId: uuid("intake_session_id").references(() => intakeSessions.id),
  reason: text("reason").notNull(),
  /** 'requested' | 'active' | 'lifted'. */
  status: text("status").notNull().default("requested"),
  activatedAt: timestamp("activated_at", { withTimezone: true }),
  activatedByUserId: uuid("activated_by_user_id").references(() => users.id),
  noticeSentAt: timestamp("notice_sent_at", { withTimezone: true }),
  liftedAt: timestamp("lifted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("conflict_screens_tenant_user_idx").on(t.tenantId, t.screenedUserId, t.status),
  index("conflict_screens_tenant_check_idx").on(t.tenantId, t.checkId),
  check("conflict_screens_status_check", sql`${t.status} in ('requested','active','lifted')`),
]);

/**
 * One conflict gate per intake session or matter (c59 §4.5). Every
 * downstream action (engagement agreement, assignment, scheduling, trust
 * deposit, matter opening) checks `state = 'open'` server-side.
 */
export const conflictGates = pgTable("conflict_gates", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  /** 'intake_session' | 'matter'. */
  subjectType: text("subject_type").notNull(),
  subjectId: uuid("subject_id").notNull(),
  /** 'open' | 'closed'. A gate with no row is treated as CLOSED (no check has run). */
  state: text("state").notNull(),
  /** Machine reason when closed: 'pending_review' | 'awaiting_consent' | 'awaiting_screen' | 'declined' | 'no_check'. */
  closedReason: text("closed_reason"),
  checkId: uuid("check_id").references(() => conflictChecks.id),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("conflict_gates_subject_key").on(t.tenantId, t.subjectType, t.subjectId),
  check("conflict_gates_subject_type_check", sql`${t.subjectType} in ('intake_session','matter')`),
  check("conflict_gates_state_check", sql`${t.state} in ('open','closed')`),
  check("conflict_gates_reason_check", sql`${t.state} = 'open' or ${t.closedReason} is not null`),
]);

// ---------------------------------------------------------------------------
// c61 — lateral hires
// ---------------------------------------------------------------------------

export const lateralChecks = pgTable("lateral_checks", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  userId: uuid("user_id").notNull().references(() => users.id),
  /** 'YYYY-MM-DD' in the firm's time zone. */
  startDate: text("start_date").notNull(),
  dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
  /** 'awaiting_list' | 'checking' | 'awaiting_decisions' | 'complete' | 'no_prior_employment'. */
  status: text("status").notNull().default("awaiting_list"),
  formerFirmNames: text("former_firm_names").array().notNull().default(sql`'{}'::text[]`),
  attestedAt: timestamp("attested_at", { withTimezone: true }),
  noPriorEmploymentAttestedByUserId: uuid("no_prior_employment_attested_by_user_id").references(() => users.id),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  /** Set when the hire leaves; the list is still searched (c61 rule 7). */
  hireDepartedAt: timestamp("hire_departed_at", { withTimezone: true }),
  startDateFlaggedAt: timestamp("start_date_flagged_at", { withTimezone: true }),
  submitTaskId: uuid("submit_task_id").references(() => tasks.id),
  createdByUserId: uuid("created_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("lateral_checks_tenant_status_idx").on(t.tenantId, t.status),
  index("lateral_checks_tenant_user_idx").on(t.tenantId, t.userId),
  check(
    "lateral_checks_status_check",
    sql`${t.status} in ('awaiting_list','checking','awaiting_decisions','complete','no_prior_employment')`
  ),
]);

/** Names and general subject only — never facts, strategy or amounts (c61 rule 2). Restricted table. */
export const lateralPriorMatters = pgTable("lateral_prior_matters", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  lateralCheckId: uuid("lateral_check_id").notNull().references(() => lateralChecks.id),
  formerFirmName: text("former_firm_name"),
  clientNames: text("client_names").array().notNull().default(sql`'{}'::text[]`),
  adversePartyNames: text("adverse_party_names").array().notNull().default(sql`'{}'::text[]`),
  /** Normalised copies of both name lists, for matching. */
  normalizedNames: text("normalized_names").array().notNull().default(sql`'{}'::text[]`),
  subjectCategory: text("subject_category").notNull(),
  subjectNote: text("subject_note"),
  /** 'lawyer' | 'staff'. */
  role: text("role").notNull(),
  fromYear: integer("from_year"),
  toYear: integer("to_year"),
  stillOpenKnown: boolean("still_open_known"),
  addedAfterStart: boolean("added_after_start").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("lateral_prior_matters_tenant_check_idx").on(t.tenantId, t.lateralCheckId),
  check("lateral_prior_matters_role_check", sql`${t.role} in ('lawyer','staff')`),
]);

// ---------------------------------------------------------------------------
// c62 — non-engagement letters
// ---------------------------------------------------------------------------

export const nonEngagementLetters = pgTable("non_engagement_letters", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  intakeSessionId: uuid("intake_session_id").references(() => intakeSessions.id),
  matterId: uuid("matter_id").references(() => matters.id),
  prospectPartyId: uuid("prospect_party_id").notNull().references(() => parties.id),
  checkId: uuid("check_id").references(() => conflictChecks.id),
  /** 'conflict' | 'not_eligible' | 'out_of_scope' | 'firm_choice' | 'did_not_hire'. */
  declineType: text("decline_type").notNull(),
  reviewingUserId: uuid("reviewing_user_id").references(() => users.id),
  /** 'awaiting_approval' | 'approved' | 'sent' | 'delivered' | 'bounced' | 'no_channel' | 'cancelled'. */
  status: text("status").notNull().default("awaiting_approval"),
  /** Hash of the gate wording the letter was rendered from (which approved version was used). */
  templateHash: text("template_hash"),
  referralIncluded: boolean("referral_included").notNull().default(false),
  referralName: text("referral_name"),
  /** Rendered letter body (neutral by construction; no conflict / party fields exist). */
  body: text("body"),
  approvedByUserId: uuid("approved_by_user_id").references(() => users.id),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  /** Sent under a firm's "approve the template once" setting (never for conflict declines, c62 rule 4). */
  autoApproved: boolean("auto_approved").notNull().default(false),
  /** 'portal' | 'email' | 'postal'. */
  channel: text("channel"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  bouncedAt: timestamp("bounced_at", { withTimezone: true }),
  documentId: uuid("document_id").references(() => documents.id),
  taskId: uuid("task_id").references(() => tasks.id),
  contactDate: text("contact_date"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("non_engagement_letters_tenant_status_idx").on(t.tenantId, t.status),
  check(
    "non_engagement_letters_decline_type_check",
    sql`${t.declineType} in ('conflict','not_eligible','out_of_scope','firm_choice','did_not_hire')`
  ),
  check(
    "non_engagement_letters_status_check",
    sql`${t.status} in ('awaiting_approval','approved','sent','delivered','bounced','no_channel','cancelled')`
  ),
  check("non_engagement_letters_channel_check", sql`${t.channel} is null or ${t.channel} in ('portal','email','postal')`),
  check(
    "non_engagement_letters_approved_check",
    sql`${t.status} in ('awaiting_approval','cancelled') or ${t.approvedByUserId} is not null or ${t.autoApproved}`
  ),
  check("non_engagement_letters_conflict_individual_check", sql`not (${t.autoApproved} and ${t.declineType} = 'conflict')`),
]);

// ---------------------------------------------------------------------------
// c63 — exports
// ---------------------------------------------------------------------------

export const conflictExports = pgTable("conflict_exports", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  requestedByUserId: uuid("requested_by_user_id").notNull().references(() => users.id),
  filter: jsonb("filter").$type<Record<string, unknown>>().notNull().default({}),
  /** 'csv' | 'json'. (PDF awaits a renderer; see PR known gaps.) */
  format: text("format").notNull(),
  /** 'full' (names; gated) | 'summary' (counts and process only). */
  redactionLevel: text("redaction_level").notNull(),
  /** 'queued' | 'ready' | 'failed' | 'blocked'. */
  status: text("status").notNull().default("queued"),
  /** Generated file. Held in the row until object storage (vendor.object_storage) is approved. */
  content: text("content"),
  rowCount: integer("row_count"),
  error: text("error"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  generatedAt: timestamp("generated_at", { withTimezone: true }),
}, (t) => [
  index("conflict_exports_tenant_user_idx").on(t.tenantId, t.requestedByUserId, t.createdAt),
  check("conflict_exports_format_check", sql`${t.format} in ('csv','json')`),
  check("conflict_exports_redaction_check", sql`${t.redactionLevel} in ('full','summary')`),
  check("conflict_exports_status_check", sql`${t.status} in ('queued','ready','failed','blocked')`),
]);

// ---------------------------------------------------------------------------
// c97 — lawyers' own interests (private)
// ---------------------------------------------------------------------------

export const interestDisclosures = pgTable("interest_disclosures", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  userId: uuid("user_id").notNull().references(() => users.id),
  /** 'business' | 'family' | 'other'. */
  interestType: text("interest_type").notNull(),
  name: text("name").notNull(),
  normalizedName: text("normalized_name").notNull(),
  /** e.g. 'owner', 'director', 'spouse', 'sibling', 'investor'. Never an amount. */
  relationship: text("relationship").notNull(),
  /** Optional identifiers to reduce false matches (business registration, city). */
  identifiers: jsonb("identifiers").$type<Record<string, string>>().notNull().default({}),
  startsOn: text("starts_on"),
  endsOn: text("ends_on"),
  /** False once the lawyer leaves or ends the interest: no longer matched. */
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("interest_disclosures_tenant_user_idx").on(t.tenantId, t.userId),
  index("interest_disclosures_tenant_name_idx").on(t.tenantId, t.normalizedName),
  check("interest_disclosures_type_check", sql`${t.interestType} in ('business','family','other')`),
]);

export const interestDisclosureConfirmations = pgTable("interest_disclosure_confirmations", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  userId: uuid("user_id").notNull().references(() => users.id),
  /** Null until the lawyer first confirms their list. */
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  nextDueAt: timestamp("next_due_at", { withTimezone: true }).notNull(),
  reminderTaskId: uuid("reminder_task_id").references(() => tasks.id),
}, (t) => [
  uniqueIndex("interest_disclosure_confirmations_user_key").on(t.tenantId, t.userId),
]);

// ---------------------------------------------------------------------------
// Worker state — filling the index automatically from matters (c56 §4.1–4.4)
// ---------------------------------------------------------------------------

/**
 * One row per firm: how far the index sync has read `matter_parties`. Other
 * engines add parties to matters through the shared tables; the worker picks
 * up every new link after `matterPartiesCursor` and runs a check for it.
 * `baselineAt` is when the sync first ran for the firm: links older than
 * that are the firm's history (c96 import), not new work.
 */
export const conflictSyncState = pgTable("conflict_sync_state", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  baselineAt: timestamp("baseline_at", { withTimezone: true }).notNull(),
  matterPartiesCursor: timestamp("matter_parties_cursor", { withTimezone: true }).notNull(),
  /** Tie-breaker for links sharing `matterPartiesCursor` (keyset on added_at, id). */
  matterPartiesCursorId: uuid("matter_parties_cursor_id"),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  /** When the daily maintenance task (dedupe scan, retention purge, re-confirmations) was last queued. */
  maintenanceQueuedAt: timestamp("maintenance_queued_at", { withTimezone: true }),
  /** c58 (5): parties created after this were not yet re-checked against open matters. */
  recheckCursor: timestamp("recheck_cursor", { withTimezone: true }),
  recheckCursorId: uuid("recheck_cursor_id"),
  /** c57: parties updated after this may be missing match keys (keyset on updated_at, id). */
  matchKeysCursor: timestamp("match_keys_cursor", { withTimezone: true }),
  matchKeysCursorId: uuid("match_keys_cursor_id"),
}, (t) => [uniqueIndex("conflict_sync_state_tenant_key").on(t.tenantId)]);

// ---------------------------------------------------------------------------
// c57 — match keys and addresses for near-miss search
// ---------------------------------------------------------------------------

/**
 * Phonetic and nickname keys per party name (nameRules.matchKeysForName).
 * The index prefilter uses them so a typo in both the start and the end of a
 * name ("Jon Smyth" / "John Smith") still reaches the matcher. Derived data:
 * rebuilt from `parties` and `party_name_variants` at any time.
 */
export const partyMatchKeys = pgTable("party_match_keys", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  partyId: uuid("party_id").notNull().references(() => parties.id),
  key: text("key").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("party_match_keys_party_key").on(t.tenantId, t.partyId, t.key),
  index("party_match_keys_tenant_key_idx").on(t.tenantId, t.key),
]);

/** Postal addresses known for a party (import, intake). Secondary identifier only (c57). */
export const partyAddresses = pgTable("party_addresses", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  partyId: uuid("party_id").notNull().references(() => parties.id),
  address: text("address").notNull(),
  normalizedAddress: text("normalized_address").notNull(),
  source: text("source").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("party_addresses_party_address_key").on(t.tenantId, t.partyId, t.normalizedAddress),
  check("party_addresses_source_check", sql`${t.source} in ('intake','matter','document','import','manual')`),
]);

// ---------------------------------------------------------------------------
// c58 — automatic triggers
// ---------------------------------------------------------------------------

/**
 * Last seen state of each matter, so the worker can tell when a closed
 * matter is reopened (c58 trigger 3) without another engine calling us.
 */
export const conflictMatterWatch = pgTable("conflict_matter_watch", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  matterId: uuid("matter_id").notNull().references(() => matters.id),
  lastStage: text("last_stage").notNull(),
  lastClosedAt: timestamp("last_closed_at", { withTimezone: true }),
  lastReopenCheckAt: timestamp("last_reopen_check_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("conflict_matter_watch_matter_key").on(t.tenantId, t.matterId)]);

// ---------------------------------------------------------------------------
// c96 — importing the firm's existing client and matter history
// ---------------------------------------------------------------------------

/**
 * One uploaded file (CSV first). Lifecycle: 'validated' (parsed and checked,
 * nothing written to the index yet) → 'committed' (rows imported) or
 * 'discarded'. The firm then confirms the import (settings
 * historyImportConfirmedAt) before checks may come back clear.
 */
export const conflictImportBatches = pgTable("conflict_import_batches", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  filename: text("filename").notNull(),
  /** 'csv' for now; other formats map onto the same rows. */
  format: text("format").notNull().default("csv"),
  status: text("status").notNull().default("validated"),
  /** Column mapping used (source header → field). */
  columnMap: jsonb("column_map").$type<Record<string, string>>().notNull().default({}),
  totalRows: integer("total_rows").notNull().default(0),
  validRows: integer("valid_rows").notNull().default(0),
  errorRows: integer("error_rows").notNull().default(0),
  /** Rows folded into another row of the same file (same person). */
  duplicateRows: integer("duplicate_rows").notNull().default(0),
  partiesCreated: integer("parties_created").notNull().default(0),
  mattersCreated: integer("matters_created").notNull().default(0),
  /** Suggestions queued against people already in the index (never auto-merged). */
  mergeSuggestions: integer("merge_suggestions").notNull().default(0),
  sha256: text("sha256").notNull(),
  uploadedByUserId: uuid("uploaded_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  committedAt: timestamp("committed_at", { withTimezone: true }),
  committedByUserId: uuid("committed_by_user_id").references(() => users.id),
  discardedAt: timestamp("discarded_at", { withTimezone: true }),
}, (t) => [
  index("conflict_import_batches_tenant_idx").on(t.tenantId, t.createdAt),
  check("conflict_import_batches_status_check", sql`${t.status} in ('validated','committed','discarded')`),
  check("conflict_import_batches_format_check", sql`${t.format} in ('csv')`),
]);

/** One source row of an import, with its validation result and what it became. */
export const conflictImportRows = pgTable("conflict_import_rows", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  batchId: uuid("batch_id").notNull().references(() => conflictImportBatches.id),
  /** 1-based line in the file (header = line 1). */
  lineNumber: integer("line_number").notNull(),
  /** The parsed, validated row (ImportRecord in src/engines/conflict-check/historyImport.ts). */
  record: jsonb("record").$type<Record<string, unknown>>().notNull(),
  /** 'valid' | 'error' | 'duplicate' | 'imported' | 'failed'. */
  status: text("status").notNull(),
  errors: text("errors").array().notNull().default(sql`'{}'::text[]`),
  warnings: text("warnings").array().notNull().default(sql`'{}'::text[]`),
  /** Line this row was folded into (status 'duplicate'). */
  duplicateOfLine: integer("duplicate_of_line"),
  partyId: uuid("party_id").references(() => parties.id),
}, (t) => [
  index("conflict_import_rows_batch_idx").on(t.tenantId, t.batchId, t.lineNumber),
  check("conflict_import_rows_status_check", sql`${t.status} in ('valid','error','duplicate','imported','failed')`),
]);

/**
 * A matter or consultation from the firm's old system. Kept apart from
 * `matters` (which drive live workflows) and searched alongside it: an
 * imported involvement counts exactly like a live one in every check.
 */
export const importedMatters = pgTable("imported_matters", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  batchId: uuid("batch_id").notNull().references(() => conflictImportBatches.id),
  /** The old system's matter number or reference (unique per firm when given). */
  externalRef: text("external_ref").notNull(),
  /** 'matter' (engaged) | 'consultation' (prospect who never engaged, incl. declined). */
  kind: text("kind").notNull(),
  title: text("title"),
  practiceArea: text("practice_area"),
  /** 'current' | 'former' | 'prospective'. */
  status: text("status").notNull(),
  openedOn: text("opened_on"),
  closedOn: text("closed_on"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("imported_matters_ref_key").on(t.tenantId, t.externalRef),
  check("imported_matters_kind_check", sql`${t.kind} in ('matter','consultation')`),
  check("imported_matters_status_check", sql`${t.status} in ('current','former','prospective')`),
]);

/** A party's role in an imported matter or consultation. */
export const importedInvolvements = pgTable("imported_involvements", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  importedMatterId: uuid("imported_matter_id").notNull().references(() => importedMatters.id),
  partyId: uuid("party_id").notNull().references(() => parties.id),
  /** An INDEX_ROLES value, e.g. 'client', 'former_client', 'opposing_party', 'prospective_client'. */
  role: text("role").notNull(),
  relationship: text("relationship"),
  isAdverse: boolean("is_adverse"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("imported_involvements_key").on(t.tenantId, t.importedMatterId, t.partyId, t.role),
  index("imported_involvements_party_idx").on(t.tenantId, t.partyId),
]);

// ---------------------------------------------------------------------------
// MIGRATION NOTES for the integration step (hand-add to the generated SQL):
//
// 1. RLS + the standard tenant_isolation policy (same text as migrations/0000)
//    on every table in this file:
//    conflict_role_grants, party_name_variants, party_org_links,
//    inquiry_parties, party_merge_suggestions, party_merges,
//    party_retention_requests, conflict_checks, conflict_decisions,
//    conflict_waivers, conflict_screens, conflict_gates, lateral_checks,
//    lateral_prior_matters, non_engagement_letters, conflict_exports,
//    interest_disclosures, interest_disclosure_confirmations,
//    conflict_sync_state, party_match_keys, party_addresses,
//    conflict_matter_watch, conflict_import_batches, conflict_import_rows,
//    imported_matters, imported_involvements.
// 2. GRANT SELECT, INSERT, UPDATE, DELETE ON all of the above TO app_runtime,
//    EXCEPT:
//    - conflict_decisions is append-only (c59 rule 4):
//        GRANT SELECT, INSERT ON conflict_decisions TO app_runtime;
//        REVOKE UPDATE, DELETE ON conflict_decisions FROM app_runtime;
//    - party_merges, conflict_checks: no DELETE (log must never lose rows, c63 rule 2):
//        GRANT SELECT, INSERT, UPDATE ON party_merges, conflict_checks TO app_runtime;
// 3. Role-based policies (c99) once real user roles exist: lateral_prior_matters
//    and interest_disclosures readable only by the owning user and the
//    conflicts role. Until then the engine enforces it in code
//    (src/engines/conflict-check/access.ts).
// 4. conflict_checks.lateral_check_id / interest_disclosure_id and
//    conflict_decisions.supersedes_decision_id are plain uuids (no FK) to avoid
//    a declaration-order cycle; add FKs by hand if wanted.
// ---------------------------------------------------------------------------
