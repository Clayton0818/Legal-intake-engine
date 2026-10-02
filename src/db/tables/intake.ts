// Tables owned by the Intake engine (c14, c48, c65–c70, c73).
//
// Shared tables live in ./foundation.ts and ../schema.ts (imported, never
// redefined or edited). Conventions (identical to ./foundation.ts): NOT NULL
// tenantId -> firms.id on every tenant-scoped table, text + CHECK for
// statuses, timestamptz everywhere. Migrations are generated once at
// integration time; RLS/GRANT needs are in MIGRATION NOTES at the bottom.
//
// Why engine tables instead of new columns on shared tables: engines may not
// edit schema.ts, so per-session and per-matter intake state that the specs
// propose as new columns (`intake_sessions.first_human_contact_at`,
// `matters.firm_stage_key`, `matters.retained_at`, a CHECK on
// `intake_sessions.channel` …) lives in 1:1 side tables here instead.

import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  bigint,
  real,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { firms, users, matters, parties, intakeSessions } from "../schema";
import { flags, tasks, calendarEvents } from "./foundation";

// ---------------------------------------------------------------------------
// c14 — configurable pipeline stages (versioned, never rewritten)
// ---------------------------------------------------------------------------

/** One firm stage inside a pipeline version (shape validated in src/engines/intake/pipeline/stages.ts). */
export interface PipelineStageDef {
  key: string;
  label: string;
  clientLabel?: string | null;
  systemStage: string;
  order: number;
  colour: string;
  isDefaultForSystemStage: boolean;
  hidden: boolean;
  expectedBusinessHours?: number | null;
}

export const intakePipelineVersions = pgTable("intake_pipeline_versions", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  version: integer("version").notNull(),
  stages: jsonb("stages").$type<PipelineStageDef[]>().notNull(),
  effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull().defaultNow(),
  createdByUserId: uuid("created_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("intake_pipeline_versions_tenant_version_key").on(t.tenantId, t.version),
  index("intake_pipeline_versions_tenant_effective_idx").on(t.tenantId, t.effectiveFrom),
]);

/** Which firm stage a matter sits in (null row = the default firm stage of matters.stage). */
export const intakeMatterFirmStages = pgTable("intake_matter_firm_stages", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  matterId: uuid("matter_id").notNull().references(() => matters.id),
  firmStageKey: text("firm_stage_key").notNull(),
  pipelineVersion: integer("pipeline_version").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("intake_matter_firm_stages_matter_key").on(t.tenantId, t.matterId)]);

// ---------------------------------------------------------------------------
// c48 — automatic assignment
// ---------------------------------------------------------------------------

export const intakeLawyerProfiles = pgTable("intake_lawyer_profiles", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  userId: uuid("user_id").notNull().references(() => users.id),
  /** Practice-area ids plus optional sub-types, e.g. {family, family_custody}. */
  practiceAreas: text("practice_areas").array().notNull().default(sql`'{}'::text[]`),
  /** ISO language codes spoken, e.g. {en, es}. */
  languages: text("languages").array().notNull().default(sql`'{en}'::text[]`),
  /** Counties / courts the lawyer is active in (normalised lowercase). Empty = firm-wide. */
  counties: text("counties").array().notNull().default(sql`'{}'::text[]`),
  /** Firm-defined seniority level (1 = junior … 5 = partner). */
  seniority: integer("seniority").notNull().default(1),
  /** Per-lawyer override of the weekly new-matter cap. */
  weeklyNewMatterCap: integer("weekly_new_matter_cap"),
  acceptsNewMatters: boolean("accepts_new_matters").notNull().default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("intake_lawyer_profiles_user_key").on(t.tenantId, t.userId),
  check("intake_lawyer_profiles_seniority_check", sql`${t.seniority} between 1 and 5`),
]);

export const intakeOutOfOffice = pgTable("intake_out_of_office", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  userId: uuid("user_id").notNull().references(() => users.id),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("intake_out_of_office_user_idx").on(t.tenantId, t.userId, t.endsAt),
  check("intake_out_of_office_range_check", sql`${t.endsAt} > ${t.startsAt}`),
]);

