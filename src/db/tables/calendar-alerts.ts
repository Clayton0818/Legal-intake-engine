// Tables owned by the Calendar & deadline engine — alerts, reply clocks, flags
// and client updates (c42–c47, c51, c53, c54, c64).
//
// Conventions (see ./foundation.ts): NOT NULL tenantId -> firms.id on every
// tenant-scoped table, text + CHECK for statuses, timestamptz everywhere.
// Migrations are generated once at integration time; the RLS / GRANT needs of
// these tables are listed in MIGRATION NOTES at the bottom of this file.
//
// What is NOT here, because the foundation already has it: tasks (every timer
// is a `tasks` row — c45 "one mechanism"), flags, the notification outbox,
// audit events, calendar events and scheduled_tasks. These tables only hold
// what the shared ones cannot: the client correspondence log the reply clocks
// run on, the clocks' own checkpoints, the non-response ladder state, client
// updates, captured court notices, stall episodes, health snapshots and
// email-delivery follow-ups.

import { sql } from "drizzle-orm";
import { pgTable, uuid, text, boolean, integer, timestamp, jsonb, index, uniqueIndex, check, bigint } from "drizzle-orm/pg-core";
import { firms, users, matters, parties, documents } from "../schema";
import { tasks, flags, calendarEvents, notificationOutbox } from "./foundation";

// ---------------------------------------------------------------------------
// c42 / c43 / c44 — client correspondence log
// ---------------------------------------------------------------------------

/**
 * Every message between the firm and a client on a matter (portal, email
 * filed to the matter, SMS once approved, logged phone calls). Inbound client
 * messages start the c43/c44 reply clocks; outbound messages that expect a
 * reply start the c42 response window. Internal only: the client portal shows
 * its own projection of the thread, never these columns directly.
 */
export const clientMessages = pgTable("client_messages", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  matterId: uuid("matter_id").notNull().references(() => matters.id),
  /** Conversation key inside the matter (default one thread per matter). */
  threadKey: text("thread_key").notNull().default("main"),
  /** 'inbound' (from the client) | 'outbound' (to the client). */
  direction: text("direction").notNull(),
  /** 'client' | 'user' (lawyer/staff) | 'ai' | 'system'. */
  senderType: text("sender_type").notNull(),
  senderUserId: uuid("sender_user_id").references(() => users.id),
  senderPartyId: uuid("sender_party_id").references(() => parties.id),
  /** Client party the message is to/from. */
  clientPartyId: uuid("client_party_id").references(() => parties.id),
  /** 'portal' | 'email' | 'sms' | 'phone_log'. */
  channel: text("channel").notNull(),
  body: text("body").notNull(),
  /** The automatic acknowledgement (c43): never stops a reply clock. */
  isAutoAck: boolean("is_auto_ack").notNull().default(false),
  /** Auto-submitted mail (out-of-office): never counts as a client reply (c42). */
  autoSubmitted: boolean("auto_submitted").notNull().default(false),
  /** Outbound only: does this message expect a client reply (c42)? */
  expectsReply: boolean("expects_reply").notNull().default(false),
  /** Outbound only: per-message response window override (business hours). */
  replyWindowHours: integer("reply_window_hours"),
  /** Outbound only: deadline the request is tied to (c41 hand-off, c42 §8). */
  relatedCalendarEventId: uuid("related_calendar_event_id").references(() => calendarEvents.id),
  /** Inbound only (c44): tagged as a deadline question. */
  deadlineRelated: boolean("deadline_related").notNull().default(false),
  /** 'rules' | 'ai' | 'calendar' | 'staff' | null. */
  deadlineTagSource: text("deadline_tag_source"),
  /** Classifier/rule detail (matched terms, model id, confidence). Internal. */
  deadlineTagDetail: jsonb("deadline_tag_detail").$type<Record<string, unknown>>().notNull().default({}),
  /** Date the client stated for a court/filing event — "client-stated, not verified" (c44 rule 7). */
  clientStatedEventAt: timestamp("client_stated_event_at", { withTimezone: true }),
  /** Safety flag from the caller's classifier or the conservative rules here. */
  urgent: boolean("urgent").notNull().default(false),
  inReplyToMessageId: uuid("in_reply_to_message_id"),
  /** A client reply to a client update (c54 → c43). */
  inReplyToUpdateId: uuid("in_reply_to_update_id"),
  /** 'delivered' | 'held' (wording pending review — never shown to the client) | 'logged'. */
  deliveryState: text("delivery_state").notNull().default("logged"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("client_messages_tenant_matter_idx").on(t.tenantId, t.matterId, t.occurredAt),
  check("client_messages_direction_check", sql`${t.direction} in ('inbound','outbound')`),
  check("client_messages_sender_type_check", sql`${t.senderType} in ('client','user','ai','system')`),
  check("client_messages_channel_check", sql`${t.channel} in ('portal','email','sms','phone_log')`),
  check("client_messages_delivery_state_check", sql`${t.deliveryState} in ('delivered','held','logged')`),
  check(
    "client_messages_direction_sender_check",
    sql`(${t.direction} = 'inbound' and ${t.senderType} = 'client') or (${t.direction} = 'outbound' and ${t.senderType} <> 'client')`
  ),
  check(
    "client_messages_tag_source_check",
    sql`${t.deadlineTagSource} is null or ${t.deadlineTagSource} in ('rules','ai','calendar','staff')`
  ),
]);

