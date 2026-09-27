// Shared case-management tables (case-management foundation, 2026-09-26).
//
// Every engine (src/engines/<slug>/) may import from this file and from
// src/db/schema.ts; neither file may be edited by an engine. Engine-specific
// tables go in src/db/tables/<slug>.ts.
//
// Engines: see src/engines/README.md for the full layout/import contract.
//
// Conventions, identical to src/db/schema.ts:
//  - every tenant-scoped table has a NOT NULL `tenantId` -> firms.id and gets
//    the standard `tenant_isolation` RLS policy in the generated migration
//    (hand-added, since Drizzle's DSL does not express RLS — see
//    migrations/0000_*.sql for the exact policy text);
//  - status-like columns are text + CHECK constraints (easy to read in SQL);
//  - timestamps are timestamptz.
//
// Migrations are NOT generated here. The integration step runs
// `npm run db:generate` once, after every engine's tables exist, and then
// hand-adds RLS policies and GRANTs. MIGRATION NOTES for that step are at the
// bottom of this file.
//
// Existing tables are reused, not duplicated: firms, users, matters,
// intake_sessions, intake_events, conflict_check_results, scheduled_tasks and
// outbox stay in schema.ts; `parties`, `matter_parties` and `documents` were
// extended in place there (additive columns only).

import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  bigint,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { firms, users, matters, parties, intakeSessions } from "../schema";
import type {
  WeeklyHours,
  FirmHoliday,
  QuietHours,
  EngineSettings,
} from "../types";

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

/**
 * The contact registry. This is the SAME SQL table as `parties` in
 * schema.ts (extended there with aliases, emails, phones, safe-contact
 * preferences and DV sensitivity) — one registry for every engine, so the
 * conflict-check party index (c56) sees every person any engine records.
 */
export const contacts = parties;

// ---------------------------------------------------------------------------
// Firm settings (one row per firm)
// ---------------------------------------------------------------------------

export const DEFAULT_WEEKLY_HOURS: WeeklyHours = {
  mon: [{ start: "09:00", end: "17:00" }],
  tue: [{ start: "09:00", end: "17:00" }],
  wed: [{ start: "09:00", end: "17:00" }],
  thu: [{ start: "09:00", end: "17:00" }],
  fri: [{ start: "09:00", end: "17:00" }],
};