/**
 * Local mirror of "this lawyer must never be assigned this matter / party"
 * (ethical screens, c60, and other hard blocks). The conflict-check engine
 * owns screens; until a shared screens table exists (shared request in the
 * PR), screens are recorded here by staff or an integration job.
 */
export const intakeAssignmentBlocks = pgTable("intake_assignment_blocks", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  userId: uuid("user_id").notNull().references(() => users.id),
  matterId: uuid("matter_id").references(() => matters.id),
  partyId: uuid("party_id").references(() => parties.id),
  /** 'screened' (c60) | 'restricted' | 'other'. */
  reason: text("reason").notNull(),
  note: text("note"),
  createdByUserId: uuid("created_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
}, (t) => [
  index("intake_assignment_blocks_user_idx").on(t.tenantId, t.userId),
  check("intake_assignment_blocks_reason_check", sql`${t.reason} in ('screened','restricted','other')`),
  check("intake_assignment_blocks_target_check", sql`${t.matterId} is not null or ${t.partyId} is not null`),
]);

/** Every assignment with its full score breakdown (append-only in practice: reassignment ends the old row). */
export const intakeMatterAssignments = pgTable("intake_matter_assignments", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  matterId: uuid("matter_id").notNull().references(() => matters.id),
  /** Null when the run found nobody (unassigned queue). */
  assigneeUserId: uuid("assignee_user_id").references(() => users.id),
  /** 'auto' | 'override' | 'manual' | 'unassigned'. */
  method: text("method").notNull(),
  scoreBreakdown: jsonb("score_breakdown").$type<Record<string, unknown>>().notNull().default({}),
  reason: text("reason"),
  assignedByUserId: uuid("assigned_by_user_id").references(() => users.id),
  /** Hash of the assignment settings that produced the score. */
  settingsVersion: text("settings_version"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
}, (t) => [
  index("intake_matter_assignments_matter_idx").on(t.tenantId, t.matterId, t.createdAt),
  index("intake_matter_assignments_assignee_idx").on(t.tenantId, t.assigneeUserId, t.createdAt),
  check("intake_matter_assignments_method_check", sql`${t.method} in ('auto','override','manual','unassigned')`),
  check("intake_matter_assignments_override_reason_check", sql`${t.method} <> 'override' or (${t.reason} is not null and length(${t.reason}) > 0)`),
]);

// ---------------------------------------------------------------------------
// c65 — one intake record from every channel (1:1 side table + messages)
// ---------------------------------------------------------------------------

export const INTAKE_CHANNELS_SQL = `'web_chat','web_form','phone_ai','phone_staff','email','sms','referral','walk_in','phone_manual'`;

