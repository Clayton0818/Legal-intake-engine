// Tables owned by the Calendar & deadline engine — matter calendar, deadline
// calculators, limitation dates, task lists and stages (c91–c95).
//
// Shared tables live in ./foundation.ts and ../schema.ts (imported, never
// redefined or edited). The matter calendar itself IS the shared
// `calendar_events` table (foundation.ts): this engine owns its behaviour and
// only adds side tables for what that table does not hold. Conventions
// (identical to ./foundation.ts): NOT NULL tenantId -> firms.id on every
// tenant-scoped table, text + CHECK for statuses, timestamptz for instants.
// Legal calendar DATES (a limitation date, a calculated court date) are
// stored as 'YYYY-MM-DD' text with a CHECK, like parties.date_of_birth, so no
// time-zone conversion can ever move them by a day.
//
// jsonb shapes are declared here (not imported from the engine) because
// drizzle-kit loads schema files on their own. The engine validates them in
// src/engines/calendar-core/**.
//
// Migrations are generated once at integration time; RLS/GRANT needs are in
// MIGRATION NOTES at the bottom of this file.

import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { firms, users, matters, parties } from "../schema";
import { calendarEvents, flags, tasks } from "./foundation";

const ISO_DATE = "^[0-9]{4}-[0-9]{2}-[0-9]{2}$";

// ---------------------------------------------------------------------------
// c91 — matter calendar side tables
// ---------------------------------------------------------------------------

/** People (parties) attached to a calendar event, beyond the assigned firm users. */
export const calendarEventParties = pgTable("calendar_event_parties", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  eventId: uuid("event_id").notNull().references(() => calendarEvents.id),
  partyId: uuid("party_id").notNull().references(() => parties.id),
  /** 'client' | 'witness' | 'opposing_counsel' | 'opposing_party' | 'mediator' | 'judge' | 'expert' | 'other'. */
  role: text("role").notNull().default("other"),
  addedByUserId: uuid("added_by_user_id").references(() => users.id),
  addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("calendar_event_parties_key").on(t.tenantId, t.eventId, t.partyId),
  index("calendar_event_parties_party_idx").on(t.tenantId, t.partyId),
  check(
    "calendar_event_parties_role_check",
    sql`${t.role} in ('client','witness','opposing_counsel','opposing_party','mediator','judge','expert','other')`
  ),
]);

/**
 * A lawyer's connection to an external calendar (Microsoft 365 / Google) for
 * two-way sync. The provider is a subprocessor: nothing is sent or fetched
 * until 'vendor.calendar_sync' is approved (stub adapter records instead).
 */
export const calendarSyncConnections = pgTable("calendar_sync_connections", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  userId: uuid("user_id").notNull().references(() => users.id),
  /** 'microsoft' | 'google'. */
  provider: text("provider").notNull(),
  /** Secret-store reference for the OAuth token — never the token itself. */
  tokenRef: text("token_ref"),
  /** External calendar id inside the account (null = primary). */
  externalCalendarId: text("external_calendar_id"),
  /** 'two_way' | 'push_only' | 'pull_only'. */
  direction: text("direction").notNull().default("two_way"),
  active: boolean("active").notNull().default(true),
  /** Provider delta/sync token for incremental pulls. */
  pullCursor: text("pull_cursor"),
  lastPushedAt: timestamp("last_pushed_at", { withTimezone: true }),
  lastPulledAt: timestamp("last_pulled_at", { withTimezone: true }),
  lastError: text("last_error"),
  createdByUserId: uuid("created_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  disconnectedAt: timestamp("disconnected_at", { withTimezone: true }),
}, (t) => [
  index("calendar_sync_connections_user_idx").on(t.tenantId, t.userId),
  uniqueIndex("calendar_sync_connections_active_key")
    .on(t.tenantId, t.userId, t.provider)
    .where(sql`${t.active}`),
  check("calendar_sync_connections_provider_check", sql`${t.provider} in ('microsoft','google')`),
  check("calendar_sync_connections_direction_check", sql`${t.direction} in ('two_way','push_only','pull_only')`),
]);