export const firmSettings = pgTable("firm_settings", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),

  // --- Business calendar (founder decision: firm timers count BUSINESS hours) ---
  /** IANA time zone, e.g. 'America/Chicago' (Texas pilot default). */
  timeZone: text("time_zone").notNull().default("America/Chicago"),
  businessHours: jsonb("business_hours").$type<WeeklyHours>().notNull().default(DEFAULT_WEEKLY_HOURS),
  holidays: jsonb("holidays").$type<FirmHoliday[]>().notNull().default([]),

  // --- Practice areas (c102). Family Law is the pilot default (c103). ---
  enabledPracticeAreas: text("enabled_practice_areas").array().notNull().default(sql`'{family}'::text[]`),

  // --- Response timers (hours; business hours unless noted) ---
  /** c43: internal target for the firm to reply to a client message. */
  firmReplyHours: integer("firm_reply_hours").notNull().default(24),
  /** c43: the reply time promised to the client. */
  clientPromiseHours: integer("client_promise_hours").notNull().default(48),
  /** c44: internal flag for deadline-related client questions. */
  deadlineQuestionFlagHours: integer("deadline_question_flag_hours").notNull().default(12),
  /** c44: reply promised to the client for deadline-related questions. */
  deadlineQuestionReplyHours: integer("deadline_question_reply_hours").notNull().default(24),
  /** c42: default response window for firm -> client correspondence. */
  clientResponseWindowHours: integer("client_response_window_hours").notNull().default(48),
  /** c45: "due soon" warning before a task's due time (default one business day). */
  dueSoonBusinessHours: integer("due_soon_business_hours").notNull().default(8),
  /** c45: grace before an overdue task escalates to supervisor + admin. */
  overdueGraceBusinessHours: integer("overdue_grace_business_hours").notNull().default(8),
  /** c64: court-notice acknowledgement window, REAL-clock minutes. */
  courtNoticeAckMinutes: integer("court_notice_ack_minutes").notNull().default(120),
  /** c69: speed-to-lead target, business minutes. */
  newInquiryResponseMinutes: integer("new_inquiry_response_minutes").notNull().default(15),

  // --- Money (founder decision: $4,500 retainer floor) ---
  retainerFloorCents: bigint("retainer_floor_cents", { mode: "number" }).notNull().default(450000),
  /** Optional early warning above the floor (c50), e.g. 600000 = $6,000. */
  retainerWarningCents: bigint("retainer_warning_cents", { mode: "number" }),

  // --- Notifications (c51) ---
  /** Quiet hours for non-urgent client messages. Null = none. */
  quietHours: jsonb("quiet_hours").$type<QuietHours | null>(),
  /** Group non-urgent internal flag emails into a daily digest. */
  internalEmailDigest: boolean("internal_email_digest").notNull().default(false),
  /** Sender identity: emails come from the firm's own name/domain. */
  emailFromName: text("email_from_name"),
  emailFromAddress: text("email_from_address"),
  emailReplyTo: text("email_reply_to"),
  /** Base URL of the client portal, used in minimal client emails. */
  clientPortalUrl: text("client_portal_url"),

  // --- Extension point: per-engine settings (keyed by engine slug) ---
  engineSettings: jsonb("engine_settings").$type<EngineSettings>().notNull().default({}),

  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedByUserId: uuid("updated_by_user_id").references(() => users.id),
}, (table) => [
  uniqueIndex("firm_settings_tenant_key").on(table.tenantId),
  check("firm_settings_retainer_floor_check", sql`${table.retainerFloorCents} >= 0`),
  check(
    "firm_settings_hours_positive_check",
    sql`${table.firmReplyHours} > 0 and ${table.clientPromiseHours} > 0 and ${table.deadlineQuestionFlagHours} > 0 and ${table.deadlineQuestionReplyHours} > 0`
  ),
]);

// ---------------------------------------------------------------------------
// Calendar events (c91 is the owning engine; shared because every alert
// engine reads it)
// ---------------------------------------------------------------------------

export const calendarEvents = pgTable("calendar_events", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  /** Null only for firm-wide events (e.g. office closures). */
  matterId: uuid("matter_id").references(() => matters.id),
  /** 'hearing' | 'trial' | 'deposition' | 'mediation' | 'filing_deadline' | 'response_deadline' |
   *  'limitation_date' | 'consultation' | 'client_meeting' | 'internal' | 'other' (free text; engines may add). */
  eventType: text("event_type").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true }),
  allDay: boolean("all_day").notNull().default(false),
  location: text("location"),
  courtName: text("court_name"),
  causeNumber: text("cause_number"),
  /** True for deadlines (filing, response, limitation). Deadlines use the REAL clock. */
  isDeadline: boolean("is_deadline").notNull().default(false),
  /** Where the date came from. AI suggestions are never 'confirmed' without a lawyer. */
  source: text("source").notNull().default("lawyer_entry"),
  sourceRef: text("source_ref"),
  /** 'proposed' until a lawyer confirms it (the AI never decides a deadline). */
  status: text("status").notNull().default("proposed"),
  confirmedByUserId: uuid("confirmed_by_user_id").references(() => users.id),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  createdByUserId: uuid("created_by_user_id").references(() => users.id),
  /** Users attending / responsible. */
  assignedUserIds: uuid("assigned_user_ids").array().notNull().default(sql`'{}'::uuid[]`),
  /** External calendar ids keyed by provider (sync is vendor-gated: 'vendor.calendar_sync'). */
  externalRefs: jsonb("external_refs").$type<Record<string, string>>().notNull().default({}),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  cancelReason: text("cancel_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("calendar_events_tenant_starts_idx").on(table.tenantId, table.startsAt),
  index("calendar_events_tenant_matter_idx").on(table.tenantId, table.matterId, table.startsAt),
  check(
    "calendar_events_source_check",
    sql`${table.source} in ('lawyer_entry','staff_entry','ai_suggestion','court_notice','deadline_calculator','consult_booking','external_sync','import')`
  ),
  check("calendar_events_status_check", sql`${table.status} in ('proposed','confirmed','cancelled')`),
  // A confirmed event always names the person who confirmed it.
  check(
    "calendar_events_confirmed_by_check",
    sql`${table.status} <> 'confirmed' or (${table.confirmedByUserId} is not null and ${table.confirmedAt} is not null)`
  ),
]);