/** Intake-engine state for one intake_sessions row. */
export const intakeSessionState = pgTable("intake_session_state", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  intakeSessionId: uuid("intake_session_id").notNull().references(() => intakeSessions.id),
  /** The prospect's contact row (parties). */
  partyId: uuid("party_id").references(() => parties.id),
  channel: text("channel").notNull(),
  /** Vendor thread / call id / email thread id, for resuming a session. */
  externalThreadId: text("external_thread_id"),
  /**
   * 'active' | 'interrupted' | 'referral_awaiting_contact' | 'paused_emergency' |
   * 'closed' | 'not_an_inquiry'.
   */
  status: text("status").notNull().default("active"),
  disclosuresAcknowledgedAt: timestamp("disclosures_acknowledged_at", { withTimezone: true }),
  /** Minimum data for the conflict check: { fullName, otherPartyNames[] }. */
  conflictMinimum: jsonb("conflict_minimum").$type<{ fullName?: string; otherPartyNames?: string[] }>().notNull().default({}),
  conflictCheckRequestedAt: timestamp("conflict_check_requested_at", { withTimezone: true }),
  /** Case details arrived before disclosures / conflict check (email, forms): minimised, not triaged. */
  unsolicitedDetailsReceived: boolean("unsolicited_details_received").notNull().default(false),
  /** 'not_applicable' | 'pending' | 'consented' | 'declined'. */
  recordingState: text("recording_state").notNull().default("not_applicable"),
  // c66 safety
  safetyFlagged: boolean("safety_flagged").notNull().default(false),
  safeContactConfirmedAt: timestamp("safe_contact_confirmed_at", { withTimezone: true }),
  emergencyUnacknowledged: boolean("emergency_unacknowledged").notNull().default(false),
  // c69 speed to lead
  responseClockStartedAt: timestamp("response_clock_started_at", { withTimezone: true }),
  responseTargetAt: timestamp("response_target_at", { withTimezone: true }),
  responseTaskId: uuid("response_task_id").references(() => tasks.id),
  firstHumanContactAt: timestamp("first_human_contact_at", { withTimezone: true }),
  firstHumanContactByUserId: uuid("first_human_contact_by_user_id").references(() => users.id),
  /** 'contacted' | 'attempted' | 'bypassed_emergency' | 'not_an_inquiry' | 'declined'. */
  responseOutcome: text("response_outcome"),
  // c70 follow-up
  followUpStoppedAt: timestamp("follow_up_stopped_at", { withTimezone: true }),
  followUpStopReason: text("follow_up_stop_reason"),
  representedByOtherCounsel: boolean("represented_by_other_counsel").notNull().default(false),
  // c73 fit
  fitOutcome: text("fit_outcome"),
  referralSource: text("referral_source"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("intake_session_state_session_key").on(t.tenantId, t.intakeSessionId),
  index("intake_session_state_thread_idx").on(t.tenantId, t.channel, t.externalThreadId),
  index("intake_session_state_party_idx").on(t.tenantId, t.partyId),
  check("intake_session_state_channel_check", sql.raw(`channel in (${INTAKE_CHANNELS_SQL})`)),
  check(
    "intake_session_state_status_check",
    sql`${t.status} in ('active','interrupted','referral_awaiting_contact','paused_emergency','closed','not_an_inquiry')`
  ),
  check("intake_session_state_recording_check", sql`${t.recordingState} in ('not_applicable','pending','consented','declined')`),
  check(
    "intake_session_state_response_outcome_check",
    sql`${t.responseOutcome} is null or ${t.responseOutcome} in ('contacted','attempted','bypassed_emergency','not_an_inquiry','declined')`
  ),
  check("intake_session_state_fit_check", sql`${t.fitOutcome} is null or ${t.fitOutcome} in ('fit','borderline','no_fit')`),
]);

/** Every inbound and outbound message on any channel, against the session (c65 rule 11). */
export const intakeMessages = pgTable("intake_messages", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  intakeSessionId: uuid("intake_session_id").notNull().references(() => intakeSessions.id),
  /** 'inbound' | 'outbound'. */
  direction: text("direction").notNull(),
  channel: text("channel").notNull(),
  /** 'caller' | 'ai' | 'staff' | 'system'. */
  authorType: text("author_type").notNull(),
  authorUserId: uuid("author_user_id").references(() => users.id),
  /** Message text. Column-level encryption is pending c21 hardening (spec: body_encrypted). */
  body: text("body").notNull(),
  /** Approval gate the outbound wording came from, if any. */
  copyGateKey: text("copy_gate_key"),
  /** 'received' | 'shown' | 'held' | 'sent' | 'failed' | 'suppressed'. */
  deliveryStatus: text("delivery_status").notNull(),
  deliveryDetail: text("delivery_detail"),
  vendorMessageId: text("vendor_message_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("intake_messages_session_idx").on(t.tenantId, t.intakeSessionId, t.createdAt),
  check("intake_messages_direction_check", sql`${t.direction} in ('inbound','outbound')`),
  check("intake_messages_author_check", sql`${t.authorType} in ('caller','ai','staff','system')`),
  check("intake_messages_status_check", sql`${t.deliveryStatus} in ('received','shown','held','sent','failed','suppressed')`),
]);

/** Consents captured at intake (recording, SMS opt-in, disclosures). Shared shape with c72. */
export const intakeConsents = pgTable("intake_consents", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  intakeSessionId: uuid("intake_session_id").notNull().references(() => intakeSessions.id),
  partyId: uuid("party_id").references(() => parties.id),
  /** 'disclosures' | 'recording' | 'sms' | 'ai_disclosure' | 'safe_contact'. */
  consentType: text("consent_type").notNull(),
  channel: text("channel").notNull(),
  /** Gate key + draft hash of the wording shown, so the exact text version is traceable. */
  textGateKey: text("text_gate_key"),
  textVersion: text("text_version"),
  given: boolean("given").notNull(),
  recordedByUserId: uuid("recorded_by_user_id").references(() => users.id),
  givenAt: timestamp("given_at", { withTimezone: true }).notNull().defaultNow(),
  withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
}, (t) => [
  index("intake_consents_session_idx").on(t.tenantId, t.intakeSessionId, t.consentType),
  check("intake_consents_type_check", sql`${t.consentType} in ('disclosures','recording','sms','ai_disclosure','safe_contact')`),
]);