/** Per (event, connection) sync state: what must be pushed, and what the provider calls it. */
export const calendarSyncLinks = pgTable("calendar_sync_links", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  eventId: uuid("event_id").notNull().references(() => calendarEvents.id),
  connectionId: uuid("connection_id").notNull().references(() => calendarSyncConnections.id),
  externalId: text("external_id"),
  externalEtag: text("external_etag"),
  /** 'create' | 'update' | 'delete' | 'none' — the change still to push. */
  pendingOp: text("pending_op").notNull().default("create"),
  /** 'pending' | 'synced' | 'held' (vendor gate pending) | 'failed'. */
  status: text("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  /** 'outbound' (ours, pushed) | 'inbound' (created from the external calendar). */
  origin: text("origin").notNull().default("outbound"),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("calendar_sync_links_key").on(t.tenantId, t.eventId, t.connectionId),
  index("calendar_sync_links_status_idx").on(t.tenantId, t.status),
  uniqueIndex("calendar_sync_links_external_key")
    .on(t.tenantId, t.connectionId, t.externalId)
    .where(sql`${t.externalId} is not null`),
  check("calendar_sync_links_op_check", sql`${t.pendingOp} in ('create','update','delete','none')`),
  check("calendar_sync_links_status_check", sql`${t.status} in ('pending','synced','held','failed')`),
  check("calendar_sync_links_origin_check", sql`${t.origin} in ('outbound','inbound')`),
]);

// ---------------------------------------------------------------------------
// c93 — statute-of-limitations tracking
// ---------------------------------------------------------------------------

/**
 * Whether a limitation date applies to a matter at all (a lawyer decides;
 * many family-law matters have none). One row per matter.
 */
export const matterLimitationProfiles = pgTable("matter_limitation_profiles", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  matterId: uuid("matter_id").notNull().references(() => matters.id),
  /** 'unknown' (no lawyer decision yet) | 'applies' | 'not_applicable'. */
  applicability: text("applicability").notNull().default("unknown"),
  decidedByUserId: uuid("decided_by_user_id").references(() => users.id),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  reason: text("reason"),
  /** Set when an intake deadline-risk alert (c66) pointed at this matter. */
  intakeRiskFlagId: uuid("intake_risk_flag_id").references(() => flags.id),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("matter_limitation_profiles_matter_key").on(t.tenantId, t.matterId),
  check("matter_limitation_profiles_applicability_check", sql`${t.applicability} in ('unknown','applies','not_applicable')`),
  check(
    "matter_limitation_profiles_decided_check",
    sql`${t.applicability} = 'unknown' or (${t.decidedByUserId} is not null and ${t.decidedAt} is not null)`
  ),
  check(
    "matter_limitation_profiles_na_reason_check",
    sql`${t.applicability} <> 'not_applicable' or coalesce(length(trim(${t.reason})), 0) > 0`
  ),
]);

/**
 * One limitation date per claim on a matter, ENTERED BY A LAWYER and
 * independently verified by a second person. Never computed by the AI.
 * `version` increments on every lawyer change (each change needs a fresh
 * verification).
 */
