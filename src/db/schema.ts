// Drizzle schema for board card c19 (docs/architecture/core-data-model-schema-design.md).
// This file is the source of truth Drizzle generates SQL migrations from
// (`npm run db:generate`) — per ADR-0001 §D4, the generated SQL under
// migrations/ is what gets reviewed, not this file's diff. Column-by-column
// rationale lives in the c19 design doc; this file only implements it.
//
// Convention applied to every tenant-scoped table (ADR-0001 §D5, c8 §4.1):
// a NOT NULL `tenantId` referencing firms.id, enforced further by a
// Row-Level Security policy applied in the generated migration (Drizzle's
// schema DSL does not itself express RLS policies, so those are added by
// hand to the generated SQL file — see migrations/0000_init.sql).

import { sql } from "drizzle-orm";
import {
  pgTable,
  pgEnum,
  uuid,
  text,
  boolean,
  integer,
  timestamp,
  jsonb,
  unique,
  index,
  check,
  bigint,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import type { SafeContactPreferences } from "./types";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const userRoleEnum = pgEnum("user_role", [
  "firm_admin",
  "attorney",
  "intake_staff",
  "read_only",
  "integration_service",
]);

export const matterStageEnum = pgEnum("matter_stage", [
  "prospective",
  "consultation_scheduled",
  "consult_completed_manual_follow_up",
  "pending_review",
  "did_not_schedule",
  "did_not_hire_referred_out",
  "declined_conflict",
  "retained",
  "closed",
]);

export const partyRoleEnum = pgEnum("party_role", [
  "caller",
  "opposing_party",
  "co_party",
  // Case-management foundation (2026-09-26): roles a party can hold on an
  // open matter, not just at intake. Appended (never reordered) so the
  // generated migration is a pure `ALTER TYPE ... ADD VALUE`. Family Law
  // (c103) needs children, the other parent, new partners and grandparents
  // indexed as parties; c56 needs opposing counsel and related parties.
  "client",
  "opposing_counsel",
  "child",
  "related_party",
  "witness",
  "expert",
  "guardian_ad_litem",
  "court",
  "other",
]);

export const conflictOutcomeEnum = pgEnum("conflict_outcome", [
  "clear",
  "possible",
  "definite",
]);

export const sensitivityTierEnum = pgEnum("sensitivity_tier", [
  "standard",
  "sensitive",
]);

// ---------------------------------------------------------------------------
// §2 Firms & configuration
// ---------------------------------------------------------------------------

export const firms = pgTable("firms", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  status: text("status").notNull().default("trial"),
  isProduction: boolean("is_production").notNull().default(false),
  dataRegion: text("data_region").notNull().default("us"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("firms_status_check", sql`${table.status} in ('trial','active','suspended','offboarded')`),
]);

export const firmConfigVersions = pgTable("firm_config_versions", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  version: integer("version").notNull(),
  config: jsonb("config").notNull(),
  effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid("created_by").references(() => users.id),
}, (table) => [
  unique("firm_config_versions_tenant_version_key").on(table.tenantId, table.version),
  index("firm_config_versions_tenant_effective_idx").on(table.tenantId, table.effectiveFrom),
]);

// ---------------------------------------------------------------------------
// §3 Users & access control
// ---------------------------------------------------------------------------

export const users = pgTable("users", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  email: text("email").notNull(),
  displayName: text("display_name").notNull(),
  role: userRoleEnum("role").notNull(),
  roleLabel: text("role_label"),
  mfaEnrolled: boolean("mfa_enrolled").notNull().default(false),
  status: text("status").notNull().default("active"),
  restrictedToUnassignedMatters: boolean("restricted_to_unassigned_matters").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("users_tenant_email_key").on(table.tenantId, table.email),
  check("users_status_check", sql`${table.status} in ('active','invited','disabled')`),
]);

// ---------------------------------------------------------------------------
// §4 Matters, parties, and conflict-check data
// ---------------------------------------------------------------------------