export const intakeReferrals = pgTable("intake_referrals", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  intakeSessionId: uuid("intake_session_id").notNull().references(() => intakeSessions.id),
  /** 'lawyer' | 'client' | 'other'. */
  referrerType: text("referrer_type").notNull(),
  referrerUserId: uuid("referrer_user_id").references(() => users.id),
  referrerPartyId: uuid("referrer_party_id").references(() => parties.id),
  referrerName: text("referrer_name"),
  notes: text("notes"),
  /** Set when the referred person contacted the firm, or asked (via staff) to be contacted. */
  activatedAt: timestamp("activated_at", { withTimezone: true }),
  activationReason: text("activation_reason"),
  recordedByUserId: uuid("recorded_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("intake_referrals_session_idx").on(t.tenantId, t.intakeSessionId),
  check("intake_referrals_type_check", sql`${t.referrerType} in ('lawyer','client','other')`),
]);

// ---------------------------------------------------------------------------
// c66 — emergencies and the on-call rota
// ---------------------------------------------------------------------------

export const intakeEmergencyAlerts = pgTable("intake_emergency_alerts", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  intakeSessionId: uuid("intake_session_id").notNull().references(() => intakeSessions.id),
  matterId: uuid("matter_id").references(() => matters.id),
  /** 'safety' | 'urgent_legal' | 'deadline_risk'. */
  track: text("track").notNull(),
  category: text("category").notNull(),
  /** 'keyword' | 'classifier' | 'staff'. */
  detector: text("detector").notNull(),
  matchedPhrase: text("matched_phrase"),
  flagId: uuid("flag_id").references(() => flags.id),
  raisedAt: timestamp("raised_at", { withTimezone: true }).notNull().defaultNow(),
  acknowledgedByUserId: uuid("acknowledged_by_user_id").references(() => users.id),
  acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
  escalationStep: integer("escalation_step").notNull().default(0),
  pagedUserIds: uuid("paged_user_ids").array().notNull().default(sql`'{}'::uuid[]`),
  downgradedByUserId: uuid("downgraded_by_user_id").references(() => users.id),
  downgradedAt: timestamp("downgraded_at", { withTimezone: true }),
  downgradeReason: text("downgrade_reason"),
}, (t) => [
  index("intake_emergency_alerts_open_idx").on(t.tenantId, t.acknowledgedAt, t.raisedAt),
  index("intake_emergency_alerts_session_idx").on(t.tenantId, t.intakeSessionId),
  check("intake_emergency_alerts_track_check", sql`${t.track} in ('safety','urgent_legal','deadline_risk')`),
  check("intake_emergency_alerts_detector_check", sql`${t.detector} in ('keyword','classifier','staff')`),
  check(
    "intake_emergency_alerts_downgrade_reason_check",
    sql`${t.downgradedAt} is null or (${t.downgradeReason} is not null and length(${t.downgradeReason}) > 0)`
  ),
]);

/**
 * On-call rota. Either a one-off shift (startsAt/endsAt) or a weekly
 * recurring shift (weekday + local start/end time in the firm's time zone).
 */
export const intakeOnCallRota = pgTable("intake_on_call_rota", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  userId: uuid("user_id").notNull().references(() => users.id),
  /** 'primary' | 'backup' | 'staff' (safety alerts go to on-call staff too). */
  role: text("role").notNull(),
  startsAt: timestamp("starts_at", { withTimezone: true }),
  endsAt: timestamp("ends_at", { withTimezone: true }),
  /** 'mon'…'sun' for weekly shifts. */
  weekday: text("weekday"),
  /** 'HH:MM' local; endTime <= startTime means the shift runs past midnight. */
  startTime: text("start_time"),
  endTime: text("end_time"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("intake_on_call_rota_tenant_idx").on(t.tenantId, t.active),
  check("intake_on_call_rota_role_check", sql`${t.role} in ('primary','backup','staff')`),
  check(
    "intake_on_call_rota_shape_check",
    sql`(${t.startsAt} is not null and ${t.endsAt} is not null and ${t.weekday} is null)
      or (${t.weekday} in ('mon','tue','wed','thu','fri','sat','sun') and ${t.startTime} is not null and ${t.endTime} is not null and ${t.startsAt} is null)`
  ),
]);