export const limitationDates = pgTable("limitation_dates", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  matterId: uuid("matter_id").notNull().references(() => matters.id),
  /** Which claim this date limits, e.g. 'Personal injury — negligence'. */
  claimDescription: text("claim_description").notNull(),
  /** 'YYYY-MM-DD' — the last day, in the firm's time zone. */
  limitationDate: text("limitation_date").notNull(),
  /** Accrual / trigger date the lawyer relied on ('YYYY-MM-DD'), if any. */
  accrualDate: text("accrual_date"),
  /** The lawyer's basis (statute, tolling notes). Internal only. */
  basis: text("basis"),
  /** 'unverified' | 'verified' | 'disputed' | 'satisfied' (claim filed / resolved) | 'withdrawn'. */
  status: text("status").notNull().default("unverified"),
  version: integer("version").notNull().default(1),
  enteredByUserId: uuid("entered_by_user_id").notNull().references(() => users.id),
  enteredAt: timestamp("entered_at", { withTimezone: true }).notNull().defaultNow(),
  lastChangedByUserId: uuid("last_changed_by_user_id").references(() => users.id),
  lastChangedAt: timestamp("last_changed_at", { withTimezone: true }),
  verifiedByUserId: uuid("verified_by_user_id").references(() => users.id),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  closedReason: text("closed_reason"),
  closedByUserId: uuid("closed_by_user_id").references(() => users.id),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  calendarEventId: uuid("calendar_event_id").references(() => calendarEvents.id),
  /** Deadline-critical task (real clock) for filing before the date. */
  filingTaskId: uuid("filing_task_id").references(() => tasks.id),
  /** Business-hours task for the independent verification. */
  verifyTaskId: uuid("verify_task_id").references(() => tasks.id),
  /** Source: 'lawyer_entry' | 'intake_risk' (prompted by c66, still lawyer-entered). */
  source: text("source").notNull().default("lawyer_entry"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("limitation_dates_matter_idx").on(t.tenantId, t.matterId),
  index("limitation_dates_status_date_idx").on(t.tenantId, t.status, t.limitationDate),
  check("limitation_dates_date_check", sql`${t.limitationDate} ~ ${sql.raw(`'${ISO_DATE}'`)}`),
  check("limitation_dates_accrual_check", sql`${t.accrualDate} is null or ${t.accrualDate} ~ ${sql.raw(`'${ISO_DATE}'`)}`),
  check(
    "limitation_dates_status_check",
    sql`${t.status} in ('unverified','verified','disputed','satisfied','withdrawn')`
  ),
  check("limitation_dates_source_check", sql`${t.source} in ('lawyer_entry','intake_risk')`),
  // A verified date names a verifier who is NOT the person who entered or last changed it.
  check(
    "limitation_dates_verified_check",
    sql`${t.status} <> 'verified' or (${t.verifiedByUserId} is not null and ${t.verifiedAt} is not null
      and ${t.verifiedByUserId} <> ${t.enteredByUserId}
      and (${t.lastChangedByUserId} is null or ${t.verifiedByUserId} <> ${t.lastChangedByUserId}))`
  ),
  check(
    "limitation_dates_closed_check",
    sql`${t.status} not in ('satisfied','withdrawn') or (${t.closedByUserId} is not null and coalesce(length(trim(${t.closedReason})), 0) > 0)`
  ),
]);

/** Every lawyer change to a limitation date, with its reason. Append-only. */
export const limitationDateChanges = pgTable("limitation_date_changes", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  limitationId: uuid("limitation_id").notNull().references(() => limitationDates.id),
  fromVersion: integer("from_version").notNull(),
  toVersion: integer("to_version").notNull(),
  fromDate: text("from_date").notNull(),
  toDate: text("to_date").notNull(),
  reason: text("reason").notNull(),
  changedByUserId: uuid("changed_by_user_id").notNull().references(() => users.id),
  changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("limitation_date_changes_limitation_idx").on(t.tenantId, t.limitationId),
  check("limitation_date_changes_reason_check", sql`length(trim(${t.reason})) > 0`),
]);

/**
 * Independent verifications. The verifier enters the date THEY worked out
 * (blind: the API never shows them the lawyer's date first); a match
 * verifies, a mismatch disputes. Append-only.
 */
export const limitationVerifications = pgTable("limitation_verifications", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  limitationId: uuid("limitation_id").notNull().references(() => limitationDates.id),
  version: integer("version").notNull(),
  verifierUserId: uuid("verifier_user_id").notNull().references(() => users.id),
  /** The verifier's own date ('YYYY-MM-DD'). */
  verifierDate: text("verifier_date").notNull(),
  /** 'match' | 'mismatch'. */
  outcome: text("outcome").notNull(),
  /** How the verifier checked (sources, calculation). */
  method: text("method"),
  notes: text("notes"),
  verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("limitation_verifications_limitation_idx").on(t.tenantId, t.limitationId, t.version),
  check("limitation_verifications_outcome_check", sql`${t.outcome} in ('match','mismatch')`),
  check("limitation_verifications_date_check", sql`${t.verifierDate} ~ ${sql.raw(`'${ISO_DATE}'`)}`),
]);

/** Escalating reminders already sent per limitation version and threshold (idempotency). */
export const limitationReminders = pgTable("limitation_reminders", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  limitationId: uuid("limitation_id").notNull().references(() => limitationDates.id),
  version: integer("version").notNull(),
  thresholdDays: integer("threshold_days").notNull(),
  /** False when skipped because a more urgent threshold was already due at the same time. */
  sent: boolean("sent").notNull().default(true),
  flagId: uuid("flag_id").references(() => flags.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("limitation_reminders_key").on(t.tenantId, t.limitationId, t.version, t.thresholdDays),
]);