/**
 * One open reply clock per matter thread (c43 rule 4), started by the
 * earliest unanswered client message. The clock's timer is a `tasks` row
 * (`calendar-alerts.firm_reply_due`); this row holds the tier, the settings
 * snapshot (open clocks keep their original numbers) and the checkpoint state.
 */
export const replyClocks = pgTable("reply_clocks", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  matterId: uuid("matter_id").notNull().references(() => matters.id),
  threadKey: text("thread_key").notNull().default("main"),
  firstMessageId: uuid("first_message_id").notNull().references(() => clientMessages.id),
  taskId: uuid("task_id").references(() => tasks.id),
  /** 'standard' (c43, 24/48) | 'deadline' (c44, 12/24). */
  tier: text("tier").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  flagHours: integer("flag_hours").notNull(),
  promiseHours: integer("promise_hours").notNull(),
  flagAt: timestamp("flag_at", { withTimezone: true }).notNull(),
  promiseAt: timestamp("promise_at", { withTimezone: true }).notNull(),
  /** 'open' | 'replied' | 'closed' (no reply needed, with reason) | 'cancelled'. */
  status: text("status").notNull().default("open"),
  flaggedAt: timestamp("flagged_at", { withTimezone: true }),
  promiseMissedAt: timestamp("promise_missed_at", { withTimezone: true }),
  /** Immediate real-clock alert (c43 rule 8 / c44 safety net). */
  immediateAlertAt: timestamp("immediate_alert_at", { withTimezone: true }),
  immediateAlertReason: text("immediate_alert_reason"),
  immediateFlagId: uuid("immediate_flag_id").references(() => flags.id),
  /** Earliest relevant deadline seen when the clock was planned (real clock). */
  earliestDeadlineAt: timestamp("earliest_deadline_at", { withTimezone: true }),
  /** 'calendar' | 'client_stated'. */
  earliestDeadlineSource: text("earliest_deadline_source"),
  messageCount: integer("message_count").notNull().default(1),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  closedByUserId: uuid("closed_by_user_id").references(() => users.id),
  closeReason: text("close_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("reply_clocks_one_open_per_thread").on(t.tenantId, t.matterId, t.threadKey).where(sql`${t.status} = 'open'`),
  index("reply_clocks_tenant_status_idx").on(t.tenantId, t.status, t.promiseAt),
  check("reply_clocks_tier_check", sql`${t.tier} in ('standard','deadline')`),
  check("reply_clocks_status_check", sql`${t.status} in ('open','replied','closed','cancelled')`),
  check("reply_clocks_flag_before_promise_check", sql`${t.flagHours} <= ${t.promiseHours}`),
  check("reply_clocks_close_reason_check", sql`${t.status} <> 'closed' or (${t.closeReason} is not null and length(${t.closeReason}) > 0)`),
  check(
    "reply_clocks_deadline_source_check",
    sql`${t.earliestDeadlineSource} is null or ${t.earliestDeadlineSource} in ('calendar','client_stated')`
  ),
]);