// ---------------------------------------------------------------------------
// c67 — consultation booking
// ---------------------------------------------------------------------------

export const intakeConsultations = pgTable("intake_consultations", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  intakeSessionId: uuid("intake_session_id").notNull().references(() => intakeSessions.id),
  matterId: uuid("matter_id").references(() => matters.id),
  partyId: uuid("party_id").references(() => parties.id),
  lawyerUserId: uuid("lawyer_user_id").notNull().references(() => users.id),
  /** 'initial_meeting' | 'paid_consult'. */
  meetingType: text("meeting_type").notNull().default("initial_meeting"),
  /** 'video' | 'phone' | 'in_person'. */
  format: text("format").notNull(),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  /** 'held' (slot hold) | 'booked' | 'rescheduled' | 'cancelled' | 'no_show' | 'completed' | 'expired' | 'on_hold'. */
  status: text("status").notNull(),
  holdExpiresAt: timestamp("hold_expires_at", { withTimezone: true }),
  outcome: text("outcome"),
  outcomeNote: text("outcome_note"),
  calendarEventId: uuid("calendar_event_id").references(() => calendarEvents.id),
  externalEventId: text("external_event_id"),
  videoLink: text("video_link"),
  feeCents: bigint("fee_cents", { mode: "number" }),
  /** 'not_required' | 'outside_system' | 'pending' | 'paid' | 'blocked_pending_review'. */
  paymentStatus: text("payment_status").notNull().default("not_required"),
  rebookOfferedAt: timestamp("rebook_offered_at", { withTimezone: true }),
  /** The consult this one re-books (after a no-show) or reschedules. */
  previousConsultationId: uuid("previous_consultation_id"),
  cancelReason: text("cancel_reason"),
  bookedByType: text("booked_by_type").notNull().default("client"),
  bookedByUserId: uuid("booked_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("intake_consultations_lawyer_idx").on(t.tenantId, t.lawyerUserId, t.startsAt),
  index("intake_consultations_session_idx").on(t.tenantId, t.intakeSessionId),
  check("intake_consultations_meeting_type_check", sql`${t.meetingType} in ('initial_meeting','paid_consult')`),
  check("intake_consultations_format_check", sql`${t.format} in ('video','phone','in_person')`),
  check(
    "intake_consultations_status_check",
    sql`${t.status} in ('held','booked','rescheduled','cancelled','no_show','completed','expired','on_hold')`
  ),
  check(
    "intake_consultations_outcome_check",
    sql`${t.outcome} is null or ${t.outcome} in ('retain_offered','needs_follow_up','declined_by_firm','client_declined')`
  ),
  check(
    "intake_consultations_payment_check",
    sql`${t.paymentStatus} in ('not_required','outside_system','pending','paid','blocked_pending_review')`
  ),
  check("intake_consultations_booked_by_check", sql`${t.bookedByType} in ('client','user')`),
  check("intake_consultations_range_check", sql`${t.endsAt} > ${t.startsAt}`),
]);

/** A lawyer's external calendar connection (sync itself is vendor-gated: 'vendor.calendar_sync'). */
export const intakeCalendarConnections = pgTable("intake_calendar_connections", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  userId: uuid("user_id").notNull().references(() => users.id),
  /** 'microsoft' | 'google'. */
  provider: text("provider").notNull(),
  /** Reference into the secret store — never a token. */
  tokenRef: text("token_ref"),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  lastError: text("last_error"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("intake_calendar_connections_user_provider_key").on(t.tenantId, t.userId, t.provider),
  check("intake_calendar_connections_provider_check", sql`${t.provider} in ('microsoft','google')`),
]);