// ---------------------------------------------------------------------------
// Tasks (one mechanism for every due item: c40–c46, c49, c52, c54, c69 …)
// ---------------------------------------------------------------------------

export const tasks = pgTable("tasks", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  matterId: uuid("matter_id").references(() => matters.id),
  intakeSessionId: uuid("intake_session_id").references(() => intakeSessions.id),
  /** Machine key of the task kind, namespaced by engine: e.g. 'calendar.firm_reply_due'. */
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  /** 'user' (a lawyer/staff member), 'client' (a party), or 'firm' (unassigned firm work). */
  ownerType: text("owner_type").notNull(),
  ownerUserId: uuid("owner_user_id").references(() => users.id),
  ownerPartyId: uuid("owner_party_id").references(() => parties.id),
  /** Supervising lawyer to escalate to (c45). */
  supervisorUserId: uuid("supervisor_user_id").references(() => users.id),
  dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
  /** True: overdue/grace measured in firm business hours. False: real clock. */
  usesBusinessHours: boolean("uses_business_hours").notNull().default(true),
  /** Tied to a court date, filing deadline or limitation date: flagged immediately,
   *  highest severity, REAL clock, no grace (c45, c44 safety net). */
  deadlineCritical: boolean("deadline_critical").notNull().default(false),
  /** 'open' | 'done' | 'cancelled'. */
  status: text("status").notNull().default("open"),
  /** 'internal' (firm only — c45) or 'client' (shown to the owning client — c46). */
  visibility: text("visibility").notNull().default("internal"),
  /** Board card that created it, e.g. 'c43'. */
  sourceCard: text("source_card"),
  /** Pointer to the engine record behind the task (e.g. 'message:<uuid>'). */
  sourceRef: text("source_ref"),
  relatedCalendarEventId: uuid("related_calendar_event_id").references(() => calendarEvents.id),
  /** Engine-specific extra data. Internal only — never sent to clients. */
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  completedByUserId: uuid("completed_by_user_id").references(() => users.id),
  completedByPartyId: uuid("completed_by_party_id").references(() => parties.id),
  /** Why the task was completed/cancelled/reassigned/re-dated — no silent clearing (c45). */
  lastChangeReason: text("last_change_reason"),
  createdByUserId: uuid("created_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("tasks_tenant_status_due_idx").on(table.tenantId, table.status, table.dueAt),
  index("tasks_tenant_matter_idx").on(table.tenantId, table.matterId),
  index("tasks_tenant_owner_user_idx").on(table.tenantId, table.ownerUserId, table.status),
  index("tasks_tenant_owner_party_idx").on(table.tenantId, table.ownerPartyId, table.status),
  check("tasks_owner_type_check", sql`${table.ownerType} in ('user','client','firm')`),
  check(
    "tasks_owner_consistency_check",
    sql`(${table.ownerType} = 'user' and ${table.ownerUserId} is not null and ${table.ownerPartyId} is null)
      or (${table.ownerType} = 'client' and ${table.ownerPartyId} is not null and ${table.ownerUserId} is null)
      or (${table.ownerType} = 'firm' and ${table.ownerUserId} is null and ${table.ownerPartyId} is null)`
  ),
  check("tasks_status_check", sql`${table.status} in ('open','done','cancelled')`),
  check("tasks_visibility_check", sql`${table.visibility} in ('internal','client')`),
  // Only a client's own tasks can be client-visible.
  check("tasks_client_visibility_check", sql`${table.visibility} = 'internal' or ${table.ownerType} = 'client'`),
]);