// ---------------------------------------------------------------------------
// c42 / c46 — the client chase ladder (reminders, then the lawyer decides)
// ---------------------------------------------------------------------------

export const clientChaseLadders = pgTable("client_chase_ladders", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  matterId: uuid("matter_id").references(() => matters.id),
  /** 'message' (c42 unanswered request) | 'task' (c46 unfinished client task). */
  subjectType: text("subject_type").notNull(),
  /** The client-owned task the ladder chases (a c42 request is a client_reply_due task). */
  taskId: uuid("task_id").notNull().references(() => tasks.id),
  messageId: uuid("message_id").references(() => clientMessages.id),
  partyId: uuid("party_id").notNull().references(() => parties.id),
  /** Index of the NEXT step in the firm's ladder. */
  nextStep: integer("next_step").notNull().default(0),
  nextAt: timestamp("next_at", { withTimezone: true }),
  remindersSent: integer("reminders_sent").notNull().default(0),
  /** 'active' | 'paused' | 'awaiting_lawyer' | 'completed' | 'stopped'. */
  status: text("status").notNull().default("active"),
  pausedReason: text("paused_reason"),
  /** 'lawyer' | 'help_request'. */
  pausedBy: text("paused_by"),
  internalFlagId: uuid("internal_flag_id").references(() => flags.id),
  decisionTaskId: uuid("decision_task_id").references(() => tasks.id),
  /** The ladder settings used (open ladders keep their original settings). */
  ladderSnapshot: jsonb("ladder_snapshot").$type<Record<string, unknown>>().notNull().default({}),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  lastStepAt: timestamp("last_step_at", { withTimezone: true }),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  endReason: text("end_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("client_chase_ladders_task_key").on(t.tenantId, t.taskId),
  index("client_chase_ladders_due_idx").on(t.tenantId, t.status, t.nextAt),
  check("client_chase_ladders_subject_check", sql`${t.subjectType} in ('message','task')`),
  check("client_chase_ladders_status_check", sql`${t.status} in ('active','paused','awaiting_lawyer','completed','stopped')`),
  check("client_chase_ladders_paused_by_check", sql`${t.pausedBy} is null or ${t.pausedBy} in ('lawyer','help_request')`),
  check("client_chase_ladders_paused_reason_check", sql`${t.status} <> 'paused' or (${t.pausedReason} is not null and length(${t.pausedReason}) > 0)`),
]);

// ---------------------------------------------------------------------------
// c54 — client updates (portal history + email notice)
// ---------------------------------------------------------------------------

export const clientUpdates = pgTable("client_updates", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  matterId: uuid("matter_id").notNull().references(() => matters.id),
  /** Each client sees only updates addressed to them. */
  recipientPartyIds: uuid("recipient_party_ids").array().notNull(),
  body: text("body").notNull(),
  language: text("language").notNull().default("en"),
  /** 'user' (lawyer/staff — sends directly) | 'ai' | 'system_draft' (both wait for lawyer approval). */
  authorType: text("author_type").notNull(),
  authorUserId: uuid("author_user_id").references(() => users.id),
  /** 'draft' | 'pending_approval' | 'sent' | 'discarded'. */
  status: text("status").notNull(),
  approvedByUserId: uuid("approved_by_user_id").references(() => users.id),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  /** A correction is a NEW update pointing at the original (sent updates are immutable). */
  correctsUpdateId: uuid("corrects_update_id"),
  /** Where an automatic draft came from, e.g. 'calendar_event:<id>'. */
  sourceEventRef: text("source_event_ref"),
  /** Version marker of the source when drafted (stale drafts cannot be approved). */
  sourceVersion: text("source_version"),
  /** Draft checker findings (predictions / advice / internal data). */
  checkFindings: jsonb("check_findings").$type<string[]>().notNull().default([]),
  approvalTaskId: uuid("approval_task_id").references(() => tasks.id),
  discardedReason: text("discarded_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("client_updates_tenant_matter_idx").on(t.tenantId, t.matterId, t.sentAt),
  index("client_updates_tenant_status_idx").on(t.tenantId, t.status),
  check("client_updates_author_type_check", sql`${t.authorType} in ('user','ai','system_draft')`),
  check("client_updates_status_check", sql`${t.status} in ('draft','pending_approval','sent','discarded')`),
  check("client_updates_recipients_check", sql`cardinality(${t.recipientPartyIds}) > 0`),
  // An AI/system draft can only be sent with a recorded lawyer approval (c54 rule 3).
  check(
    "client_updates_ai_approval_check",
    sql`${t.status} <> 'sent' or ${t.authorType} = 'user' or (${t.approvedByUserId} is not null and ${t.approvedAt} is not null)`
  ),
  check("client_updates_sent_at_check", sql`${t.status} <> 'sent' or ${t.sentAt} is not null`),
]);