// `parties` is THE contact registry for the whole product (case-management
// foundation, 2026-09-26): every person or organisation the firm deals with —
// clients, prospective clients, opposing parties, children, opposing counsel,
// courts — lives here exactly once, so the conflict-check party index (c56)
// searches the same rows every other engine writes. `src/db/tables/
// foundation.ts` re-exports this table as `contacts` for readability; it is
// the same SQL table, not a second one.
//
// Columns below `phone` were added by the foundation and are all nullable or
// defaulted, so the generated migration is purely additive.
export const parties = pgTable("parties", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  fullName: text("full_name").notNull(),
  normalizedName: text("normalized_name").notNull(),
  dateOfBirth: text("date_of_birth"), // stored as date; text here keeps the driver mapping simple pre-c21 hardening
  email: text("email"),
  phone: text("phone"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  /** 'person' | 'organization'. */
  kind: text("kind").notNull().default("person"),
  /** Former/maiden/married names, nicknames, business names (c56, c57). */
  aliases: text("aliases").array().notNull().default(sql`'{}'::text[]`),
  /** Same aliases, normalised the same way as `normalizedName`, for search. */
  normalizedAliases: text("normalized_aliases").array().notNull().default(sql`'{}'::text[]`),
  /** Additional addresses beyond the primary `email`/`phone`. */
  emails: text("emails").array().notNull().default(sql`'{}'::text[]`),
  phones: text("phones").array().notNull().default(sql`'{}'::text[]`),
  /** Parent organisation (subsidiary links, c56). */
  parentPartyId: uuid("parent_party_id").references((): AnyPgColumn => parties.id),
  /**
   * Safe-contact preferences (c51, c42, c103). Shape: `SafeContactPreferences`
   * in src/db/types.ts. Notifications resolve addresses ONLY through
   * those preferences — never by reading `email`/`phone` directly.
   */
  safeContact: jsonb("safe_contact").$type<SafeContactPreferences>().notNull().default({}),
  /** Domestic-violence / safety sensitivity: forces DV-safe delivery rules. */
  dvSensitive: boolean("dv_sensitive").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("parties_tenant_normalized_name_idx").on(table.tenantId, table.normalizedName),
  check("parties_kind_check", sql`${table.kind} in ('person','organization')`),
]);

export const matters = pgTable("matters", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  primaryPartyId: uuid("primary_party_id").notNull().references(() => parties.id),
  practiceArea: text("practice_area"),
  stage: matterStageEnum("stage").notNull().default("prospective"),
  assignedUserId: uuid("assigned_user_id").references(() => users.id),
  retentionYears: integer("retention_years"),
  openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  // Per c19 §4.2: ties audit/matter retention to one computed value rather
  // than two independently-tunable settings. NOT a Postgres GENERATED
  // column — `timestamptz + interval` arithmetic is only STABLE (its result
  // depends on the session timezone), and Postgres requires a strictly
  // IMMUTABLE expression for GENERATED ALWAYS AS. Maintained instead by a
  // BEFORE INSERT/UPDATE trigger (see migrations/0000_*.sql) that recomputes
  // it whenever closed_at or retention_years changes — same "one place this
  // logic lives" guarantee, different mechanism to satisfy Postgres's rule.
  eligibleForDeletionAt: timestamp("eligible_for_deletion_at", { withTimezone: true }),
}, (table) => [
  index("matters_tenant_stage_idx").on(table.tenantId, table.stage),
  index("matters_tenant_deletion_idx").on(table.tenantId, table.eligibleForDeletionAt),
]);

export const matterParties = pgTable("matter_parties", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  matterId: uuid("matter_id").notNull().references(() => matters.id),
  partyId: uuid("party_id").notNull().references(() => parties.id),
  role: partyRoleEnum("role").notNull(),
  // Foundation additions (nullable/defaulted — additive migration only).
  /** Free-text relationship detail, e.g. 'spouse', 'new partner', 'grandparent'. */
  relationship: text("relationship"),
  /** True when this party's interests are adverse to the firm's client. */
  isAdverse: boolean("is_adverse"),
  addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  /** Set when the party stops being involved; the row is kept for conflicts. */
  endedAt: timestamp("ended_at", { withTimezone: true }),
}, (table) => [
  unique("matter_parties_matter_party_role_key").on(table.matterId, table.partyId, table.role),
  index("matter_parties_tenant_party_idx").on(table.tenantId, table.partyId),
]);