// ---------------------------------------------------------------------------
// Flags (every alert on the board; audience decides who may ever see it)
// ---------------------------------------------------------------------------

export const flags = pgTable("flags", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  /** Namespaced type, e.g. 'task.overdue', 'calendar.client_non_response', 'billing.retainer_below_floor'. */
  type: text("type").notNull(),
  /** 'info' | 'warning' | 'high' | 'critical'. */
  severity: text("severity").notNull(),
  /** 'internal' (firm users only — founder rule for overdue flags), 'client', or 'both'. */
  audience: text("audience").notNull(),
  matterId: uuid("matter_id").references(() => matters.id),
  taskId: uuid("task_id").references(() => tasks.id),
  /** Internal headline. Never shown to a client. */
  title: text("title").notNull(),
  /** Internal detail text. Never shown to a client. */
  summary: text("summary"),
  /** Internal structured detail (why it fired, durations …). Never shown to a client. */
  details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
  /** legalCopy() gate key rendered on the client side for client/both flags. */
  clientCopyKey: text("client_copy_key"),
  /** Firm users this flag is for (in-app + email). */
  recipientUserIds: uuid("recipient_user_ids").array().notNull().default(sql`'{}'::uuid[]`),
  /** Client parties this flag is for (only allowed when audience is client/both). */
  recipientPartyIds: uuid("recipient_party_ids").array().notNull().default(sql`'{}'::uuid[]`),
  /** One open flag per dedupe key (e.g. 'task.overdue:<taskId>'). */
  dedupeKey: text("dedupe_key"),
  urgent: boolean("urgent").notNull().default(false),
  /** Sensitive flags are not emailed to parties who opted out of sensitive email (DV-safe, c51). */
  sensitive: boolean("sensitive").notNull().default(false),
  escalationLevel: integer("escalation_level").notNull().default(0),
  lastEscalatedAt: timestamp("last_escalated_at", { withTimezone: true }),
  acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
  acknowledgedByUserId: uuid("acknowledged_by_user_id").references(() => users.id),
  raisedByType: text("raised_by_type").notNull().default("system"),
  raisedByUserId: uuid("raised_by_user_id").references(() => users.id),
  sourceCard: text("source_card"),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  resolvedByUserId: uuid("resolved_by_user_id").references(() => users.id),
  resolutionReason: text("resolution_reason"),
  /** c47: "waiting on the court until Oct 10" — a check-back date recorded with the reason. */
  checkBackAt: timestamp("check_back_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("flags_tenant_open_idx").on(table.tenantId, table.resolvedAt, table.severity),
  index("flags_tenant_matter_idx").on(table.tenantId, table.matterId),
  index("flags_tenant_task_idx").on(table.tenantId, table.taskId),
  uniqueIndex("flags_open_dedupe_key")
    .on(table.tenantId, table.dedupeKey)
    .where(sql`${table.resolvedAt} is null and ${table.dedupeKey} is not null`),
  check("flags_severity_check", sql`${table.severity} in ('info','warning','high','critical')`),
  check("flags_audience_check", sql`${table.audience} in ('internal','client','both')`),
  // Internal flags can never be addressed to a client (founder rule, c45).
  check(
    "flags_internal_no_party_recipients_check",
    sql`${table.audience} <> 'internal' or cardinality(${table.recipientPartyIds}) = 0`
  ),
  // No silent clearing: a resolved flag always carries a reason.
  check(
    "flags_resolution_reason_check",
    sql`${table.resolvedAt} is null or (${table.resolutionReason} is not null and length(${table.resolutionReason}) > 0)`
  ),
  check("flags_raised_by_type_check", sql`${table.raisedByType} in ('system','user','client','ai')`),
]);