// ---------------------------------------------------------------------------
// c92 — court-rule deadline calculators
// ---------------------------------------------------------------------------

export type CourtWeekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
export type DeadlineUnit = "calendar_days" | "court_days" | "weeks" | "months" | "years";

/** One step of a deadline rule (validated by src/engines/calendar-core/deadlines/ruleSets.ts). */
export type DeadlineRuleStep =
  | { op: "add"; amount: number; unit: DeadlineUnit }
  | { op: "subtract"; amount: number; unit: DeadlineUnit }
  /** Move to the next given weekday strictly after the current date. */
  | { op: "next_weekday"; weekday: CourtWeekday }
  /** If the current date is not a court day, move forward (or backward) to one. */
  | { op: "roll"; direction: "forward" | "backward" }
  /** Add extra calendar days depending on the service method of the trigger. */
  | { op: "add_for_service_method"; days: Record<string, number> };

export interface DeadlineRuleDef {
  key: string;
  label: string;
  /** Trigger key this rule hangs off. */
  trigger: string;
  /** calendar_events.event_type of the proposed event, e.g. 'response_deadline'. */
  eventType: string;
  steps: DeadlineRuleStep[];
  /** Local time the deadline falls due ('HH:MM'); null = all-day (end of the day). */
  dueTime: string | null;
  /** Where the rule comes from (citation), shown to the confirming lawyer. */
  citation: string;
  notes?: string | null;
}

export interface DeadlineRuleSetConfig {
  /** IANA zone of the court. */
  timeZone: string;
  triggers: Array<{ key: string; label: string; serviceMethods?: string[] }>;
  /** Weekdays the court is closed (usually Saturday and Sunday). */
  nonCourtWeekdays: CourtWeekday[];
  /** Court holidays specific to this rule set ('YYYY-MM-DD'); the firm's court-holiday list is added. */
  courtHolidays: string[];
  /** Late-service rule, e.g. e-service after 17:00 local is treated as served the next day. */
  lateServiceCutoff: { localTime: string; methods: string[]; shiftDays: number } | null;
  rules: DeadlineRuleDef[];
}

/**
 * Versioned court-rule sets. Values are LEGAL RULES: a version is usable only
 * after a lawyer of the firm approves it AND the product-level gate
 * 'rules.court_deadlines' is approved. An approved version is never edited —
 * changes create a new version.
 */
export const deadlineRuleSets = pgTable("deadline_rule_sets", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  /** Stable key across versions, e.g. 'tx-civil-district'. */
  key: text("key").notNull(),
  version: integer("version").notNull(),
  name: text("name").notNull(),
  jurisdiction: text("jurisdiction").notNull(),
  court: text("court"),
  /** 'firm_config' (entered by the firm) | 'licensed_provider' | 'example' (shipped draft, unverified). */
  origin: text("origin").notNull().default("firm_config"),
  /** 'draft' | 'approved' | 'retired'. */
  status: text("status").notNull().default("draft"),
  config: jsonb("config").$type<DeadlineRuleSetConfig>().notNull(),
  createdByUserId: uuid("created_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  approvedByUserId: uuid("approved_by_user_id").references(() => users.id),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  approvalNote: text("approval_note"),
  retiredAt: timestamp("retired_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("deadline_rule_sets_version_key").on(t.tenantId, t.key, t.version),
  uniqueIndex("deadline_rule_sets_one_approved")
    .on(t.tenantId, t.key)
    .where(sql`${t.status} = 'approved'`),
  check("deadline_rule_sets_status_check", sql`${t.status} in ('draft','approved','retired')`),
  check("deadline_rule_sets_origin_check", sql`${t.origin} in ('firm_config','licensed_provider','example')`),
  check(
    "deadline_rule_sets_approved_check",
    sql`${t.status} <> 'approved' or (${t.approvedByUserId} is not null and ${t.approvedAt} is not null)`
  ),
]);

/** One calculated result inside a calculation run. */
export interface DeadlineCalcResult {
  ruleKey: string;
  label: string;
  date: string;
  dueAt: string;
  allDay: boolean;
  explanation: string[];
  warnings: string[];
  calendarEventId: string | null;
}

/** Every calculation run (inputs, rule-set version, results). Append-only. */
export const deadlineCalculations = pgTable("deadline_calculations", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  matterId: uuid("matter_id").notNull().references(() => matters.id),
  ruleSetId: uuid("rule_set_id").notNull().references(() => deadlineRuleSets.id),
  ruleSetVersion: integer("rule_set_version").notNull(),
  triggerKey: text("trigger_key").notNull(),
  triggerAt: timestamp("trigger_at", { withTimezone: true }).notNull(),
  serviceMethod: text("service_method"),
  results: jsonb("results").$type<DeadlineCalcResult[]>().notNull(),
  calculatedByUserId: uuid("calculated_by_user_id").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("deadline_calculations_matter_idx").on(t.tenantId, t.matterId, t.createdAt),
]);