export const conflictCheckResults = pgTable("conflict_check_results", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  intakeSessionId: uuid("intake_session_id").notNull().references(() => intakeSessions.id),
  roleSought: text("role_sought").notNull(),
  outcome: conflictOutcomeEnum("outcome").notNull(),
  matchedPartyIds: uuid("matched_party_ids").array().notNull().default(sql`'{}'::uuid[]`),
  matchedSources: jsonb("matched_sources").notNull(),
  firmConfigVersionId: uuid("firm_config_version_id").notNull().references(() => firmConfigVersions.id),
  resolvedByUserId: uuid("resolved_by_user_id").references(() => users.id),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// §5 Intake / workflow tables (ADR-0001 §D6)
// ---------------------------------------------------------------------------

export const intakeSessions = pgTable("intake_sessions", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  matterId: uuid("matter_id").references(() => matters.id),
  currentNode: text("current_node").notNull().default("classify_caller"),
  terminalState: text("terminal_state"),
  language: text("language").notNull().default("en"),
  channel: text("channel"),
  collectedAnswers: jsonb("collected_answers").notNull().default({}),
  firmConfigVersionId: uuid("firm_config_version_id").notNull().references(() => firmConfigVersions.id),
  classifierOutput: jsonb("classifier_output"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, (table) => [
  index("intake_sessions_inflight_idx").on(table.tenantId, table.terminalState),
]);

export const intakeEvents = pgTable("intake_events", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  intakeSessionId: uuid("intake_session_id").notNull().references(() => intakeSessions.id),
  matterId: uuid("matter_id").references(() => matters.id),
  eventType: text("event_type").notNull(),
  ruleName: text("rule_name"),
  actorType: text("actor_type").notNull(),
  actorId: uuid("actor_id"),
  payload: jsonb("payload").notNull(),
  firmConfigVersionId: uuid("firm_config_version_id").references(() => firmConfigVersions.id),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("intake_events_session_idx").on(table.tenantId, table.intakeSessionId, table.occurredAt),
  index("intake_events_matter_idx").on(table.tenantId, table.matterId, table.occurredAt),
  check("intake_events_actor_type_check", sql`${table.actorType} in ('system','user','caller')`),
  // Immutability (c6 §3): the app_runtime role gets INSERT/SELECT only on
  // this table — enforced by GRANT/REVOKE statements added by hand to the
  // generated migration, since Drizzle's schema DSL doesn't express GRANTs.
]);

export const scheduledTasks = pgTable("scheduled_tasks", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  intakeSessionId: uuid("intake_session_id").references(() => intakeSessions.id),
  matterId: uuid("matter_id").references(() => matters.id),
  taskType: text("task_type").notNull(),
  dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  claimedByWorker: text("claimed_by_worker"),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  payload: jsonb("payload").notNull().default({}),
}, (table) => [
  index("scheduled_tasks_due_idx").on(table.dueAt),
]);

export const outbox = pgTable("outbox", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  matterId: uuid("matter_id").references(() => matters.id),
  destination: text("destination").notNull(),
  operation: text("operation").notNull(),
  payload: jsonb("payload").notNull(),
  status: text("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
}, (table) => [
  index("outbox_status_idx").on(table.status, table.createdAt),
  check("outbox_status_check", sql`${table.status} in ('pending','sent','failed','abandoned')`),
]);

// ---------------------------------------------------------------------------
// §6 Documents
// ---------------------------------------------------------------------------

// Metadata only — file bytes live in object storage (scope memo §4 storage
// ADR addendum, still open). Every upload is a NEW row (version + 1 in the
// same `versionGroupId`); rows are never overwritten (c84). Columns below
// `createdAt` were added by the case-management foundation and are all
// nullable or defaulted, so the migration is additive.
export const documents = pgTable("documents", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  matterId: uuid("matter_id").notNull().references(() => matters.id),
  documentType: text("document_type").notNull(),
  storageKey: text("storage_key").notNull(),
  sensitivityTier: sensitivityTierEnum("sensitivity_tier").notNull().default("standard"),
  uploadedByUserId: uuid("uploaded_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  /** Display name, e.g. 'Final Decree of Divorce.pdf'. */
  name: text("name"),
  /** 1-based version within `versionGroupId`. */
  version: integer("version").notNull().default(1),
  /** id of the first version; null on version 1 means "this row is the group". */
  versionGroupId: uuid("version_group_id").references((): AnyPgColumn => documents.id),
  /** Lifecycle status — see DOCUMENT_STATUSES in src/core/documents.ts. */
  status: text("status").notNull().default("draft"),
  /** 'none' | 'privileged' | 'work_product' | 'confidential' | 'sealed' (c88). */
  privilegeTag: text("privilege_tag").notNull().default("none"),
  /** Client-shareable? Defaults to false: nothing reaches a client by default. */
  clientVisible: boolean("client_visible").notNull().default(false),
  /** Set when a client (not staff) uploaded it through the portal. */
  uploadedByPartyId: uuid("uploaded_by_party_id").references(() => parties.id),
  mimeType: text("mime_type"),
  sizeBytes: bigint("size_bytes", { mode: "number" }),
  sha256: text("sha256"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("documents_tenant_matter_idx").on(table.tenantId, table.matterId),
  check(
    "documents_status_check",
    sql`${table.status} in ('draft','uploaded','in_review','attorney_approved','client_review','client_approved','final','filed','superseded','archived')`
  ),
  check(
    "documents_privilege_tag_check",
    sql`${table.privilegeTag} in ('none','privileged','work_product','confidential','sealed')`
  ),
  check("documents_version_check", sql`${table.version} >= 1`),
]);