/** First time a client opened an update in the portal (c54 §4.5). */
export const clientUpdateReads = pgTable("client_update_reads", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  updateId: uuid("update_id").notNull().references(() => clientUpdates.id),
  partyId: uuid("party_id").notNull().references(() => parties.id),
  firstOpenedAt: timestamp("first_opened_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("client_update_reads_key").on(t.tenantId, t.updateId, t.partyId)]);

/** Per-matter update rhythm (c54 §4.8; firm default off). */
export const clientUpdateCadences = pgTable("client_update_cadences", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  matterId: uuid("matter_id").notNull().references(() => matters.id),
  everyBusinessDays: integer("every_business_days").notNull(),
  /** The open `calendar-alerts.client_update_due` task. */
  currentTaskId: uuid("current_task_id").references(() => tasks.id),
  setByUserId: uuid("set_by_user_id").references(() => users.id),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("client_update_cadences_matter_key").on(t.tenantId, t.matterId),
  check("client_update_cadences_positive_check", sql`${t.everyBusinessDays} > 0 and ${t.everyBusinessDays} <= 260`),
]);

// ---------------------------------------------------------------------------
// c64 — court notices captured from mailboxes / e-filing services
// ---------------------------------------------------------------------------

/**
 * A captured court email or e-service notice. Least privilege: a row with a
 * body exists only for messages from a TRUSTED, AUTHENTICATED court sender;
 * possible-phishing look-alikes keep metadata only (no body); ordinary mail
 * is never stored at all.
 */
export const courtNotices = pgTable("court_notices", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  /** 'mailbox' | 'efiling' | 'manual'. */
  source: text("source").notNull(),
  /** Which mailbox / service account it came from (no credentials). */
  sourceAccount: text("source_account"),
  /** Provider message id (dedupe). */
  externalId: text("external_id").notNull(),
  fromAddress: text("from_address").notNull(),
  fromDomain: text("from_domain").notNull(),
  fromDisplayName: text("from_display_name"),
  subject: text("subject").notNull(),
  /** Null for possible-phishing rows (metadata only). */
  bodyText: text("body_text"),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
  /** { spf, dkim, dmarc, dkimDomain } as reported by the provider. */
  authResults: jsonb("auth_results").$type<Record<string, unknown>>().notNull().default({}),
  /** 'court_verified' | 'possible_phishing'. */
  classification: text("classification").notNull(),
  classificationReasons: jsonb("classification_reasons").$type<string[]>().notNull().default([]),
  /** Which trusted sender entry matched (label/domain). */
  trustedSender: text("trusted_sender"),
  matterId: uuid("matter_id").references(() => matters.id),
  /** 'cause_number' | 'party_name' | 'staff' | null. */
  matchMethod: text("match_method"),
  matchDetail: jsonb("match_detail").$type<Record<string, unknown>>().notNull().default({}),
  /** 'matched' | 'unmatched' (admin queue) | 'phishing_review' | 'dismissed'. */
  status: text("status").notNull(),
  alertFlagId: uuid("alert_flag_id").references(() => flags.id),
  ackDueAt: timestamp("ack_due_at", { withTimezone: true }),
  acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
  acknowledgedByUserId: uuid("acknowledged_by_user_id").references(() => users.id),
  escalationStep: integer("escalation_step").notNull().default(0),
  dismissedReason: text("dismissed_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("court_notices_external_key").on(t.tenantId, t.source, t.externalId),
  index("court_notices_tenant_status_idx").on(t.tenantId, t.status, t.receivedAt),
  index("court_notices_tenant_matter_idx").on(t.tenantId, t.matterId),
  check("court_notices_source_check", sql`${t.source} in ('mailbox','efiling','manual')`),
  check("court_notices_classification_check", sql`${t.classification} in ('court_verified','possible_phishing')`),
  check("court_notices_status_check", sql`${t.status} in ('matched','unmatched','phishing_review','dismissed')`),
  check("court_notices_match_method_check", sql`${t.matchMethod} is null or ${t.matchMethod} in ('cause_number','party_name','staff')`),
  // Phishing look-alikes are never stored with a body (least privilege, c64).
  check("court_notices_phishing_no_body_check", sql`${t.classification} <> 'possible_phishing' or ${t.bodyText} is null`),
  check("court_notices_matched_has_matter_check", sql`${t.status} <> 'matched' or ${t.matterId} is not null`),
  check("court_notices_dismissed_reason_check", sql`${t.status} <> 'dismissed' or (${t.dismissedReason} is not null and length(${t.dismissedReason}) > 0)`),
]);

export const courtNoticeAttachments = pgTable("court_notice_attachments", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  noticeId: uuid("notice_id").notNull().references(() => courtNotices.id),
  filename: text("filename").notNull(),
  mimeType: text("mime_type"),
  sizeBytes: bigint("size_bytes", { mode: "number" }),
  sha256: text("sha256"),
  /** Object-storage key from the adapter (null until vendor.object_storage is live). */
  storageKey: text("storage_key"),
  /** The `documents` row once filed to the matter. */
  documentId: uuid("document_id").references(() => documents.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("court_notice_attachments_notice_idx").on(t.tenantId, t.noticeId)]);

/**
 * Dates seen in a court notice — SUGGESTIONS ONLY. An explicit date may be
 * proposed to the calendar (status 'proposed'); a relative period ("within
 * 20 days") is recorded as text with NO computed date. A lawyer confirms
 * every deadline before it is calendared (c64; the AI never decides one).
 */
export const courtNoticeSuggestions = pgTable("court_notice_suggestions", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  noticeId: uuid("notice_id").notNull().references(() => courtNotices.id),
  /** 'explicit_date' | 'relative_period'. */
  kind: text("kind").notNull(),
  /** 'hearing' | 'trial' | 'deadline' | 'other' (from nearby words). */
  label: text("label").notNull(),
  snippet: text("snippet").notNull(),
  /** Only for explicit dates. Never computed from a relative period. */
  proposedAt: timestamp("proposed_at", { withTimezone: true }),
  /** 'rules' | 'ai'. */
  extractedBy: text("extracted_by").notNull(),
  /** 'open' | 'confirmed' | 'rejected'. */
  status: text("status").notNull().default("open"),
  calendarEventId: uuid("calendar_event_id").references(() => calendarEvents.id),
  decidedByUserId: uuid("decided_by_user_id").references(() => users.id),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  decisionNote: text("decision_note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("court_notice_suggestions_notice_idx").on(t.tenantId, t.noticeId),
  check("court_notice_suggestions_kind_check", sql`${t.kind} in ('explicit_date','relative_period')`),
  check("court_notice_suggestions_label_check", sql`${t.label} in ('hearing','trial','deadline','other')`),
  check("court_notice_suggestions_extracted_by_check", sql`${t.extractedBy} in ('rules','ai')`),
  check("court_notice_suggestions_status_check", sql`${t.status} in ('open','confirmed','rejected')`),
  // A relative period never carries a computed date (no deadline calculation, c64/c92).
  check("court_notice_suggestions_relative_no_date_check", sql`${t.kind} <> 'relative_period' or ${t.proposedAt} is null`),
  check(
    "court_notice_suggestions_decided_check",
    sql`${t.status} = 'open' or (${t.decidedByUserId} is not null and ${t.decidedAt} is not null)`
  ),
]);

/** Cause numbers known for a matter (learned when staff file a notice to a matter). */
export const courtCaseRefs = pgTable("court_case_refs", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  matterId: uuid("matter_id").notNull().references(() => matters.id),
  /** Normalised (upper case, no spaces, single dashes). */
  causeNumber: text("cause_number").notNull(),
  courtName: text("court_name"),
  addedByUserId: uuid("added_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("court_case_refs_key").on(t.tenantId, t.causeNumber, t.matterId)]);

// ---------------------------------------------------------------------------
// c47 — stalled workflow episodes
// ---------------------------------------------------------------------------

export const stallWatches = pgTable("stall_watches", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  /** 'intake_session' | 'conflict_check' | 'matter' | 'document'. */
  itemType: text("item_type").notNull(),
  itemId: uuid("item_id").notNull(),
  matterId: uuid("matter_id").references(() => matters.id),
  stage: text("stage").notNull(),
  lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull(),
  lastActivityLabel: text("last_activity_label"),
  ownerUserId: uuid("owner_user_id").references(() => users.id),
  flagId: uuid("flag_id").references(() => flags.id),
  /** 'flagged' | 'check_back' | 'cleared'. */
  status: text("status").notNull(),
  checkBackAt: timestamp("check_back_at", { withTimezone: true }),
  reason: text("reason"),
  setByUserId: uuid("set_by_user_id").references(() => users.id),
  clearedAt: timestamp("cleared_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // At most one live episode per item (c47 rule 4).
  uniqueIndex("stall_watches_one_live_per_item").on(t.tenantId, t.itemType, t.itemId).where(sql`${t.status} <> 'cleared'`),
  index("stall_watches_tenant_status_idx").on(t.tenantId, t.status),
  check("stall_watches_item_type_check", sql`${t.itemType} in ('intake_session','conflict_check','matter','document')`),
  check("stall_watches_status_check", sql`${t.status} in ('flagged','check_back','cleared')`),
  check(
    "stall_watches_check_back_check",
    sql`${t.status} <> 'check_back' or (${t.checkBackAt} is not null and ${t.reason} is not null and length(${t.reason}) > 0)`
  ),
]);

// ---------------------------------------------------------------------------
// c53 — case health snapshots (internal only)
// ---------------------------------------------------------------------------

export const matterHealthSnapshots = pgTable("matter_health_snapshots", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  matterId: uuid("matter_id").notNull().references(() => matters.id),
  computedAt: timestamp("computed_at", { withTimezone: true }).notNull(),
  /** Null while 'insufficient_data'. */
  score: integer("score"),
  firmSubscore: integer("firm_subscore"),
  clientSubscore: integer("client_subscore"),
  /** 'green' | 'amber' | 'red' | 'insufficient_data'. */
  band: text("band").notNull(),
  fallingSharply: boolean("falling_sharply").notNull().default(false),
  urgencyMultiplier: integer("urgency_multiplier_pct").notNull().default(100),
  rankValue: integer("rank_value").notNull().default(0),
  reasons: jsonb("reasons").$type<Record<string, unknown>>().notNull().default({}),
  signals: jsonb("signals").$type<Record<string, unknown>>().notNull().default({}),
  flagId: uuid("flag_id").references(() => flags.id),
}, (t) => [
  index("matter_health_snapshots_matter_idx").on(t.tenantId, t.matterId, t.computedAt),
  index("matter_health_snapshots_tenant_computed_idx").on(t.tenantId, t.computedAt),
  check("matter_health_snapshots_band_check", sql`${t.band} in ('green','amber','red','insufficient_data')`),
  check("matter_health_snapshots_score_check", sql`${t.score} is null or (${t.score} between 0 and 100)`),
]);

// ---------------------------------------------------------------------------
// c51 — email follow-ups the core outbox does not do itself
// ---------------------------------------------------------------------------

/** A non-urgent internal flag email rolled into a user's daily digest (firm setting). */
export const alertDigestItems = pgTable("alert_digest_items", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  userId: uuid("user_id").notNull().references(() => users.id),
  flagId: uuid("flag_id").notNull().references(() => flags.id),
  /** The digest email that carried it. */
  notificationId: uuid("notification_id").references(() => notificationOutbox.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("alert_digest_items_key").on(t.tenantId, t.userId, t.flagId),
  index("alert_digest_items_pending_idx").on(t.tenantId, t.sentAt),
]);

/**
 * One row per notification the c51 delivery watch has acted on (bounce →
 * lawyer flag, failure → admin flag, no safe address → lawyer flag), so a
 * resolved follow-up flag is never raised twice for the same delivery.
 */
export const deliveryFollowups = pgTable("delivery_followups", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  notificationId: uuid("notification_id").notNull().references(() => notificationOutbox.id),
  /** 'bounced' | 'failed' | 'suppressed_no_address' | 'email_missing'. */
  kind: text("kind").notNull(),
  flagId: uuid("flag_id").references(() => flags.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("delivery_followups_key").on(t.tenantId, t.notificationId, t.kind),
  check("delivery_followups_kind_check", sql`${t.kind} in ('bounced','failed','suppressed_no_address','email_missing')`),
]);

/** When each periodic job last ran per firm (hourly stall sweep, nightly health, daily digest). */
export const alertJobRuns = pgTable("alert_job_runs", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  job: text("job").notNull(),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }).notNull(),
  lastSummary: jsonb("last_summary").$type<Record<string, unknown>>().notNull().default({}),
}, (t) => [uniqueIndex("alert_job_runs_key").on(t.tenantId, t.job)]);