// ---------------------------------------------------------------------------
// c94 / c95 — task lists and matter stages per practice area
// ---------------------------------------------------------------------------

/** Who a templated task goes to. */
export type TemplateOwner = "responsible_lawyer" | "firm" | "client" | { userId: string };

export interface TaskTemplateItem {
  key: string;
  title: string;
  description?: string | null;
  owner: TemplateOwner;
  /** Due this many hours after the task is released, on the given clock. */
  dueHours: number;
  clock: "business" | "real";
  /** Keys of items that must be completed first (the task is created when they are). */
  dependsOn: string[];
  /** Court date / filing deadline work: real clock, no grace, critical. */
  deadlineCritical?: boolean;
}

/**
 * Firm-built checklists (c94), keyed by practice area. 'draft' templates are
 * never run; a firm admin or lawyer activates them. `systemDraft` marks the
 * product's shipped DRAFT defaults until the firm edits/adopts them.
 */
export const taskListTemplates = pgTable("task_list_templates", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  key: text("key").notNull(),
  version: integer("version").notNull().default(1),
  practiceArea: text("practice_area").notNull(),
  name: text("name").notNull(),
  /** Stage key that runs this list automatically (null = manual only). */
  triggerStageKey: text("trigger_stage_key"),
  items: jsonb("items").$type<TaskTemplateItem[]>().notNull(),
  /** 'draft' | 'active' | 'retired'. */
  status: text("status").notNull().default("draft"),
  systemDraft: boolean("system_draft").notNull().default(false),
  createdByUserId: uuid("created_by_user_id").references(() => users.id),
  activatedByUserId: uuid("activated_by_user_id").references(() => users.id),
  activatedAt: timestamp("activated_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("task_list_templates_version_key").on(t.tenantId, t.key, t.version),
  uniqueIndex("task_list_templates_one_active").on(t.tenantId, t.key).where(sql`${t.status} = 'active'`),
  index("task_list_templates_area_idx").on(t.tenantId, t.practiceArea, t.status),
  check("task_list_templates_status_check", sql`${t.status} in ('draft','active','retired')`),
  check(
    "task_list_templates_active_check",
    sql`${t.status} <> 'active' or (${t.activatedByUserId} is not null and ${t.activatedAt} is not null)`
  ),
]);

/** One run of a task list on a matter. */
export const taskListRuns = pgTable("task_list_runs", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  matterId: uuid("matter_id").notNull().references(() => matters.id),
  templateId: uuid("template_id").notNull().references(() => taskListTemplates.id),
  templateKey: text("template_key").notNull(),
  templateVersion: integer("template_version").notNull(),
  /** The stage transition that triggered the run (null = started by hand). */
  stageTransitionId: uuid("stage_transition_id"),
  /** 'running' | 'completed' | 'cancelled'. */
  status: text("status").notNull().default("running"),
  startedByUserId: uuid("started_by_user_id").references(() => users.id),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
}, (t) => [
  index("task_list_runs_matter_idx").on(t.tenantId, t.matterId),
  index("task_list_runs_status_idx").on(t.tenantId, t.status),
  // A stage transition runs a template once.
  uniqueIndex("task_list_runs_transition_key")
    .on(t.tenantId, t.stageTransitionId, t.templateId)
    .where(sql`${t.stageTransitionId} is not null`),
  check("task_list_runs_status_check", sql`${t.status} in ('running','completed','cancelled')`),
]);