/** Free/busy blocks read from external calendars (never event contents, c67 rule 3). */
export const intakeBusyBlocks = pgTable("intake_busy_blocks", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  userId: uuid("user_id").notNull().references(() => users.id),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  provider: text("provider").notNull(),
  syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("intake_busy_blocks_user_idx").on(t.tenantId, t.userId, t.startsAt)]);

// ---------------------------------------------------------------------------
// c68 — prospect to open matter
// ---------------------------------------------------------------------------

/** Evidence recorded against each open-matter gate (engagement, fee arrangement, first payment). */
export const intakeOpenGateEvidence = pgTable("intake_open_gate_evidence", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  matterId: uuid("matter_id").notNull().references(() => matters.id),
  /** 'engagement_signed' | 'fee_arrangement' | 'first_payment'. */
  gate: text("gate").notNull(),
  /** 'met' | 'missing' | 'not_applicable'. */
  status: text("status").notNull(),
  /** e.g. 'document:<uuid>', 'payment:<ref>', 'attestation'. */
  evidenceRef: text("evidence_ref"),
  /** Fee arrangement details / payment amount (internal). */
  details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
  note: text("note"),
  recordedByUserId: uuid("recorded_by_user_id").references(() => users.id),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  supersededAt: timestamp("superseded_at", { withTimezone: true }),
}, (t) => [
  index("intake_open_gate_evidence_matter_idx").on(t.tenantId, t.matterId, t.gate),
  check("intake_open_gate_evidence_gate_check", sql`${t.gate} in ('engagement_signed','fee_arrangement','first_payment')`),
  check("intake_open_gate_evidence_status_check", sql`${t.status} in ('met','missing','not_applicable')`),
]);

export const intakeMatterOpenings = pgTable("intake_matter_openings", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  matterId: uuid("matter_id").notNull().references(() => matters.id),
  /** Proposed `matters.retained_at` (kept here because schema.ts is not editable by engines). */
  retainedAt: timestamp("retained_at", { withTimezone: true }).notNull(),
  openedByUserId: uuid("opened_by_user_id").notNull().references(() => users.id),
  gateEvidence: jsonb("gate_evidence").$type<Record<string, unknown>>().notNull(),
}, (t) => [uniqueIndex("intake_matter_openings_matter_key").on(t.tenantId, t.matterId)]);

export const intakeMatterHandoffs = pgTable("intake_matter_handoffs", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  matterId: uuid("matter_id").notNull().references(() => matters.id),
  /** Hand-off item key, e.g. 'party_index', 'portal_invite'. */
  item: text("item").notNull(),
  /** 'pending' | 'done' | 'requested' | 'failed' | 'blocked_pending_approval' | 'not_applicable'. */
  status: text("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  /** Shared task created for the owning engine / person, when the item is handed over that way. */
  taskId: uuid("task_id").references(() => tasks.id),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("intake_matter_handoffs_item_key").on(t.tenantId, t.matterId, t.item),
  check(
    "intake_matter_handoffs_status_check",
    sql`${t.status} in ('pending','done','requested','failed','blocked_pending_approval','not_applicable')`
  ),
]);

// ---------------------------------------------------------------------------
// c70 — follow-up sequences
// ---------------------------------------------------------------------------

export const intakeFollowUpRuns = pgTable("intake_follow_up_runs", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  intakeSessionId: uuid("intake_session_id").notNull().references(() => intakeSessions.id),
  /** 'abandoned_chat' | 'not_booked' | 'not_signed'. */
  trigger: text("trigger").notNull(),
  /** Number of steps sent so far. */
  stepsSent: integer("steps_sent").notNull().default(0),
  /** 'active' | 'completed' | 'stopped'. */
  status: text("status").notNull().default("active"),
  stoppedReason: text("stopped_reason"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
}, (t) => [
  // One active sequence per session (spec: one active sequence per person).
  uniqueIndex("intake_follow_up_runs_active_key").on(t.tenantId, t.intakeSessionId).where(sql`${t.status} = 'active'`),
  check("intake_follow_up_runs_trigger_check", sql`${t.trigger} in ('abandoned_chat','not_booked','not_signed')`),
  check("intake_follow_up_runs_status_check", sql`${t.status} in ('active','completed','stopped')`),
]);

