ALTER TYPE "public"."party_role" ADD VALUE 'client';--> statement-breakpoint
ALTER TYPE "public"."party_role" ADD VALUE 'opposing_counsel';--> statement-breakpoint
ALTER TYPE "public"."party_role" ADD VALUE 'child';--> statement-breakpoint
ALTER TYPE "public"."party_role" ADD VALUE 'related_party';--> statement-breakpoint
ALTER TYPE "public"."party_role" ADD VALUE 'witness';--> statement-breakpoint
ALTER TYPE "public"."party_role" ADD VALUE 'expert';--> statement-breakpoint
ALTER TYPE "public"."party_role" ADD VALUE 'guardian_ad_litem';--> statement-breakpoint
ALTER TYPE "public"."party_role" ADD VALUE 'court';--> statement-breakpoint
ALTER TYPE "public"."party_role" ADD VALUE 'other';--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"engine" text NOT NULL,
	"action" text NOT NULL,
	"entity_type" text,
	"entity_id" uuid,
	"matter_id" uuid,
	"intake_session_id" uuid,
	"actor_type" text NOT NULL,
	"actor_user_id" uuid,
	"actor_party_id" uuid,
	"reason" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_events_actor_type_check" CHECK ("audit_events"."actor_type" in ('system','user','client','ai'))
);
--> statement-breakpoint
CREATE TABLE "calendar_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"matter_id" uuid,
	"event_type" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"all_day" boolean DEFAULT false NOT NULL,
	"location" text,
	"court_name" text,
	"cause_number" text,
	"is_deadline" boolean DEFAULT false NOT NULL,
	"source" text DEFAULT 'lawyer_entry' NOT NULL,
	"source_ref" text,
	"status" text DEFAULT 'proposed' NOT NULL,
	"confirmed_by_user_id" uuid,
	"confirmed_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"assigned_user_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"external_refs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_events_source_check" CHECK ("calendar_events"."source" in ('lawyer_entry','staff_entry','ai_suggestion','court_notice','deadline_calculator','consult_booking','external_sync','import')),
	CONSTRAINT "calendar_events_status_check" CHECK ("calendar_events"."status" in ('proposed','confirmed','cancelled')),
	CONSTRAINT "calendar_events_confirmed_by_check" CHECK ("calendar_events"."status" <> 'confirmed' or ("calendar_events"."confirmed_by_user_id" is not null and "calendar_events"."confirmed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "compliance_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"gate_key" text NOT NULL,
	"reviewer_kind" text NOT NULL,
	"approved_by_name" text NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notes" text,
	"approved_text" text,
	"draft_hash" text,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	CONSTRAINT "compliance_approvals_reviewer_kind_check" CHECK ("compliance_approvals"."reviewer_kind" in ('attorney','cpa','vendor_dpa','founder_decision'))
);
--> statement-breakpoint
CREATE TABLE "firm_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"time_zone" text DEFAULT 'America/Chicago' NOT NULL,
	"business_hours" jsonb DEFAULT '{"mon":[{"start":"09:00","end":"17:00"}],"tue":[{"start":"09:00","end":"17:00"}],"wed":[{"start":"09:00","end":"17:00"}],"thu":[{"start":"09:00","end":"17:00"}],"fri":[{"start":"09:00","end":"17:00"}]}'::jsonb NOT NULL,
	"holidays" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enabled_practice_areas" text[] DEFAULT '{family}'::text[] NOT NULL,
	"firm_reply_hours" integer DEFAULT 24 NOT NULL,
	"client_promise_hours" integer DEFAULT 48 NOT NULL,
	"deadline_question_flag_hours" integer DEFAULT 12 NOT NULL,
	"deadline_question_reply_hours" integer DEFAULT 24 NOT NULL,
	"client_response_window_hours" integer DEFAULT 48 NOT NULL,
	"due_soon_business_hours" integer DEFAULT 8 NOT NULL,
	"overdue_grace_business_hours" integer DEFAULT 8 NOT NULL,
	"court_notice_ack_minutes" integer DEFAULT 120 NOT NULL,
	"new_inquiry_response_minutes" integer DEFAULT 15 NOT NULL,
	"retainer_floor_cents" bigint DEFAULT 450000 NOT NULL,
	"retainer_warning_cents" bigint,
	"quiet_hours" jsonb,
	"internal_email_digest" boolean DEFAULT false NOT NULL,
	"email_from_name" text,
	"email_from_address" text,
	"email_reply_to" text,
	"client_portal_url" text,
	"engine_settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_user_id" uuid,
	CONSTRAINT "firm_settings_retainer_floor_check" CHECK ("firm_settings"."retainer_floor_cents" >= 0),
	CONSTRAINT "firm_settings_hours_positive_check" CHECK ("firm_settings"."firm_reply_hours" > 0 and "firm_settings"."client_promise_hours" > 0 and "firm_settings"."deadline_question_flag_hours" > 0 and "firm_settings"."deadline_question_reply_hours" > 0)
);
--> statement-breakpoint
CREATE TABLE "flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"type" text NOT NULL,
	"severity" text NOT NULL,
	"audience" text NOT NULL,
	"matter_id" uuid,
	"task_id" uuid,
	"title" text NOT NULL,
	"summary" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"client_copy_key" text,
	"recipient_user_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"recipient_party_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"dedupe_key" text,
	"urgent" boolean DEFAULT false NOT NULL,
	"sensitive" boolean DEFAULT false NOT NULL,
	"escalation_level" integer DEFAULT 0 NOT NULL,
	"last_escalated_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by_user_id" uuid,
	"raised_by_type" text DEFAULT 'system' NOT NULL,
	"raised_by_user_id" uuid,
	"source_card" text,
	"resolved_at" timestamp with time zone,
	"resolved_by_user_id" uuid,
	"resolution_reason" text,
	"check_back_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "flags_severity_check" CHECK ("flags"."severity" in ('info','warning','high','critical')),
	CONSTRAINT "flags_audience_check" CHECK ("flags"."audience" in ('internal','client','both')),
	CONSTRAINT "flags_internal_no_party_recipients_check" CHECK ("flags"."audience" <> 'internal' or cardinality("flags"."recipient_party_ids") = 0),
	CONSTRAINT "flags_resolution_reason_check" CHECK ("flags"."resolved_at" is null or ("flags"."resolution_reason" is not null and length("flags"."resolution_reason") > 0)),
	CONSTRAINT "flags_raised_by_type_check" CHECK ("flags"."raised_by_type" in ('system','user','client','ai'))
);
--> statement-breakpoint
CREATE TABLE "notification_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"recipient_type" text NOT NULL,
	"recipient_user_id" uuid,
	"recipient_party_id" uuid,
	"recipient_address" text,
	"template_key" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"matter_id" uuid,
	"flag_id" uuid,
	"urgent" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"not_before" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"provider" text,
	"provider_message_id" text,
	"dedupe_key" text,
	"read_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_outbox_channel_check" CHECK ("notification_outbox"."channel" in ('in_app','email','sms')),
	CONSTRAINT "notification_outbox_recipient_type_check" CHECK ("notification_outbox"."recipient_type" in ('user','party')),
	CONSTRAINT "notification_outbox_recipient_consistency_check" CHECK (("notification_outbox"."recipient_type" = 'user' and "notification_outbox"."recipient_user_id" is not null and "notification_outbox"."recipient_party_id" is null)
      or ("notification_outbox"."recipient_type" = 'party' and "notification_outbox"."recipient_party_id" is not null and "notification_outbox"."recipient_user_id" is null)),
	CONSTRAINT "notification_outbox_status_check" CHECK ("notification_outbox"."status" in ('pending','held','sent','delivered','bounced','failed','suppressed','cancelled'))
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"matter_id" uuid,
	"intake_session_id" uuid,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"owner_type" text NOT NULL,
	"owner_user_id" uuid,
	"owner_party_id" uuid,
	"supervisor_user_id" uuid,
	"due_at" timestamp with time zone NOT NULL,
	"uses_business_hours" boolean DEFAULT true NOT NULL,
	"deadline_critical" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"visibility" text DEFAULT 'internal' NOT NULL,
	"source_card" text,
	"source_ref" text,
	"related_calendar_event_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"completed_at" timestamp with time zone,
	"completed_by_user_id" uuid,
	"completed_by_party_id" uuid,
	"last_change_reason" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tasks_owner_type_check" CHECK ("tasks"."owner_type" in ('user','client','firm')),
	CONSTRAINT "tasks_owner_consistency_check" CHECK (("tasks"."owner_type" = 'user' and "tasks"."owner_user_id" is not null and "tasks"."owner_party_id" is null)
      or ("tasks"."owner_type" = 'client' and "tasks"."owner_party_id" is not null and "tasks"."owner_user_id" is null)
      or ("tasks"."owner_type" = 'firm' and "tasks"."owner_user_id" is null and "tasks"."owner_party_id" is null)),
	CONSTRAINT "tasks_status_check" CHECK ("tasks"."status" in ('open','done','cancelled')),
	CONSTRAINT "tasks_visibility_check" CHECK ("tasks"."visibility" in ('internal','client')),
	CONSTRAINT "tasks_client_visibility_check" CHECK ("tasks"."visibility" = 'internal' or "tasks"."owner_type" = 'client')
);
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "version_group_id" uuid;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "status" text DEFAULT 'draft' NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "privilege_tag" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "client_visible" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "uploaded_by_party_id" uuid;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "mime_type" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "size_bytes" bigint;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "sha256" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "matter_parties" ADD COLUMN "relationship" text;--> statement-breakpoint
ALTER TABLE "matter_parties" ADD COLUMN "is_adverse" boolean;--> statement-breakpoint
ALTER TABLE "matter_parties" ADD COLUMN "added_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "matter_parties" ADD COLUMN "ended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "kind" text DEFAULT 'person' NOT NULL;--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "aliases" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "normalized_aliases" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "emails" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "phones" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "parent_party_id" uuid;--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "safe_contact" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "dv_sensitive" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_matter_id_matters_id_fk" FOREIGN KEY ("matter_id") REFERENCES "public"."matters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_intake_session_id_intake_sessions_id_fk" FOREIGN KEY ("intake_session_id") REFERENCES "public"."intake_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_party_id_parties_id_fk" FOREIGN KEY ("actor_party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_matter_id_matters_id_fk" FOREIGN KEY ("matter_id") REFERENCES "public"."matters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_confirmed_by_user_id_users_id_fk" FOREIGN KEY ("confirmed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "firm_settings" ADD CONSTRAINT "firm_settings_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "firm_settings" ADD CONSTRAINT "firm_settings_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flags" ADD CONSTRAINT "flags_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flags" ADD CONSTRAINT "flags_matter_id_matters_id_fk" FOREIGN KEY ("matter_id") REFERENCES "public"."matters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flags" ADD CONSTRAINT "flags_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flags" ADD CONSTRAINT "flags_acknowledged_by_user_id_users_id_fk" FOREIGN KEY ("acknowledged_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flags" ADD CONSTRAINT "flags_raised_by_user_id_users_id_fk" FOREIGN KEY ("raised_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flags" ADD CONSTRAINT "flags_resolved_by_user_id_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_recipient_user_id_users_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_recipient_party_id_parties_id_fk" FOREIGN KEY ("recipient_party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_matter_id_matters_id_fk" FOREIGN KEY ("matter_id") REFERENCES "public"."matters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_flag_id_flags_id_fk" FOREIGN KEY ("flag_id") REFERENCES "public"."flags"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_matter_id_matters_id_fk" FOREIGN KEY ("matter_id") REFERENCES "public"."matters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_intake_session_id_intake_sessions_id_fk" FOREIGN KEY ("intake_session_id") REFERENCES "public"."intake_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_owner_party_id_parties_id_fk" FOREIGN KEY ("owner_party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_supervisor_user_id_users_id_fk" FOREIGN KEY ("supervisor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_related_calendar_event_id_calendar_events_id_fk" FOREIGN KEY ("related_calendar_event_id") REFERENCES "public"."calendar_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_completed_by_user_id_users_id_fk" FOREIGN KEY ("completed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_completed_by_party_id_parties_id_fk" FOREIGN KEY ("completed_by_party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_tenant_matter_idx" ON "audit_events" USING btree ("tenant_id","matter_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_events_tenant_entity_idx" ON "audit_events" USING btree ("tenant_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_events_tenant_occurred_idx" ON "audit_events" USING btree ("tenant_id","occurred_at");--> statement-breakpoint
CREATE INDEX "calendar_events_tenant_starts_idx" ON "calendar_events" USING btree ("tenant_id","starts_at");--> statement-breakpoint
CREATE INDEX "calendar_events_tenant_matter_idx" ON "calendar_events" USING btree ("tenant_id","matter_id","starts_at");--> statement-breakpoint
CREATE INDEX "compliance_approvals_gate_idx" ON "compliance_approvals" USING btree ("gate_key","reviewer_kind");--> statement-breakpoint
CREATE UNIQUE INDEX "firm_settings_tenant_key" ON "firm_settings" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "flags_tenant_open_idx" ON "flags" USING btree ("tenant_id","resolved_at","severity");--> statement-breakpoint
CREATE INDEX "flags_tenant_matter_idx" ON "flags" USING btree ("tenant_id","matter_id");--> statement-breakpoint
CREATE INDEX "flags_tenant_task_idx" ON "flags" USING btree ("tenant_id","task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "flags_open_dedupe_key" ON "flags" USING btree ("tenant_id","dedupe_key") WHERE "flags"."resolved_at" is null and "flags"."dedupe_key" is not null;--> statement-breakpoint
CREATE INDEX "notification_outbox_tenant_status_idx" ON "notification_outbox" USING btree ("tenant_id","status","not_before");--> statement-breakpoint
CREATE INDEX "notification_outbox_tenant_user_idx" ON "notification_outbox" USING btree ("tenant_id","recipient_user_id","channel");--> statement-breakpoint
CREATE INDEX "notification_outbox_tenant_party_idx" ON "notification_outbox" USING btree ("tenant_id","recipient_party_id","channel");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_outbox_dedupe_key" ON "notification_outbox" USING btree ("tenant_id","dedupe_key") WHERE "notification_outbox"."dedupe_key" is not null;--> statement-breakpoint
CREATE INDEX "tasks_tenant_status_due_idx" ON "tasks" USING btree ("tenant_id","status","due_at");--> statement-breakpoint
CREATE INDEX "tasks_tenant_matter_idx" ON "tasks" USING btree ("tenant_id","matter_id");--> statement-breakpoint
CREATE INDEX "tasks_tenant_owner_user_idx" ON "tasks" USING btree ("tenant_id","owner_user_id","status");--> statement-breakpoint
CREATE INDEX "tasks_tenant_owner_party_idx" ON "tasks" USING btree ("tenant_id","owner_party_id","status");--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_version_group_id_documents_id_fk" FOREIGN KEY ("version_group_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_uploaded_by_party_id_parties_id_fk" FOREIGN KEY ("uploaded_by_party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parties" ADD CONSTRAINT "parties_parent_party_id_parties_id_fk" FOREIGN KEY ("parent_party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "documents_tenant_matter_idx" ON "documents" USING btree ("tenant_id","matter_id");--> statement-breakpoint
CREATE INDEX "matter_parties_tenant_party_idx" ON "matter_parties" USING btree ("tenant_id","party_id");--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_status_check" CHECK ("documents"."status" in ('draft','uploaded','in_review','attorney_approved','client_review','client_approved','final','filed','superseded','archived'));--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_privilege_tag_check" CHECK ("documents"."privilege_tag" in ('none','privileged','work_product','confidential','sealed'));--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_version_check" CHECK ("documents"."version" >= 1);--> statement-breakpoint
ALTER TABLE "parties" ADD CONSTRAINT "parties_kind_check" CHECK ("parties"."kind" in ('person','organization'));--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- Hand-added (Drizzle's DSL does not express RLS or GRANTs). Implements the
-- MIGRATION NOTES at the bottom of src/db/tables/foundation.ts, using the
-- same tenant_isolation policy text as migrations/0000.
-- ---------------------------------------------------------------------------

ALTER TABLE "firm_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "calendar_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tasks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "flags" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "notification_outbox" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "compliance_approvals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY tenant_isolation ON "firm_settings" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "calendar_events" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "tasks" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "flags" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "notification_outbox" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "audit_events" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON
  "firm_settings", "calendar_events", "tasks", "flags", "notification_outbox"
  TO app_runtime;--> statement-breakpoint

-- audit_events is append-only (c6 §3).
GRANT SELECT, INSERT ON "audit_events" TO app_runtime;--> statement-breakpoint
REVOKE UPDATE, DELETE ON "audit_events" FROM app_runtime;--> statement-breakpoint

-- compliance_approvals is platform-level (not tenant-scoped): the app may only read it.
CREATE POLICY app_runtime_read ON "compliance_approvals" FOR SELECT TO app_runtime USING (true);--> statement-breakpoint
GRANT SELECT ON "compliance_approvals" TO app_runtime;--> statement-breakpoint
-- Supabase staging has ALTER DEFAULT PRIVILEGES granting app_runtime
-- SELECT/INSERT/UPDATE/DELETE on every new public table, so read-only must be
-- enforced explicitly (found when applying to staging on 2026-10-01).
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "compliance_approvals" FROM app_runtime;--> statement-breakpoint
REVOKE ALL ON "compliance_approvals" FROM anon, authenticated;--> statement-breakpoint

-- Same hardening 0001 applied to firms: Supabase grants anon/authenticated
-- default privileges on every new public table, and the app never uses that
-- REST path. RLS already blocks them (no policy matches), but revoke anyway.
REVOKE ALL ON "firm_settings", "calendar_events", "tasks", "flags", "notification_outbox", "audit_events" FROM anon, authenticated;