// ---------------------------------------------------------------------------
// Notification outbox (in-app, email, SMS). Separate from schema.ts's
// `outbox`, which is for practice-management-tool integrations (c5).
// ---------------------------------------------------------------------------

export const notificationOutbox = pgTable("notification_outbox", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  /** 'in_app' | 'email' | 'sms'. Each channel is its own row, so one failing never blocks another (c51). */
  channel: text("channel").notNull(),
  /** 'user' (firm staff) or 'party' (client / other contact). */
  recipientType: text("recipient_type").notNull(),
  recipientUserId: uuid("recipient_user_id").references(() => users.id),
  recipientPartyId: uuid("recipient_party_id").references(() => parties.id),
  /** Resolved destination (safe email / consented phone). Null for in_app. */
  recipientAddress: text("recipient_address"),
  /** For party recipients: a legalCopy() gate key. For users: a free internal template key. */
  templateKey: text("template_key").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  matterId: uuid("matter_id").references(() => matters.id),
  flagId: uuid("flag_id").references(() => flags.id),
  urgent: boolean("urgent").notNull().default(false),
  /**
   * 'pending'    queued for the worker
   * 'held'       blocked by a pending approval gate (vendor DPA / copy review) or the stub provider — nothing sent
   * 'sent'       handed to the provider
   * 'delivered'  provider confirmed (in_app rows are delivered on insert)
   * 'bounced' | 'failed'
   * 'suppressed' deliberately not sent (no safe address, no SMS consent, opted out) — reason in last_error
   * 'cancelled'
   */
  status: text("status").notNull().default("pending"),
  /** Do not send before this instant (quiet hours, digests). */
  notBefore: timestamp("not_before", { withTimezone: true }),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  provider: text("provider"),
  providerMessageId: text("provider_message_id"),
  dedupeKey: text("dedupe_key"),
  readAt: timestamp("read_at", { withTimezone: true }),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("notification_outbox_tenant_status_idx").on(table.tenantId, table.status, table.notBefore),
  index("notification_outbox_tenant_user_idx").on(table.tenantId, table.recipientUserId, table.channel),
  index("notification_outbox_tenant_party_idx").on(table.tenantId, table.recipientPartyId, table.channel),
  uniqueIndex("notification_outbox_dedupe_key")
    .on(table.tenantId, table.dedupeKey)
    .where(sql`${table.dedupeKey} is not null`),
  check("notification_outbox_channel_check", sql`${table.channel} in ('in_app','email','sms')`),
  check("notification_outbox_recipient_type_check", sql`${table.recipientType} in ('user','party')`),
  check(
    "notification_outbox_recipient_consistency_check",
    sql`(${table.recipientType} = 'user' and ${table.recipientUserId} is not null and ${table.recipientPartyId} is null)
      or (${table.recipientType} = 'party' and ${table.recipientPartyId} is not null and ${table.recipientUserId} is null)`
  ),
  check(
    "notification_outbox_status_check",
    sql`${table.status} in ('pending','held','sent','delivered','bounced','failed','suppressed','cancelled')`
  ),
]);

// ---------------------------------------------------------------------------
// Audit events for every engine. `intake_events` (schema.ts) stays the audit
// log for intake sessions; it requires an intake_session_id, so matter-level
// actions from the other engines land here. Append-only (see notes below).
// ---------------------------------------------------------------------------