// ---------------------------------------------------------------------------
// c73 — case acceptance rules
// ---------------------------------------------------------------------------

/** One versioned set of fit rules (shape validated in src/engines/intake/acceptance/rules.ts). */
export const intakeFitRuleSets = pgTable("intake_fit_rule_sets", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  version: integer("version").notNull(),
  rules: jsonb("rules").$type<Record<string, unknown>[]>().notNull(),
  effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull().defaultNow(),
  createdByUserId: uuid("created_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("intake_fit_rule_sets_tenant_version_key").on(t.tenantId, t.version),
  index("intake_fit_rule_sets_effective_idx").on(t.tenantId, t.effectiveFrom),
]);

export const intakeFitEvaluations = pgTable("intake_fit_evaluations", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  intakeSessionId: uuid("intake_session_id").notNull().references(() => intakeSessions.id),
  /** 'fit' | 'borderline' | 'no_fit'. */
  outcome: text("outcome").notNull(),
  ruleResults: jsonb("rule_results").$type<Record<string, unknown>[]>().notNull(),
  reasons: text("reasons").array().notNull().default(sql`'{}'::text[]`),
  confidence: real("confidence"),
  ruleSetId: uuid("rule_set_id").references(() => intakeFitRuleSets.id),
  ruleSetVersion: integer("rule_set_version"),
  /** Lawyer decision on a borderline case: 'accept' | 'decline' | 'more_info'. */
  decision: text("decision"),
  decidedByUserId: uuid("decided_by_user_id").references(() => users.id),
  decisionReason: text("decision_reason"),
  declineSentAt: timestamp("decline_sent_at", { withTimezone: true }),
  referralsShown: jsonb("referrals_shown").$type<Record<string, unknown>[]>().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("intake_fit_evaluations_session_idx").on(t.tenantId, t.intakeSessionId, t.createdAt),
  check("intake_fit_evaluations_outcome_check", sql`${t.outcome} in ('fit','borderline','no_fit')`),
  check("intake_fit_evaluations_decision_check", sql`${t.decision} is null or ${t.decision} in ('accept','decline','more_info')`),
  check(
    "intake_fit_evaluations_decision_reason_check",
    sql`${t.decision} is null or (${t.decisionReason} is not null and length(${t.decisionReason}) > 0)`
  ),
]);

export const intakeReferralDirectory = pgTable("intake_referral_directory", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  name: text("name").notNull(),
  practiceAreas: text("practice_areas").array().notNull().default(sql`'{}'::text[]`),
  counties: text("counties").array().notNull().default(sql`'{}'::text[]`),
  contact: text("contact").notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("intake_referral_directory_tenant_idx").on(t.tenantId, t.active)]);

// ---------------------------------------------------------------------------
// MIGRATION NOTES for the integration step (hand-add to the generated SQL):
//
// 1. RLS + tenant_isolation policy (same text as migrations/0000) on every
//    table in this file: intake_pipeline_versions, intake_matter_firm_stages,
//    intake_lawyer_profiles, intake_out_of_office, intake_assignment_blocks,
//    intake_matter_assignments, intake_session_state, intake_messages,
//    intake_consents, intake_referrals, intake_emergency_alerts,
//    intake_on_call_rota, intake_consultations, intake_calendar_connections,
//    intake_busy_blocks, intake_open_gate_evidence, intake_matter_openings,
//    intake_matter_handoffs, intake_follow_up_runs, intake_fit_rule_sets,
//    intake_fit_evaluations, intake_referral_directory.
// 2. GRANT SELECT, INSERT, UPDATE, DELETE ON all of the above TO app_runtime,
//    EXCEPT the history tables below.
// 3. Append-only history (c6): these are written once and never changed:
//    GRANT SELECT, INSERT ON intake_pipeline_versions, intake_fit_rule_sets,
//      intake_messages, intake_matter_openings TO app_runtime;
//    REVOKE UPDATE, DELETE ON the same four tables FROM app_runtime;
//    (intake_consents keeps UPDATE because withdrawn_at is set later.)
// 4. intake_matter_assignments: UPDATE is needed only to set ended_at;
//    optionally GRANT UPDATE (ended_at) only.
// ---------------------------------------------------------------------------
