CREATE TYPE "public"."conflict_outcome" AS ENUM('clear', 'possible', 'definite');--> statement-breakpoint
CREATE TYPE "public"."matter_stage" AS ENUM('prospective', 'consultation_scheduled', 'consult_completed_manual_follow_up', 'pending_review', 'did_not_schedule', 'did_not_hire_referred_out', 'declined_conflict', 'retained', 'closed');--> statement-breakpoint
CREATE TYPE "public"."party_role" AS ENUM('caller', 'opposing_party', 'co_party');--> statement-breakpoint
CREATE TYPE "public"."sensitivity_tier" AS ENUM('standard', 'sensitive');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('firm_admin', 'attorney', 'intake_staff', 'read_only', 'integration_service');--> statement-breakpoint
CREATE TABLE "conflict_check_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"intake_session_id" uuid NOT NULL,
	"role_sought" text NOT NULL,
	"outcome" "conflict_outcome" NOT NULL,
	"matched_party_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"matched_sources" jsonb NOT NULL,
	"firm_config_version_id" uuid NOT NULL,
	"resolved_by_user_id" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"matter_id" uuid NOT NULL,
	"document_type" text NOT NULL,
	"storage_key" text NOT NULL,
	"sensitivity_tier" "sensitivity_tier" DEFAULT 'standard' NOT NULL,
	"uploaded_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "firm_config_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"config" jsonb NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "firm_config_versions_tenant_version_key" UNIQUE("tenant_id","version")
);
--> statement-breakpoint
CREATE TABLE "firms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"status" text DEFAULT 'trial' NOT NULL,
	"is_production" boolean DEFAULT false NOT NULL,
	"data_region" text DEFAULT 'us' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "firms_slug_unique" UNIQUE("slug"),
	CONSTRAINT "firms_status_check" CHECK ("firms"."status" in ('trial','active','suspended','offboarded'))
);
--> statement-breakpoint
CREATE TABLE "intake_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"intake_session_id" uuid NOT NULL,
	"matter_id" uuid,
	"event_type" text NOT NULL,
	"rule_name" text,
	"actor_type" text NOT NULL,
	"actor_id" uuid,
	"payload" jsonb NOT NULL,
	"firm_config_version_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "intake_events_actor_type_check" CHECK ("intake_events"."actor_type" in ('system','user','caller'))
);
--> statement-breakpoint
CREATE TABLE "intake_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"matter_id" uuid,
	"current_node" text DEFAULT 'classify_caller' NOT NULL,
	"terminal_state" text,
	"language" text DEFAULT 'en' NOT NULL,
	"channel" text,
	"collected_answers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"firm_config_version_id" uuid NOT NULL,
	"classifier_output" jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "matter_parties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"matter_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"role" "party_role" NOT NULL,
	CONSTRAINT "matter_parties_matter_party_role_key" UNIQUE("matter_id","party_id","role")
);
--> statement-breakpoint
CREATE TABLE "matters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"primary_party_id" uuid NOT NULL,
	"practice_area" text,
	"stage" "matter_stage" DEFAULT 'prospective' NOT NULL,
	"assigned_user_id" uuid,
	"retention_years" integer,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"eligible_for_deletion_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"matter_id" uuid,
	"destination" text NOT NULL,
	"operation" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "outbox_status_check" CHECK ("outbox"."status" in ('pending','sent','failed','abandoned'))
);
--> statement-breakpoint
CREATE TABLE "parties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"full_name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"date_of_birth" text,
	"email" text,
	"phone" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scheduled_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"intake_session_id" uuid,
	"matter_id" uuid,
	"task_type" text NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone,
	"claimed_by_worker" text,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"role" "user_role" NOT NULL,
	"role_label" text,
	"mfa_enrolled" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"restricted_to_unassigned_matters" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_tenant_email_key" UNIQUE("tenant_id","email"),
	CONSTRAINT "users_status_check" CHECK ("users"."status" in ('active','invited','disabled'))
);
--> statement-breakpoint
ALTER TABLE "conflict_check_results" ADD CONSTRAINT "conflict_check_results_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conflict_check_results" ADD CONSTRAINT "conflict_check_results_intake_session_id_intake_sessions_id_fk" FOREIGN KEY ("intake_session_id") REFERENCES "public"."intake_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conflict_check_results" ADD CONSTRAINT "conflict_check_results_firm_config_version_id_firm_config_versions_id_fk" FOREIGN KEY ("firm_config_version_id") REFERENCES "public"."firm_config_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conflict_check_results" ADD CONSTRAINT "conflict_check_results_resolved_by_user_id_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_matter_id_matters_id_fk" FOREIGN KEY ("matter_id") REFERENCES "public"."matters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "firm_config_versions" ADD CONSTRAINT "firm_config_versions_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "firm_config_versions" ADD CONSTRAINT "firm_config_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_events" ADD CONSTRAINT "intake_events_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_events" ADD CONSTRAINT "intake_events_intake_session_id_intake_sessions_id_fk" FOREIGN KEY ("intake_session_id") REFERENCES "public"."intake_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_events" ADD CONSTRAINT "intake_events_matter_id_matters_id_fk" FOREIGN KEY ("matter_id") REFERENCES "public"."matters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_events" ADD CONSTRAINT "intake_events_firm_config_version_id_firm_config_versions_id_fk" FOREIGN KEY ("firm_config_version_id") REFERENCES "public"."firm_config_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_sessions" ADD CONSTRAINT "intake_sessions_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_sessions" ADD CONSTRAINT "intake_sessions_matter_id_matters_id_fk" FOREIGN KEY ("matter_id") REFERENCES "public"."matters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_sessions" ADD CONSTRAINT "intake_sessions_firm_config_version_id_firm_config_versions_id_fk" FOREIGN KEY ("firm_config_version_id") REFERENCES "public"."firm_config_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matter_parties" ADD CONSTRAINT "matter_parties_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matter_parties" ADD CONSTRAINT "matter_parties_matter_id_matters_id_fk" FOREIGN KEY ("matter_id") REFERENCES "public"."matters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matter_parties" ADD CONSTRAINT "matter_parties_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matters" ADD CONSTRAINT "matters_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matters" ADD CONSTRAINT "matters_primary_party_id_parties_id_fk" FOREIGN KEY ("primary_party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matters" ADD CONSTRAINT "matters_assigned_user_id_users_id_fk" FOREIGN KEY ("assigned_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_matter_id_matters_id_fk" FOREIGN KEY ("matter_id") REFERENCES "public"."matters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parties" ADD CONSTRAINT "parties_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ADD CONSTRAINT "scheduled_tasks_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ADD CONSTRAINT "scheduled_tasks_intake_session_id_intake_sessions_id_fk" FOREIGN KEY ("intake_session_id") REFERENCES "public"."intake_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ADD CONSTRAINT "scheduled_tasks_matter_id_matters_id_fk" FOREIGN KEY ("matter_id") REFERENCES "public"."matters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "firm_config_versions_tenant_effective_idx" ON "firm_config_versions" USING btree ("tenant_id","effective_from");--> statement-breakpoint
CREATE INDEX "intake_events_session_idx" ON "intake_events" USING btree ("tenant_id","intake_session_id","occurred_at");--> statement-breakpoint
CREATE INDEX "intake_events_matter_idx" ON "intake_events" USING btree ("tenant_id","matter_id","occurred_at");--> statement-breakpoint
CREATE INDEX "intake_sessions_inflight_idx" ON "intake_sessions" USING btree ("tenant_id","terminal_state");--> statement-breakpoint
CREATE INDEX "matters_tenant_stage_idx" ON "matters" USING btree ("tenant_id","stage");--> statement-breakpoint
CREATE INDEX "matters_tenant_deletion_idx" ON "matters" USING btree ("tenant_id","eligible_for_deletion_at");--> statement-breakpoint
CREATE INDEX "outbox_status_idx" ON "outbox" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "parties_tenant_normalized_name_idx" ON "parties" USING btree ("tenant_id","normalized_name");--> statement-breakpoint
CREATE INDEX "scheduled_tasks_due_idx" ON "scheduled_tasks" USING btree ("due_at");--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- matters.eligible_for_deletion_at (c19 §4.2) — trigger-maintained, not a
-- Postgres GENERATED column. `timestamptz + interval` is only STABLE, not
-- IMMUTABLE (its result depends on the session timezone), and Postgres
-- requires IMMUTABLE for GENERATED ALWAYS AS — confirmed empirically while
-- building this migration, not assumed. A BEFORE INSERT/UPDATE trigger
-- gives the same "one place this logic lives" guarantee instead.
-- ---------------------------------------------------------------------------

CREATE FUNCTION matters_set_eligible_for_deletion() RETURNS trigger AS $$
BEGIN
  IF NEW.closed_at IS NOT NULL AND NEW.retention_years IS NOT NULL THEN
    NEW.eligible_for_deletion_at := NEW.closed_at + (NEW.retention_years || ' years')::interval;
  ELSE
    NEW.eligible_for_deletion_at := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER matters_eligible_for_deletion_trigger
  BEFORE INSERT OR UPDATE OF closed_at, retention_years ON "matters"
  FOR EACH ROW EXECUTE FUNCTION matters_set_eligible_for_deletion();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Row-Level Security (ADR-0001 §D5, docs/architecture/core-data-model-schema-design.md §1)
-- Applied here by hand: Drizzle's schema DSL does not express RLS policies.
-- Every tenant-scoped table gets the same policy shape. `firms` is excluded
-- deliberately — it is the tenant root, not itself tenant-scoped.
-- ---------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS pgcrypto;--> statement-breakpoint

ALTER TABLE "firm_config_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "parties" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "matters" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "matter_parties" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "conflict_check_results" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "documents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "intake_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "intake_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "outbox" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY tenant_isolation ON "firm_config_versions" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "users" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "parties" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "matters" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "matter_parties" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "conflict_check_results" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "documents" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "intake_sessions" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "intake_events" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "scheduled_tasks" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "outbox" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON
  "firms", "firm_config_versions", "users", "parties", "matters", "matter_parties",
  "conflict_check_results", "documents", "intake_sessions", "scheduled_tasks", "outbox"
  TO app_runtime;--> statement-breakpoint

GRANT SELECT, INSERT ON "intake_events" TO app_runtime;--> statement-breakpoint
REVOKE UPDATE, DELETE ON "intake_events" FROM app_runtime;