/** Each item of a run: waiting on dependencies, or released as a real task. */
export const taskListRunItems = pgTable("task_list_run_items", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  runId: uuid("run_id").notNull().references(() => taskListRuns.id),
  itemKey: text("item_key").notNull(),
  dependsOn: text("depends_on").array().notNull().default(sql`'{}'::text[]`),
  /** 'waiting' | 'released' | 'skipped'. */
  status: text("status").notNull().default("waiting"),
  taskId: uuid("task_id").references(() => tasks.id),
  releasedAt: timestamp("released_at", { withTimezone: true }),
  skipReason: text("skip_reason"),
}, (t) => [
  uniqueIndex("task_list_run_items_key").on(t.tenantId, t.runId, t.itemKey),
  index("task_list_run_items_status_idx").on(t.tenantId, t.status),
  check("task_list_run_items_status_check", sql`${t.status} in ('waiting','released','skipped')`),
  check("task_list_run_items_released_check", sql`${t.status} <> 'released' or ${t.taskId} is not null`),
]);

export interface StageDef {
  key: string;
  label: string;
  order: number;
  /** Exactly one stage per definition is the closing stage. */
  closing: boolean;
  /** Expected time in this stage (business hours) — read by the c47 stall scan. */
  expectedBusinessHours: number | null;
  onEnter: {
    /** Task-list template keys to run when a matter enters this stage. */
    taskLists: string[];
    /** Create a task for the lawyer to send a client update (c54) — the engine never writes to the client itself. */
    clientUpdateTask: boolean;
    /** Billing event name recorded for the billing engine (c79), e.g. 'phase_complete'. */
    billingEvent: string | null;
  };
}

/** Matter-lifecycle stages per practice area (c95). One active definition per practice area. */
export const matterStageDefinitions = pgTable("matter_stage_definitions", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  practiceArea: text("practice_area").notNull(),
  version: integer("version").notNull().default(1),
  name: text("name").notNull(),
  stages: jsonb("stages").$type<StageDef[]>().notNull(),
  /** 'draft' | 'active' | 'retired'. */
  status: text("status").notNull().default("draft"),
  systemDraft: boolean("system_draft").notNull().default(false),
  createdByUserId: uuid("created_by_user_id").references(() => users.id),
  activatedByUserId: uuid("activated_by_user_id").references(() => users.id),
  activatedAt: timestamp("activated_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("matter_stage_definitions_version_key").on(t.tenantId, t.practiceArea, t.version),
  uniqueIndex("matter_stage_definitions_one_active").on(t.tenantId, t.practiceArea).where(sql`${t.status} = 'active'`),
  check("matter_stage_definitions_status_check", sql`${t.status} in ('draft','active','retired')`),
  check(
    "matter_stage_definitions_active_check",
    sql`${t.status} <> 'active' or (${t.activatedByUserId} is not null and ${t.activatedAt} is not null)`
  ),
]);

/** Where each matter is in its practice-area lifecycle (1:1 side table to `matters`). */
export const matterLifecycle = pgTable("matter_lifecycle", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  matterId: uuid("matter_id").notNull().references(() => matters.id),
  practiceArea: text("practice_area").notNull(),
  definitionId: uuid("definition_id").notNull().references(() => matterStageDefinitions.id),
  stageKey: text("stage_key").notNull(),
  enteredStageAt: timestamp("entered_stage_at", { withTimezone: true }).notNull().defaultNow(),
  /** 'open' | 'closing' | 'closed'. */
  status: text("status").notNull().default("open"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("matter_lifecycle_matter_key").on(t.tenantId, t.matterId),
  index("matter_lifecycle_stage_idx").on(t.tenantId, t.practiceArea, t.stageKey),
  check("matter_lifecycle_status_check", sql`${t.status} in ('open','closing','closed')`),
]);

/** Every stage change, with who and why. Append-only. */
export const matterStageTransitions = pgTable("matter_stage_transitions", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  matterId: uuid("matter_id").notNull().references(() => matters.id),
  definitionId: uuid("definition_id").notNull().references(() => matterStageDefinitions.id),
  fromStageKey: text("from_stage_key"),
  toStageKey: text("to_stage_key").notNull(),
  reason: text("reason"),
  /** Billing event recorded for the billing engine (c79) — a record, never a charge. */
  billingEvent: text("billing_event"),
  byUserId: uuid("by_user_id").references(() => users.id),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("matter_stage_transitions_matter_idx").on(t.tenantId, t.matterId, t.at),
  index("matter_stage_transitions_billing_idx").on(t.tenantId, t.billingEvent).where(sql`${t.billingEvent} is not null`),
]);