export const auditEvents = pgTable("audit_events", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  /** Engine slug that wrote the event: 'intake', 'conflict-check', 'document', 'calendar-alerts', … or 'core'. */
  engine: text("engine").notNull(),
  /** Dotted action name, e.g. 'task.completed', 'flag.raised', 'approval.blocked'. */
  action: text("action").notNull(),
  entityType: text("entity_type"),
  entityId: uuid("entity_id"),
  matterId: uuid("matter_id").references(() => matters.id),
  intakeSessionId: uuid("intake_session_id").references(() => intakeSessions.id),
  actorType: text("actor_type").notNull(),
  actorUserId: uuid("actor_user_id").references(() => users.id),
  actorPartyId: uuid("actor_party_id").references(() => parties.id),
  /** Human reason where one is required (clearing flags, changing dates …). */
  reason: text("reason"),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("audit_events_tenant_matter_idx").on(table.tenantId, table.matterId, table.occurredAt),
  index("audit_events_tenant_entity_idx").on(table.tenantId, table.entityType, table.entityId),
  index("audit_events_tenant_occurred_idx").on(table.tenantId, table.occurredAt),
  check("audit_events_actor_type_check", sql`${table.actorType} in ('system','user','client','ai')`),
]);

// ---------------------------------------------------------------------------
// Compliance approvals (platform-level — NOT tenant-scoped)
// ---------------------------------------------------------------------------

/**
 * One row per reviewer sign-off on an approval gate defined in
 * src/compliance/approvals.ts. Platform-level, like `firms`: the approvals
 * are about the product's wording, rules and vendors, not one firm's data.
 * The app role may only SELECT this table; sign-offs are recorded by an
 * operator with the elevated migrations role (see src/compliance/cli.ts).
 */
export const complianceApprovals = pgTable("compliance_approvals", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  gateKey: text("gate_key").notNull(),
  /** 'attorney' | 'cpa' | 'vendor_dpa' | 'founder_decision'. */
  reviewerKind: text("reviewer_kind").notNull(),
  approvedByName: text("approved_by_name").notNull(),
  approvedAt: timestamp("approved_at", { withTimezone: true }).notNull().defaultNow(),
  notes: text("notes"),
  /** The exact approved wording (copy gates). Overrides the gate's draft. */
  approvedText: text("approved_text"),
  /** Hash of the gate draft that was reviewed; a changed draft invalidates the approval. */
  draftHash: text("draft_hash"),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokedReason: text("revoked_reason"),
}, (table) => [
  index("compliance_approvals_gate_idx").on(table.gateKey, table.reviewerKind),
  check(
    "compliance_approvals_reviewer_kind_check",
    sql`${table.reviewerKind} in ('attorney','cpa','vendor_dpa','founder_decision')`
  ),
]);

// ---------------------------------------------------------------------------
// MIGRATION NOTES for the integration step (hand-add to the generated SQL):
//
// 1. RLS + tenant_isolation policy (same text as migrations/0000) on:
//    firm_settings, calendar_events, tasks, flags, notification_outbox, audit_events.
// 2. GRANT SELECT, INSERT, UPDATE, DELETE ON firm_settings, calendar_events,
//    tasks, flags, notification_outbox TO app_runtime;
// 3. audit_events is append-only (c6 §3):
//    GRANT SELECT, INSERT ON audit_events TO app_runtime;
//    REVOKE UPDATE, DELETE ON audit_events FROM app_runtime;
// 4. compliance_approvals is platform-level: ENABLE RLS, then
//    CREATE POLICY app_runtime_read ON compliance_approvals FOR SELECT TO app_runtime USING (true);
//    GRANT SELECT ON compliance_approvals TO app_runtime;
//    REVOKE ALL ON compliance_approvals FROM anon, authenticated;
// 5. `ALTER TYPE party_role ADD VALUE …` statements cannot be used in the same
//    transaction that adds them — drizzle-kit emits them as separate
//    statements; keep them first in the file.
// ---------------------------------------------------------------------------