// ---------------------------------------------------------------------------
// MIGRATION NOTES for the integration step (hand-add to the generated SQL):
//
// 1. RLS + the standard tenant_isolation policy (same text as migrations/0000)
//    on every table in this file:
//    client_messages, reply_clocks, client_chase_ladders, client_updates,
//    client_update_reads, client_update_cadences, court_notices,
//    court_notice_attachments, court_notice_suggestions, court_case_refs,
//    stall_watches, matter_health_snapshots, alert_digest_items,
//    delivery_followups, alert_job_runs.
// 2. Staging grants app_runtime SELECT, INSERT, UPDATE, DELETE by default; add
//    these restrictions explicitly:
//    - client_messages is the correspondence record (c6): append-only.
//        REVOKE UPDATE, DELETE ON client_messages FROM app_runtime;
//      (re-tagging a message is recorded on reply_clocks + audit_events, the
//       message row itself never changes.)
//    - matter_health_snapshots, client_update_reads, delivery_followups are
//      append-only logs:
//        REVOKE UPDATE, DELETE ON matter_health_snapshots, client_update_reads, delivery_followups FROM app_runtime;
//    - no DELETE on records that must never lose rows (c54 rule 5, c64 "every
//      alert logged", c47 rule 8):
//        REVOKE DELETE ON client_updates, reply_clocks, client_chase_ladders,
//          court_notices, court_notice_attachments, court_notice_suggestions,
//          stall_watches, alert_digest_items FROM app_runtime;
// 3. Sent client updates are immutable (c54 rule 5). Add a trigger:
//      CREATE FUNCTION client_updates_immutable() RETURNS trigger AS $$
//      BEGIN
//        IF OLD.status = 'sent' THEN
//          RAISE EXCEPTION 'client_updates: a sent update cannot be changed; send a correction';
//        END IF;
//        RETURN NEW;
//      END $$ LANGUAGE plpgsql;
//      CREATE TRIGGER client_updates_immutable BEFORE UPDATE ON client_updates
//        FOR EACH ROW EXECUTE FUNCTION client_updates_immutable();
// 4. Client principals (c34, once they exist) get NO access to: reply_clocks,
//    client_chase_ladders, court_notices, court_notice_attachments,
//    court_notice_suggestions, court_case_refs, stall_watches,
//    matter_health_snapshots, alert_digest_items, delivery_followups,
//    alert_job_runs (internal only: c45/c47/c53/c64). client_updates and
//    client_update_reads: SELECT only rows where the principal's party id is in
//    recipient_party_ids and status = 'sent'. client_messages: SELECT only rows
//    of the principal's own matters where delivery_state <> 'held' (columns
//    deadline_tag_* / urgent are internal — expose through a view without them).
// 5. client_messages.in_reply_to_message_id / in_reply_to_update_id and
//    client_updates.corrects_update_id are plain uuids (no FK) to avoid
//    self-reference ordering; add FKs by hand if wanted.
// ---------------------------------------------------------------------------