/**
 * Closing a matter (c95): the closing checklist (Document engine, c90) and
 * trust at zero (Billing & trust engine, c82) must both be confirmed.
 */
export const matterClosings = pgTable("matter_closings", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  matterId: uuid("matter_id").notNull().references(() => matters.id),
  /** 'in_progress' | 'closed' | 'abandoned'. */
  status: text("status").notNull().default("in_progress"),
  startedByUserId: uuid("started_by_user_id").notNull().references(() => users.id),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  /** Task the Document engine's closing checklist (c90) completes. */
  checklistTaskId: uuid("checklist_task_id").references(() => tasks.id),
  /** Trust at zero: confirmed by a lawyer against the trust ledger (until a shared balance read exists). */
  trustZeroConfirmedByUserId: uuid("trust_zero_confirmed_by_user_id").references(() => users.id),
  trustZeroConfirmedAt: timestamp("trust_zero_confirmed_at", { withTimezone: true }),
  trustZeroSource: text("trust_zero_source"),
  closedByUserId: uuid("closed_by_user_id").references(() => users.id),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  abandonReason: text("abandon_reason"),
}, (t) => [
  index("matter_closings_matter_idx").on(t.tenantId, t.matterId),
  uniqueIndex("matter_closings_one_open").on(t.tenantId, t.matterId).where(sql`${t.status} = 'in_progress'`),
  check("matter_closings_status_check", sql`${t.status} in ('in_progress','closed','abandoned')`),
  check(
    "matter_closings_trust_source_check",
    sql`${t.trustZeroSource} is null or ${t.trustZeroSource} in ('lawyer_attestation','billing_engine')`
  ),
  check(
    "matter_closings_closed_check",
    sql`${t.status} <> 'closed' or (${t.closedByUserId} is not null and ${t.closedAt} is not null and ${t.trustZeroConfirmedAt} is not null)`
  ),
]);

// ---------------------------------------------------------------------------
// MIGRATION NOTES for the integration step (hand-add to the generated SQL):
//
// 1. RLS + the standard tenant_isolation policy (same text as migrations/0000)
//    on every table in this file:
//    calendar_event_parties, calendar_sync_connections, calendar_sync_links,
//    matter_limitation_profiles, limitation_dates, limitation_date_changes,
//    limitation_verifications, limitation_reminders, deadline_rule_sets,
//    deadline_calculations, task_list_templates, task_list_runs,
//    task_list_run_items, matter_stage_definitions, matter_lifecycle,
//    matter_stage_transitions, matter_closings.
// 2. Staging grants app_runtime SELECT/INSERT/UPDATE/DELETE on every new
//    table by default. Restrict these explicitly:
//    - Append-only audit records (c93 "logged reason", c92 calculation trail,
//      c95 stage history):
//        REVOKE UPDATE, DELETE ON limitation_date_changes, limitation_verifications,
//          deadline_calculations, matter_stage_transitions FROM app_runtime;
//    - Records that must never be deleted (status changes only):
//        REVOKE DELETE ON limitation_dates, matter_limitation_profiles,
//          limitation_reminders, deadline_rule_sets, task_list_templates,
//          matter_stage_definitions, matter_closings, task_list_runs,
//          task_list_run_items, matter_lifecycle FROM app_runtime;
//    - calendar_event_parties, calendar_sync_connections and
//      calendar_sync_links keep full CRUD (detaching a person / a sync link
//      is a normal edit; the event itself lives in calendar_events).
// 3. Recommended hardening (optional, by hand): a BEFORE UPDATE trigger on
//    deadline_rule_sets that refuses changes to `config` once status =
//    'approved' (the engine already refuses; this makes it structural).
// 4. task_list_runs.stage_transition_id is a plain uuid (no FK) to keep the
//    declaration order simple; add the FK to matter_stage_transitions(id) by
//    hand if wanted.
// 5. The CHECKs that use '~' compare against a literal ISO-date regex; keep
//    them as generated.
// ---------------------------------------------------------------------------
