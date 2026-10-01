CREATE TABLE "conflict_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"intake_session_id" uuid,
	"matter_id" uuid,
	"lateral_check_id" uuid,
	"interest_disclosure_id" uuid,
	"affected_matter_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"legacy_result_id" uuid,
	"triggered_by_user_id" uuid,
	"role_sought" text,
	"searched_names" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"hits" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"outcome" text NOT NULL,
	"outcome_reasons" text[] DEFAULT '{}'::text[] NOT NULL,
	"rule_table_applied" boolean DEFAULT false NOT NULL,
	"role_evaluation" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text NOT NULL,
	"decision_task_id" uuid,
	"assigned_user_id" uuid,
	"due_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "conflict_checks_trigger_check" CHECK ("conflict_checks"."trigger" in ('intake','party_added','reopened','lateral_hire','periodic','interest','manual')),
	CONSTRAINT "conflict_checks_outcome_check" CHECK ("conflict_checks"."outcome" in ('clear','possible','definite')),
	CONSTRAINT "conflict_checks_status_check" CHECK ("conflict_checks"."status" in ('open','decided','superseded','not_required')),
	CONSTRAINT "conflict_checks_clear_has_no_hits_check" CHECK ("conflict_checks"."outcome" <> 'clear' or jsonb_array_length("conflict_checks"."hits") = 0)
);
--> statement-breakpoint
CREATE TABLE "conflict_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"check_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"reason_code" text NOT NULL,
	"reason_text" text,
	"rule_table_refs" text[] DEFAULT '{}'::text[] NOT NULL,
	"override_flag" boolean DEFAULT false NOT NULL,
	"consent_party_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"screened_user_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"decided_by_user_id" uuid NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	"supersedes_decision_id" uuid,
	CONSTRAINT "conflict_decisions_decision_check" CHECK ("conflict_decisions"."decision" in ('cleared','proceed_with_consent','proceed_with_screen','declined')),
	CONSTRAINT "conflict_decisions_reason_check" CHECK (length("conflict_decisions"."reason_code") > 0),
	CONSTRAINT "conflict_decisions_consent_parties_check" CHECK ("conflict_decisions"."decision" <> 'proceed_with_consent' or cardinality("conflict_decisions"."consent_party_ids") > 0),
	CONSTRAINT "conflict_decisions_screen_users_check" CHECK ("conflict_decisions"."decision" <> 'proceed_with_screen' or cardinality("conflict_decisions"."screened_user_ids") > 0)
);
--> statement-breakpoint
CREATE TABLE "conflict_exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"requested_by_user_id" uuid NOT NULL,
	"filter" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"format" text NOT NULL,
	"redaction_level" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"content" text,
	"row_count" integer,
	"error" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"generated_at" timestamp with time zone,
	CONSTRAINT "conflict_exports_format_check" CHECK ("conflict_exports"."format" in ('csv','json')),
	CONSTRAINT "conflict_exports_redaction_check" CHECK ("conflict_exports"."redaction_level" in ('full','summary')),
	CONSTRAINT "conflict_exports_status_check" CHECK ("conflict_exports"."status" in ('queued','ready','failed','blocked'))
);
--> statement-breakpoint
CREATE TABLE "conflict_gates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"state" text NOT NULL,
	"closed_reason" text,
	"check_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conflict_gates_subject_type_check" CHECK ("conflict_gates"."subject_type" in ('intake_session','matter')),
	CONSTRAINT "conflict_gates_state_check" CHECK ("conflict_gates"."state" in ('open','closed')),
	CONSTRAINT "conflict_gates_reason_check" CHECK ("conflict_gates"."state" = 'open' or "conflict_gates"."closed_reason" is not null)
);
--> statement-breakpoint
CREATE TABLE "conflict_import_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"format" text DEFAULT 'csv' NOT NULL,
	"status" text DEFAULT 'validated' NOT NULL,
	"column_map" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"total_rows" integer DEFAULT 0 NOT NULL,
	"valid_rows" integer DEFAULT 0 NOT NULL,
	"error_rows" integer DEFAULT 0 NOT NULL,
	"duplicate_rows" integer DEFAULT 0 NOT NULL,
	"parties_created" integer DEFAULT 0 NOT NULL,
	"matters_created" integer DEFAULT 0 NOT NULL,
	"merge_suggestions" integer DEFAULT 0 NOT NULL,
	"sha256" text NOT NULL,
	"uploaded_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"committed_at" timestamp with time zone,
	"committed_by_user_id" uuid,
	"discarded_at" timestamp with time zone,
	CONSTRAINT "conflict_import_batches_status_check" CHECK ("conflict_import_batches"."status" in ('validated','committed','discarded')),
	CONSTRAINT "conflict_import_batches_format_check" CHECK ("conflict_import_batches"."format" in ('csv'))
);
--> statement-breakpoint
CREATE TABLE "conflict_import_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"record" jsonb NOT NULL,
	"status" text NOT NULL,
	"errors" text[] DEFAULT '{}'::text[] NOT NULL,
	"warnings" text[] DEFAULT '{}'::text[] NOT NULL,
	"duplicate_of_line" integer,
	"party_id" uuid,
	CONSTRAINT "conflict_import_rows_status_check" CHECK ("conflict_import_rows"."status" in ('valid','error','duplicate','imported','failed'))
);
--> statement-breakpoint
CREATE TABLE "conflict_matter_watch" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"matter_id" uuid NOT NULL,
	"last_stage" text NOT NULL,
	"last_closed_at" timestamp with time zone,
	"last_reopen_check_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conflict_role_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"designated" boolean DEFAULT false NOT NULL,
	"backup" boolean DEFAULT false NOT NULL,
	"granted_by_user_id" uuid,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	CONSTRAINT "conflict_role_grants_role_check" CHECK ("conflict_role_grants"."role" in ('conflicts_attorney','conflicts_staff')),
	CONSTRAINT "conflict_role_grants_designated_attorney_check" CHECK (not "conflict_role_grants"."designated" or "conflict_role_grants"."role" = 'conflicts_attorney')
);
--> statement-breakpoint
CREATE TABLE "conflict_screens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"decision_id" uuid NOT NULL,
	"check_id" uuid NOT NULL,
	"screened_user_id" uuid NOT NULL,
	"matter_id" uuid,
	"intake_session_id" uuid,
	"reason" text NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"activated_at" timestamp with time zone,
	"activated_by_user_id" uuid,
	"notice_sent_at" timestamp with time zone,
	"lifted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conflict_screens_status_check" CHECK ("conflict_screens"."status" in ('requested','active','lifted'))
);
--> statement-breakpoint
CREATE TABLE "conflict_sync_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"baseline_at" timestamp with time zone NOT NULL,
	"matter_parties_cursor" timestamp with time zone NOT NULL,
	"matter_parties_cursor_id" uuid,
	"last_run_at" timestamp with time zone,
	"maintenance_queued_at" timestamp with time zone,
	"recheck_cursor" timestamp with time zone,
	"recheck_cursor_id" uuid,
	"match_keys_cursor" timestamp with time zone,
	"match_keys_cursor_id" uuid
);
--> statement-breakpoint
CREATE TABLE "conflict_waivers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"decision_id" uuid NOT NULL,
	"check_id" uuid NOT NULL,
	"client_party_id" uuid NOT NULL,
	"document_id" uuid,
	"status" text DEFAULT 'draft' NOT NULL,
	"approved_by_user_id" uuid,
	"approved_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"due_at" timestamp with time zone,
	"outer_limit_at" timestamp with time zone,
	"signed_at" timestamp with time zone,
	"countersign_required" boolean DEFAULT true NOT NULL,
	"countersigned_at" timestamp with time zone,
	"countersigned_by_user_id" uuid,
	"refused_at" timestamp with time zone,
	"last_reminder_at" timestamp with time zone,
	"provider_ref" text,
	"hold_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conflict_waivers_status_check" CHECK ("conflict_waivers"."status" in ('draft','approved','sent','signed','refused','expired','cancelled')),
	CONSTRAINT "conflict_waivers_signed_check" CHECK ("conflict_waivers"."status" <> 'signed' or "conflict_waivers"."signed_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "imported_involvements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"imported_matter_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"role" text NOT NULL,
	"relationship" text,
	"is_adverse" boolean,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "imported_matters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"external_ref" text NOT NULL,
	"kind" text NOT NULL,
	"title" text,
	"practice_area" text,
	"status" text NOT NULL,
	"opened_on" text,
	"closed_on" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "imported_matters_kind_check" CHECK ("imported_matters"."kind" in ('matter','consultation')),
	CONSTRAINT "imported_matters_status_check" CHECK ("imported_matters"."status" in ('current','former','prospective'))
);
--> statement-breakpoint
CREATE TABLE "inquiry_parties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"intake_session_id" uuid NOT NULL,
	"party_id" uuid,
	"role" text NOT NULL,
	"relationship" text,
	"name_unknown" boolean DEFAULT false NOT NULL,
	"name_completeness" text DEFAULT 'full' NOT NULL,
	"status" text DEFAULT 'current' NOT NULL,
	"spoke_with_user_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "inquiry_parties_role_check" CHECK ("inquiry_parties"."role" in ('prospective_client','opposing_party','related_party','co_party','opposing_counsel','insurer','co_defendant','other')),
	CONSTRAINT "inquiry_parties_status_check" CHECK ("inquiry_parties"."status" in ('current','former')),
	CONSTRAINT "inquiry_parties_completeness_check" CHECK ("inquiry_parties"."name_completeness" in ('full','partial')),
	CONSTRAINT "inquiry_parties_unknown_check" CHECK ("inquiry_parties"."name_unknown" or "inquiry_parties"."party_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "interest_disclosure_confirmations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"confirmed_at" timestamp with time zone,
	"next_due_at" timestamp with time zone NOT NULL,
	"reminder_task_id" uuid
);
--> statement-breakpoint
CREATE TABLE "interest_disclosures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"interest_type" text NOT NULL,
	"name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"relationship" text NOT NULL,
	"identifiers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"starts_on" text,
	"ends_on" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "interest_disclosures_type_check" CHECK ("interest_disclosures"."interest_type" in ('business','family','other'))
);
--> statement-breakpoint
CREATE TABLE "lateral_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"start_date" text NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'awaiting_list' NOT NULL,
	"former_firm_names" text[] DEFAULT '{}'::text[] NOT NULL,
	"attested_at" timestamp with time zone,
	"no_prior_employment_attested_by_user_id" uuid,
	"completed_at" timestamp with time zone,
	"hire_departed_at" timestamp with time zone,
	"start_date_flagged_at" timestamp with time zone,
	"submit_task_id" uuid,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lateral_checks_status_check" CHECK ("lateral_checks"."status" in ('awaiting_list','checking','awaiting_decisions','complete','no_prior_employment'))
);
--> statement-breakpoint
CREATE TABLE "lateral_prior_matters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"lateral_check_id" uuid NOT NULL,
	"former_firm_name" text,
	"client_names" text[] DEFAULT '{}'::text[] NOT NULL,
	"adverse_party_names" text[] DEFAULT '{}'::text[] NOT NULL,
	"normalized_names" text[] DEFAULT '{}'::text[] NOT NULL,
	"subject_category" text NOT NULL,
	"subject_note" text,
	"role" text NOT NULL,
	"from_year" integer,
	"to_year" integer,
	"still_open_known" boolean,
	"added_after_start" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lateral_prior_matters_role_check" CHECK ("lateral_prior_matters"."role" in ('lawyer','staff'))
);
--> statement-breakpoint
CREATE TABLE "non_engagement_letters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"intake_session_id" uuid,
	"matter_id" uuid,
	"prospect_party_id" uuid NOT NULL,
	"check_id" uuid,
	"decline_type" text NOT NULL,
	"reviewing_user_id" uuid,
	"status" text DEFAULT 'awaiting_approval' NOT NULL,
	"template_hash" text,
	"referral_included" boolean DEFAULT false NOT NULL,
	"referral_name" text,
	"body" text,
	"approved_by_user_id" uuid,
	"approved_at" timestamp with time zone,
	"auto_approved" boolean DEFAULT false NOT NULL,
	"channel" text,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"bounced_at" timestamp with time zone,
	"document_id" uuid,
	"task_id" uuid,
	"contact_date" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "non_engagement_letters_decline_type_check" CHECK ("non_engagement_letters"."decline_type" in ('conflict','not_eligible','out_of_scope','firm_choice','did_not_hire')),
	CONSTRAINT "non_engagement_letters_status_check" CHECK ("non_engagement_letters"."status" in ('awaiting_approval','approved','sent','delivered','bounced','no_channel','cancelled')),
	CONSTRAINT "non_engagement_letters_channel_check" CHECK ("non_engagement_letters"."channel" is null or "non_engagement_letters"."channel" in ('portal','email','postal')),
	CONSTRAINT "non_engagement_letters_approved_check" CHECK ("non_engagement_letters"."status" in ('awaiting_approval','cancelled') or "non_engagement_letters"."approved_by_user_id" is not null or "non_engagement_letters"."auto_approved"),
	CONSTRAINT "non_engagement_letters_conflict_individual_check" CHECK (not ("non_engagement_letters"."auto_approved" and "non_engagement_letters"."decline_type" = 'conflict'))
);
--> statement-breakpoint
CREATE TABLE "party_addresses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"address" text NOT NULL,
	"normalized_address" text NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "party_addresses_source_check" CHECK ("party_addresses"."source" in ('intake','matter','document','import','manual'))
);
--> statement-breakpoint
CREATE TABLE "party_match_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "party_merge_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"party_a_id" uuid NOT NULL,
	"party_b_id" uuid NOT NULL,
	"score" real NOT NULL,
	"reasons" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "party_merge_suggestions_status_check" CHECK ("party_merge_suggestions"."status" in ('open','confirmed','rejected')),
	CONSTRAINT "party_merge_suggestions_order_check" CHECK ("party_merge_suggestions"."party_a_id" < "party_merge_suggestions"."party_b_id")
);
--> statement-breakpoint
CREATE TABLE "party_merges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"survivor_party_id" uuid NOT NULL,
	"merged_party_id" uuid NOT NULL,
	"suggestion_id" uuid,
	"merged_by_user_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"undone_at" timestamp with time zone,
	"undone_by_user_id" uuid,
	"undo_reason" text,
	CONSTRAINT "party_merges_not_self_check" CHECK ("party_merges"."survivor_party_id" <> "party_merges"."merged_party_id"),
	CONSTRAINT "party_merges_reason_check" CHECK (length("party_merges"."reason") > 0)
);
--> statement-breakpoint
CREATE TABLE "party_name_variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"name_type" text NOT NULL,
	"source" text NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "party_name_variants_type_check" CHECK ("party_name_variants"."name_type" in ('legal','alias','former','maiden','married','nickname','business','dba')),
	CONSTRAINT "party_name_variants_source_check" CHECK ("party_name_variants"."source" in ('intake','matter','document','import','manual'))
);
--> statement-breakpoint
CREATE TABLE "party_org_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"parent_party_id" uuid NOT NULL,
	"child_party_id" uuid NOT NULL,
	"link_type" text NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "party_org_links_type_check" CHECK ("party_org_links"."link_type" in ('parent_subsidiary','affiliate')),
	CONSTRAINT "party_org_links_not_self_check" CHECK ("party_org_links"."parent_party_id" <> "party_org_links"."child_party_id")
);
--> statement-breakpoint
CREATE TABLE "party_retention_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"request_note" text,
	"status" text DEFAULT 'open' NOT NULL,
	"legal_basis" text,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	CONSTRAINT "party_retention_requests_status_check" CHECK ("party_retention_requests"."status" in ('open','kept_minimal','removed')),
	CONSTRAINT "party_retention_requests_decided_check" CHECK ("party_retention_requests"."status" = 'open' or ("party_retention_requests"."decided_by_user_id" is not null and "party_retention_requests"."legal_basis" is not null))
);
--> statement-breakpoint
CREATE TABLE "intake_assignment_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"matter_id" uuid,
	"party_id" uuid,
	"reason" text NOT NULL,
	"note" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "intake_assignment_blocks_reason_check" CHECK ("intake_assignment_blocks"."reason" in ('screened','restricted','other')),
	CONSTRAINT "intake_assignment_blocks_target_check" CHECK ("intake_assignment_blocks"."matter_id" is not null or "intake_assignment_blocks"."party_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "intake_busy_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"provider" text NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "intake_calendar_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"token_ref" text,
	"last_synced_at" timestamp with time zone,
	"last_error" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "intake_calendar_connections_provider_check" CHECK ("intake_calendar_connections"."provider" in ('microsoft','google'))
);
--> statement-breakpoint
CREATE TABLE "intake_consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"intake_session_id" uuid NOT NULL,
	"party_id" uuid,
	"consent_type" text NOT NULL,
	"channel" text NOT NULL,
	"text_gate_key" text,
	"text_version" text,
	"given" boolean NOT NULL,
	"recorded_by_user_id" uuid,
	"given_at" timestamp with time zone DEFAULT now() NOT NULL,
	"withdrawn_at" timestamp with time zone,
	CONSTRAINT "intake_consents_type_check" CHECK ("intake_consents"."consent_type" in ('disclosures','recording','sms','ai_disclosure','safe_contact'))
);
--> statement-breakpoint
CREATE TABLE "intake_consultations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"intake_session_id" uuid NOT NULL,
	"matter_id" uuid,
	"party_id" uuid,
	"lawyer_user_id" uuid NOT NULL,
	"meeting_type" text DEFAULT 'initial_meeting' NOT NULL,
	"format" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"hold_expires_at" timestamp with time zone,
	"outcome" text,
	"outcome_note" text,
	"calendar_event_id" uuid,
	"external_event_id" text,
	"video_link" text,
	"fee_cents" bigint,
	"payment_status" text DEFAULT 'not_required' NOT NULL,
	"rebook_offered_at" timestamp with time zone,
	"previous_consultation_id" uuid,
	"cancel_reason" text,
	"booked_by_type" text DEFAULT 'client' NOT NULL,
	"booked_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "intake_consultations_meeting_type_check" CHECK ("intake_consultations"."meeting_type" in ('initial_meeting','paid_consult')),
	CONSTRAINT "intake_consultations_format_check" CHECK ("intake_consultations"."format" in ('video','phone','in_person')),
	CONSTRAINT "intake_consultations_status_check" CHECK ("intake_consultations"."status" in ('held','booked','rescheduled','cancelled','no_show','completed','expired','on_hold')),
	CONSTRAINT "intake_consultations_outcome_check" CHECK ("intake_consultations"."outcome" is null or "intake_consultations"."outcome" in ('retain_offered','needs_follow_up','declined_by_firm','client_declined')),
	CONSTRAINT "intake_consultations_payment_check" CHECK ("intake_consultations"."payment_status" in ('not_required','outside_system','pending','paid','blocked_pending_review')),
	CONSTRAINT "intake_consultations_booked_by_check" CHECK ("intake_consultations"."booked_by_type" in ('client','user')),
	CONSTRAINT "intake_consultations_range_check" CHECK ("intake_consultations"."ends_at" > "intake_consultations"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "intake_emergency_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"intake_session_id" uuid NOT NULL,
	"matter_id" uuid,
	"track" text NOT NULL,
	"category" text NOT NULL,
	"detector" text NOT NULL,
	"matched_phrase" text,
	"flag_id" uuid,
	"raised_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acknowledged_by_user_id" uuid,
	"acknowledged_at" timestamp with time zone,
	"escalation_step" integer DEFAULT 0 NOT NULL,
	"paged_user_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"downgraded_by_user_id" uuid,
	"downgraded_at" timestamp with time zone,
	"downgrade_reason" text,
	CONSTRAINT "intake_emergency_alerts_track_check" CHECK ("intake_emergency_alerts"."track" in ('safety','urgent_legal','deadline_risk')),
	CONSTRAINT "intake_emergency_alerts_detector_check" CHECK ("intake_emergency_alerts"."detector" in ('keyword','classifier','staff')),
	CONSTRAINT "intake_emergency_alerts_downgrade_reason_check" CHECK ("intake_emergency_alerts"."downgraded_at" is null or ("intake_emergency_alerts"."downgrade_reason" is not null and length("intake_emergency_alerts"."downgrade_reason") > 0))
);
--> statement-breakpoint
CREATE TABLE "intake_fit_evaluations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"intake_session_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"rule_results" jsonb NOT NULL,
	"reasons" text[] DEFAULT '{}'::text[] NOT NULL,
	"confidence" real,
	"rule_set_id" uuid,
	"rule_set_version" integer,
	"decision" text,
	"decided_by_user_id" uuid,
	"decision_reason" text,
	"decline_sent_at" timestamp with time zone,
	"referrals_shown" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "intake_fit_evaluations_outcome_check" CHECK ("intake_fit_evaluations"."outcome" in ('fit','borderline','no_fit')),
	CONSTRAINT "intake_fit_evaluations_decision_check" CHECK ("intake_fit_evaluations"."decision" is null or "intake_fit_evaluations"."decision" in ('accept','decline','more_info')),
	CONSTRAINT "intake_fit_evaluations_decision_reason_check" CHECK ("intake_fit_evaluations"."decision" is null or ("intake_fit_evaluations"."decision_reason" is not null and length("intake_fit_evaluations"."decision_reason") > 0))
);
--> statement-breakpoint
CREATE TABLE "intake_fit_rule_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"rules" jsonb NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "intake_follow_up_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"intake_session_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"steps_sent" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"stopped_reason" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "intake_follow_up_runs_trigger_check" CHECK ("intake_follow_up_runs"."trigger" in ('abandoned_chat','not_booked','not_signed')),
	CONSTRAINT "intake_follow_up_runs_status_check" CHECK ("intake_follow_up_runs"."status" in ('active','completed','stopped'))
);
--> statement-breakpoint
CREATE TABLE "intake_lawyer_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"practice_areas" text[] DEFAULT '{}'::text[] NOT NULL,
	"languages" text[] DEFAULT '{en}'::text[] NOT NULL,
	"counties" text[] DEFAULT '{}'::text[] NOT NULL,
	"seniority" integer DEFAULT 1 NOT NULL,
	"weekly_new_matter_cap" integer,
	"accepts_new_matters" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "intake_lawyer_profiles_seniority_check" CHECK ("intake_lawyer_profiles"."seniority" between 1 and 5)
);
--> statement-breakpoint
CREATE TABLE "intake_matter_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"matter_id" uuid NOT NULL,
	"assignee_user_id" uuid,
	"method" text NOT NULL,
	"score_breakdown" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reason" text,
	"assigned_by_user_id" uuid,
	"settings_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "intake_matter_assignments_method_check" CHECK ("intake_matter_assignments"."method" in ('auto','override','manual','unassigned')),
	CONSTRAINT "intake_matter_assignments_override_reason_check" CHECK ("intake_matter_assignments"."method" <> 'override' or ("intake_matter_assignments"."reason" is not null and length("intake_matter_assignments"."reason") > 0))
);
--> statement-breakpoint
CREATE TABLE "intake_matter_firm_stages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"matter_id" uuid NOT NULL,
	"firm_stage_key" text NOT NULL,
	"pipeline_version" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "intake_matter_handoffs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"matter_id" uuid NOT NULL,
	"item" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"task_id" uuid,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "intake_matter_handoffs_status_check" CHECK ("intake_matter_handoffs"."status" in ('pending','done','requested','failed','blocked_pending_approval','not_applicable'))
);
--> statement-breakpoint
CREATE TABLE "intake_matter_openings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"matter_id" uuid NOT NULL,
	"retained_at" timestamp with time zone NOT NULL,
	"opened_by_user_id" uuid NOT NULL,
	"gate_evidence" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "intake_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"intake_session_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"channel" text NOT NULL,
	"author_type" text NOT NULL,
	"author_user_id" uuid,
	"body" text NOT NULL,
	"copy_gate_key" text,
	"delivery_status" text NOT NULL,
	"delivery_detail" text,
	"vendor_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "intake_messages_direction_check" CHECK ("intake_messages"."direction" in ('inbound','outbound')),
	CONSTRAINT "intake_messages_author_check" CHECK ("intake_messages"."author_type" in ('caller','ai','staff','system')),
	CONSTRAINT "intake_messages_status_check" CHECK ("intake_messages"."delivery_status" in ('received','shown','held','sent','failed','suppressed'))
);
--> statement-breakpoint
CREATE TABLE "intake_on_call_rota" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"weekday" text,
	"start_time" text,
	"end_time" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "intake_on_call_rota_role_check" CHECK ("intake_on_call_rota"."role" in ('primary','backup','staff')),
	CONSTRAINT "intake_on_call_rota_shape_check" CHECK (("intake_on_call_rota"."starts_at" is not null and "intake_on_call_rota"."ends_at" is not null and "intake_on_call_rota"."weekday" is null)
      or ("intake_on_call_rota"."weekday" in ('mon','tue','wed','thu','fri','sat','sun') and "intake_on_call_rota"."start_time" is not null and "intake_on_call_rota"."end_time" is not null and "intake_on_call_rota"."starts_at" is null))
);
--> statement-breakpoint
CREATE TABLE "intake_open_gate_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"matter_id" uuid NOT NULL,
	"gate" text NOT NULL,
	"status" text NOT NULL,
	"evidence_ref" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"note" text,
	"recorded_by_user_id" uuid,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_at" timestamp with time zone,
	CONSTRAINT "intake_open_gate_evidence_gate_check" CHECK ("intake_open_gate_evidence"."gate" in ('engagement_signed','fee_arrangement','first_payment')),
	CONSTRAINT "intake_open_gate_evidence_status_check" CHECK ("intake_open_gate_evidence"."status" in ('met','missing','not_applicable'))
);
--> statement-breakpoint
CREATE TABLE "intake_out_of_office" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "intake_out_of_office_range_check" CHECK ("intake_out_of_office"."ends_at" > "intake_out_of_office"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "intake_pipeline_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"stages" jsonb NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "intake_referral_directory" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"practice_areas" text[] DEFAULT '{}'::text[] NOT NULL,
	"counties" text[] DEFAULT '{}'::text[] NOT NULL,
	"contact" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "intake_referrals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"intake_session_id" uuid NOT NULL,
	"referrer_type" text NOT NULL,
	"referrer_user_id" uuid,
	"referrer_party_id" uuid,
	"referrer_name" text,
	"notes" text,
	"activated_at" timestamp with time zone,
	"activation_reason" text,
	"recorded_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "intake_referrals_type_check" CHECK ("intake_referrals"."referrer_type" in ('lawyer','client','other'))
);
--> statement-breakpoint
CREATE TABLE "intake_session_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"intake_session_id" uuid NOT NULL,
	"party_id" uuid,
	"channel" text NOT NULL,
	"external_thread_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"disclosures_acknowledged_at" timestamp with time zone,
	"conflict_minimum" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"conflict_check_requested_at" timestamp with time zone,
	"unsolicited_details_received" boolean DEFAULT false NOT NULL,
	"recording_state" text DEFAULT 'not_applicable' NOT NULL,
	"safety_flagged" boolean DEFAULT false NOT NULL,
	"safe_contact_confirmed_at" timestamp with time zone,
	"emergency_unacknowledged" boolean DEFAULT false NOT NULL,
	"response_clock_started_at" timestamp with time zone,
	"response_target_at" timestamp with time zone,
	"response_task_id" uuid,
	"first_human_contact_at" timestamp with time zone,
	"first_human_contact_by_user_id" uuid,
	"response_outcome" text,
	"follow_up_stopped_at" timestamp with time zone,
	"follow_up_stop_reason" text,
	"represented_by_other_counsel" boolean DEFAULT false NOT NULL,
	"fit_outcome" text,
	"referral_source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "intake_session_state_channel_check" CHECK (channel in ('web_chat','web_form','phone_ai','phone_staff','email','sms','referral','walk_in','phone_manual')),
	CONSTRAINT "intake_session_state_status_check" CHECK ("intake_session_state"."status" in ('active','interrupted','referral_awaiting_contact','paused_emergency','closed','not_an_inquiry')),
	CONSTRAINT "intake_session_state_recording_check" CHECK ("intake_session_state"."recording_state" in ('not_applicable','pending','consented','declined')),
	CONSTRAINT "intake_session_state_response_outcome_check" CHECK ("intake_session_state"."response_outcome" is null or "intake_session_state"."response_outcome" in ('contacted','attempted','bypassed_emergency','not_an_inquiry','declined')),
	CONSTRAINT "intake_session_state_fit_check" CHECK ("intake_session_state"."fit_outcome" is null or "intake_session_state"."fit_outcome" in ('fit','borderline','no_fit'))
);
--> statement-breakpoint
CREATE TABLE "auth_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"subject" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	"disabled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "user_capabilities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"capability" text NOT NULL,
	"granted_by_user_id" uuid,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"grant_reason" text NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" uuid,
	"revoke_reason" text,
	CONSTRAINT "user_capabilities_capability_check" CHECK ("user_capabilities"."capability" in ('conflicts_attorney','bookkeeper')),
	CONSTRAINT "user_capabilities_revoke_reason_check" CHECK ("user_capabilities"."revoked_at" is null or "user_capabilities"."revoke_reason" is not null)
);
--> statement-breakpoint
CREATE TABLE "widget_embeds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"label" text NOT NULL,
	"key_hash" text NOT NULL,
	"allowed_origins" text[] DEFAULT '{}'::text[] NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conflict_checks" ADD CONSTRAINT "conflict_checks_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conflict_checks" ADD CONSTRAINT "conflict_checks_intake_session_id_intake_sessions_id_fk" FOREIGN KEY ("intake_session_id") REFERENCES "public"."intake_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conflict_checks" ADD CONSTRAINT "conflict_checks_matter_id_matters_id_fk" FOREIGN KEY ("matter_id") REFERENCES "public"."matters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conflict_checks" ADD CONSTRAINT "conflict_checks_legacy_result_id_conflict_check_results_id_fk" FOREIGN KEY ("legacy_result_id") REFERENCES "public"."conflict_check_results"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conflict_checks" ADD CONSTRAINT "conflict_checks_triggered_by_user_id_users_id_fk" FOREIGN KEY ("triggered_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conflict_checks" ADD CONSTRAINT "conflict_checks_decision_task_id_tasks_id_fk" FOREIGN KEY ("decision_task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conflict_checks" ADD CONSTRAINT "conflict_checks_assigned_user_id_users_id_fk" FOREIGN KEY ("assigned_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conflict_decisions" ADD CONSTRAINT "conflict_decisions_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conflict_decisions" ADD CONSTRAINT "conflict_decisions_check_id_conflict_checks_id_fk" FOREIGN KEY ("check_id") REFERENCES "public"."conflict_checks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conflict_decisions" ADD CONSTRAINT "conflict_decisions_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conflict_exports" ADD CONSTRAINT "conflict_exports_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conflict_exports" ADD CONSTRAINT "conflict_exports_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conflict_gates" ADD CONSTRAINT "conflict_gates_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conflict_gates" ADD CONSTRAINT "conflict_gates_check_id_conflict_checks_id_fk" FOREIGN KEY ("check_id") REFERENCES "public"."conflict_checks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conflict_import_batches" ADD CONSTRAINT "conflict_import_batches_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conflict_import_batches" ADD CONSTRAINT "conflict_import_batches_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conflict_import_batches" ADD CONSTRAINT "conflict_import_batches_committed_by_user_id_users_id_fk" FOREIGN KEY ("committed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conflict_import_rows" ADD CONSTRAINT "conflict_import_rows_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conflict_import_rows" ADD CONSTRAINT "conflict_import_rows_batch_id_conflict_import_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."conflict_import_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conflict_import_rows" ADD CONSTRAINT "conflict_import_rows_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conflict_matter_watch" ADD CONSTRAINT "conflict_matter_watch_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conflict_matter_watch" ADD CONSTRAINT "conflict_matter_watch_matter_id_matters_id_fk" FOREIGN KEY ("matter_id") REFERENCES "public"."matters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conflict_role_grants" ADD CONSTRAINT "conflict_role_grants_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conflict_role_grants" ADD CONSTRAINT "conflict_role_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conflict_role_grants" ADD CONSTRAINT "conflict_role_grants_granted_by_user_id_users_id_fk" FOREIGN KEY ("granted_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conflict_screens" ADD CONSTRAINT "conflict_screens_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conflict_screens" ADD CONSTRAINT "conflict_screens_decision_id_conflict_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."conflict_decisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conflict_screens" ADD CONSTRAINT "conflict_screens_check_id_conflict_checks_id_fk" FOREIGN KEY ("check_id") REFERENCES "public"."conflict_checks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conflict_screens" ADD CONSTRAINT "conflict_screens_screened_user_id_users_id_fk" FOREIGN KEY ("screened_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conflict_screens" ADD CONSTRAINT "conflict_screens_matter_id_matters_id_fk" FOREIGN KEY ("matter_id") REFERENCES "public"."matters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conflict_screens" ADD CONSTRAINT "conflict_screens_intake_session_id_intake_sessions_id_fk" FOREIGN KEY ("intake_session_id") REFERENCES "public"."intake_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conflict_screens" ADD CONSTRAINT "conflict_screens_activated_by_user_id_users_id_fk" FOREIGN KEY ("activated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conflict_sync_state" ADD CONSTRAINT "conflict_sync_state_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conflict_waivers" ADD CONSTRAINT "conflict_waivers_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conflict_waivers" ADD CONSTRAINT "conflict_waivers_decision_id_conflict_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."conflict_decisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conflict_waivers" ADD CONSTRAINT "conflict_waivers_check_id_conflict_checks_id_fk" FOREIGN KEY ("check_id") REFERENCES "public"."conflict_checks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conflict_waivers" ADD CONSTRAINT "conflict_waivers_client_party_id_parties_id_fk" FOREIGN KEY ("client_party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conflict_waivers" ADD CONSTRAINT "conflict_waivers_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conflict_waivers" ADD CONSTRAINT "conflict_waivers_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conflict_waivers" ADD CONSTRAINT "conflict_waivers_countersigned_by_user_id_users_id_fk" FOREIGN KEY ("countersigned_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imported_involvements" ADD CONSTRAINT "imported_involvements_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imported_involvements" ADD CONSTRAINT "imported_involvements_imported_matter_id_imported_matters_id_fk" FOREIGN KEY ("imported_matter_id") REFERENCES "public"."imported_matters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imported_involvements" ADD CONSTRAINT "imported_involvements_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imported_matters" ADD CONSTRAINT "imported_matters_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imported_matters" ADD CONSTRAINT "imported_matters_batch_id_conflict_import_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."conflict_import_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_parties" ADD CONSTRAINT "inquiry_parties_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_parties" ADD CONSTRAINT "inquiry_parties_intake_session_id_intake_sessions_id_fk" FOREIGN KEY ("intake_session_id") REFERENCES "public"."intake_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_parties" ADD CONSTRAINT "inquiry_parties_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interest_disclosure_confirmations" ADD CONSTRAINT "interest_disclosure_confirmations_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interest_disclosure_confirmations" ADD CONSTRAINT "interest_disclosure_confirmations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interest_disclosure_confirmations" ADD CONSTRAINT "interest_disclosure_confirmations_reminder_task_id_tasks_id_fk" FOREIGN KEY ("reminder_task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interest_disclosures" ADD CONSTRAINT "interest_disclosures_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interest_disclosures" ADD CONSTRAINT "interest_disclosures_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lateral_checks" ADD CONSTRAINT "lateral_checks_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lateral_checks" ADD CONSTRAINT "lateral_checks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lateral_checks" ADD CONSTRAINT "lateral_checks_no_prior_employment_attested_by_user_id_users_id_fk" FOREIGN KEY ("no_prior_employment_attested_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lateral_checks" ADD CONSTRAINT "lateral_checks_submit_task_id_tasks_id_fk" FOREIGN KEY ("submit_task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lateral_checks" ADD CONSTRAINT "lateral_checks_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lateral_prior_matters" ADD CONSTRAINT "lateral_prior_matters_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lateral_prior_matters" ADD CONSTRAINT "lateral_prior_matters_lateral_check_id_lateral_checks_id_fk" FOREIGN KEY ("lateral_check_id") REFERENCES "public"."lateral_checks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "non_engagement_letters" ADD CONSTRAINT "non_engagement_letters_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "non_engagement_letters" ADD CONSTRAINT "non_engagement_letters_intake_session_id_intake_sessions_id_fk" FOREIGN KEY ("intake_session_id") REFERENCES "public"."intake_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "non_engagement_letters" ADD CONSTRAINT "non_engagement_letters_matter_id_matters_id_fk" FOREIGN KEY ("matter_id") REFERENCES "public"."matters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "non_engagement_letters" ADD CONSTRAINT "non_engagement_letters_prospect_party_id_parties_id_fk" FOREIGN KEY ("prospect_party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "non_engagement_letters" ADD CONSTRAINT "non_engagement_letters_check_id_conflict_checks_id_fk" FOREIGN KEY ("check_id") REFERENCES "public"."conflict_checks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "non_engagement_letters" ADD CONSTRAINT "non_engagement_letters_reviewing_user_id_users_id_fk" FOREIGN KEY ("reviewing_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "non_engagement_letters" ADD CONSTRAINT "non_engagement_letters_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "non_engagement_letters" ADD CONSTRAINT "non_engagement_letters_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "non_engagement_letters" ADD CONSTRAINT "non_engagement_letters_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_addresses" ADD CONSTRAINT "party_addresses_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_addresses" ADD CONSTRAINT "party_addresses_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_match_keys" ADD CONSTRAINT "party_match_keys_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_match_keys" ADD CONSTRAINT "party_match_keys_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_merge_suggestions" ADD CONSTRAINT "party_merge_suggestions_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_merge_suggestions" ADD CONSTRAINT "party_merge_suggestions_party_a_id_parties_id_fk" FOREIGN KEY ("party_a_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_merge_suggestions" ADD CONSTRAINT "party_merge_suggestions_party_b_id_parties_id_fk" FOREIGN KEY ("party_b_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_merge_suggestions" ADD CONSTRAINT "party_merge_suggestions_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_merges" ADD CONSTRAINT "party_merges_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_merges" ADD CONSTRAINT "party_merges_survivor_party_id_parties_id_fk" FOREIGN KEY ("survivor_party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_merges" ADD CONSTRAINT "party_merges_merged_party_id_parties_id_fk" FOREIGN KEY ("merged_party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_merges" ADD CONSTRAINT "party_merges_suggestion_id_party_merge_suggestions_id_fk" FOREIGN KEY ("suggestion_id") REFERENCES "public"."party_merge_suggestions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_merges" ADD CONSTRAINT "party_merges_merged_by_user_id_users_id_fk" FOREIGN KEY ("merged_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_merges" ADD CONSTRAINT "party_merges_undone_by_user_id_users_id_fk" FOREIGN KEY ("undone_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_name_variants" ADD CONSTRAINT "party_name_variants_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_name_variants" ADD CONSTRAINT "party_name_variants_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_name_variants" ADD CONSTRAINT "party_name_variants_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_org_links" ADD CONSTRAINT "party_org_links_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_org_links" ADD CONSTRAINT "party_org_links_parent_party_id_parties_id_fk" FOREIGN KEY ("parent_party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_org_links" ADD CONSTRAINT "party_org_links_child_party_id_parties_id_fk" FOREIGN KEY ("child_party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_org_links" ADD CONSTRAINT "party_org_links_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_retention_requests" ADD CONSTRAINT "party_retention_requests_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_retention_requests" ADD CONSTRAINT "party_retention_requests_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_retention_requests" ADD CONSTRAINT "party_retention_requests_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_assignment_blocks" ADD CONSTRAINT "intake_assignment_blocks_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_assignment_blocks" ADD CONSTRAINT "intake_assignment_blocks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_assignment_blocks" ADD CONSTRAINT "intake_assignment_blocks_matter_id_matters_id_fk" FOREIGN KEY ("matter_id") REFERENCES "public"."matters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_assignment_blocks" ADD CONSTRAINT "intake_assignment_blocks_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_assignment_blocks" ADD CONSTRAINT "intake_assignment_blocks_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_busy_blocks" ADD CONSTRAINT "intake_busy_blocks_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_busy_blocks" ADD CONSTRAINT "intake_busy_blocks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_calendar_connections" ADD CONSTRAINT "intake_calendar_connections_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_calendar_connections" ADD CONSTRAINT "intake_calendar_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_consents" ADD CONSTRAINT "intake_consents_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_consents" ADD CONSTRAINT "intake_consents_intake_session_id_intake_sessions_id_fk" FOREIGN KEY ("intake_session_id") REFERENCES "public"."intake_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_consents" ADD CONSTRAINT "intake_consents_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_consents" ADD CONSTRAINT "intake_consents_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_consultations" ADD CONSTRAINT "intake_consultations_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_consultations" ADD CONSTRAINT "intake_consultations_intake_session_id_intake_sessions_id_fk" FOREIGN KEY ("intake_session_id") REFERENCES "public"."intake_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_consultations" ADD CONSTRAINT "intake_consultations_matter_id_matters_id_fk" FOREIGN KEY ("matter_id") REFERENCES "public"."matters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_consultations" ADD CONSTRAINT "intake_consultations_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_consultations" ADD CONSTRAINT "intake_consultations_lawyer_user_id_users_id_fk" FOREIGN KEY ("lawyer_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_consultations" ADD CONSTRAINT "intake_consultations_calendar_event_id_calendar_events_id_fk" FOREIGN KEY ("calendar_event_id") REFERENCES "public"."calendar_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_consultations" ADD CONSTRAINT "intake_consultations_booked_by_user_id_users_id_fk" FOREIGN KEY ("booked_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_emergency_alerts" ADD CONSTRAINT "intake_emergency_alerts_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_emergency_alerts" ADD CONSTRAINT "intake_emergency_alerts_intake_session_id_intake_sessions_id_fk" FOREIGN KEY ("intake_session_id") REFERENCES "public"."intake_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_emergency_alerts" ADD CONSTRAINT "intake_emergency_alerts_matter_id_matters_id_fk" FOREIGN KEY ("matter_id") REFERENCES "public"."matters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_emergency_alerts" ADD CONSTRAINT "intake_emergency_alerts_flag_id_flags_id_fk" FOREIGN KEY ("flag_id") REFERENCES "public"."flags"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_emergency_alerts" ADD CONSTRAINT "intake_emergency_alerts_acknowledged_by_user_id_users_id_fk" FOREIGN KEY ("acknowledged_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_emergency_alerts" ADD CONSTRAINT "intake_emergency_alerts_downgraded_by_user_id_users_id_fk" FOREIGN KEY ("downgraded_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_fit_evaluations" ADD CONSTRAINT "intake_fit_evaluations_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_fit_evaluations" ADD CONSTRAINT "intake_fit_evaluations_intake_session_id_intake_sessions_id_fk" FOREIGN KEY ("intake_session_id") REFERENCES "public"."intake_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_fit_evaluations" ADD CONSTRAINT "intake_fit_evaluations_rule_set_id_intake_fit_rule_sets_id_fk" FOREIGN KEY ("rule_set_id") REFERENCES "public"."intake_fit_rule_sets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_fit_evaluations" ADD CONSTRAINT "intake_fit_evaluations_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_fit_rule_sets" ADD CONSTRAINT "intake_fit_rule_sets_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_fit_rule_sets" ADD CONSTRAINT "intake_fit_rule_sets_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_follow_up_runs" ADD CONSTRAINT "intake_follow_up_runs_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_follow_up_runs" ADD CONSTRAINT "intake_follow_up_runs_intake_session_id_intake_sessions_id_fk" FOREIGN KEY ("intake_session_id") REFERENCES "public"."intake_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_lawyer_profiles" ADD CONSTRAINT "intake_lawyer_profiles_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_lawyer_profiles" ADD CONSTRAINT "intake_lawyer_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_matter_assignments" ADD CONSTRAINT "intake_matter_assignments_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_matter_assignments" ADD CONSTRAINT "intake_matter_assignments_matter_id_matters_id_fk" FOREIGN KEY ("matter_id") REFERENCES "public"."matters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_matter_assignments" ADD CONSTRAINT "intake_matter_assignments_assignee_user_id_users_id_fk" FOREIGN KEY ("assignee_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_matter_assignments" ADD CONSTRAINT "intake_matter_assignments_assigned_by_user_id_users_id_fk" FOREIGN KEY ("assigned_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_matter_firm_stages" ADD CONSTRAINT "intake_matter_firm_stages_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_matter_firm_stages" ADD CONSTRAINT "intake_matter_firm_stages_matter_id_matters_id_fk" FOREIGN KEY ("matter_id") REFERENCES "public"."matters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_matter_handoffs" ADD CONSTRAINT "intake_matter_handoffs_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_matter_handoffs" ADD CONSTRAINT "intake_matter_handoffs_matter_id_matters_id_fk" FOREIGN KEY ("matter_id") REFERENCES "public"."matters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_matter_handoffs" ADD CONSTRAINT "intake_matter_handoffs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_matter_openings" ADD CONSTRAINT "intake_matter_openings_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_matter_openings" ADD CONSTRAINT "intake_matter_openings_matter_id_matters_id_fk" FOREIGN KEY ("matter_id") REFERENCES "public"."matters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_matter_openings" ADD CONSTRAINT "intake_matter_openings_opened_by_user_id_users_id_fk" FOREIGN KEY ("opened_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_messages" ADD CONSTRAINT "intake_messages_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_messages" ADD CONSTRAINT "intake_messages_intake_session_id_intake_sessions_id_fk" FOREIGN KEY ("intake_session_id") REFERENCES "public"."intake_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_messages" ADD CONSTRAINT "intake_messages_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_on_call_rota" ADD CONSTRAINT "intake_on_call_rota_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_on_call_rota" ADD CONSTRAINT "intake_on_call_rota_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_open_gate_evidence" ADD CONSTRAINT "intake_open_gate_evidence_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_open_gate_evidence" ADD CONSTRAINT "intake_open_gate_evidence_matter_id_matters_id_fk" FOREIGN KEY ("matter_id") REFERENCES "public"."matters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_open_gate_evidence" ADD CONSTRAINT "intake_open_gate_evidence_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_out_of_office" ADD CONSTRAINT "intake_out_of_office_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_out_of_office" ADD CONSTRAINT "intake_out_of_office_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_pipeline_versions" ADD CONSTRAINT "intake_pipeline_versions_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_pipeline_versions" ADD CONSTRAINT "intake_pipeline_versions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_referral_directory" ADD CONSTRAINT "intake_referral_directory_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_referrals" ADD CONSTRAINT "intake_referrals_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_referrals" ADD CONSTRAINT "intake_referrals_intake_session_id_intake_sessions_id_fk" FOREIGN KEY ("intake_session_id") REFERENCES "public"."intake_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_referrals" ADD CONSTRAINT "intake_referrals_referrer_user_id_users_id_fk" FOREIGN KEY ("referrer_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_referrals" ADD CONSTRAINT "intake_referrals_referrer_party_id_parties_id_fk" FOREIGN KEY ("referrer_party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_referrals" ADD CONSTRAINT "intake_referrals_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_session_state" ADD CONSTRAINT "intake_session_state_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_session_state" ADD CONSTRAINT "intake_session_state_intake_session_id_intake_sessions_id_fk" FOREIGN KEY ("intake_session_id") REFERENCES "public"."intake_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_session_state" ADD CONSTRAINT "intake_session_state_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_session_state" ADD CONSTRAINT "intake_session_state_response_task_id_tasks_id_fk" FOREIGN KEY ("response_task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_session_state" ADD CONSTRAINT "intake_session_state_first_human_contact_by_user_id_users_id_fk" FOREIGN KEY ("first_human_contact_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_identities" ADD CONSTRAINT "auth_identities_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_identities" ADD CONSTRAINT "auth_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_capabilities" ADD CONSTRAINT "user_capabilities_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_capabilities" ADD CONSTRAINT "user_capabilities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_capabilities" ADD CONSTRAINT "user_capabilities_granted_by_user_id_users_id_fk" FOREIGN KEY ("granted_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_capabilities" ADD CONSTRAINT "user_capabilities_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "widget_embeds" ADD CONSTRAINT "widget_embeds_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "widget_embeds" ADD CONSTRAINT "widget_embeds_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conflict_checks_tenant_status_idx" ON "conflict_checks" USING btree ("tenant_id","status","created_at");--> statement-breakpoint
CREATE INDEX "conflict_checks_tenant_session_idx" ON "conflict_checks" USING btree ("tenant_id","intake_session_id");--> statement-breakpoint
CREATE INDEX "conflict_checks_tenant_matter_idx" ON "conflict_checks" USING btree ("tenant_id","matter_id");--> statement-breakpoint
CREATE INDEX "conflict_decisions_tenant_check_idx" ON "conflict_decisions" USING btree ("tenant_id","check_id","decided_at");--> statement-breakpoint
CREATE INDEX "conflict_exports_tenant_user_idx" ON "conflict_exports" USING btree ("tenant_id","requested_by_user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "conflict_gates_subject_key" ON "conflict_gates" USING btree ("tenant_id","subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "conflict_import_batches_tenant_idx" ON "conflict_import_batches" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "conflict_import_rows_batch_idx" ON "conflict_import_rows" USING btree ("tenant_id","batch_id","line_number");--> statement-breakpoint
CREATE UNIQUE INDEX "conflict_matter_watch_matter_key" ON "conflict_matter_watch" USING btree ("tenant_id","matter_id");--> statement-breakpoint
CREATE INDEX "conflict_role_grants_tenant_user_idx" ON "conflict_role_grants" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conflict_role_grants_one_designated" ON "conflict_role_grants" USING btree ("tenant_id") WHERE "conflict_role_grants"."designated" and "conflict_role_grants"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "conflict_screens_tenant_user_idx" ON "conflict_screens" USING btree ("tenant_id","screened_user_id","status");--> statement-breakpoint
CREATE INDEX "conflict_screens_tenant_check_idx" ON "conflict_screens" USING btree ("tenant_id","check_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conflict_sync_state_tenant_key" ON "conflict_sync_state" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "conflict_waivers_tenant_check_idx" ON "conflict_waivers" USING btree ("tenant_id","check_id");--> statement-breakpoint
CREATE INDEX "conflict_waivers_tenant_status_idx" ON "conflict_waivers" USING btree ("tenant_id","status","due_at");--> statement-breakpoint
CREATE UNIQUE INDEX "imported_involvements_key" ON "imported_involvements" USING btree ("tenant_id","imported_matter_id","party_id","role");--> statement-breakpoint
CREATE INDEX "imported_involvements_party_idx" ON "imported_involvements" USING btree ("tenant_id","party_id");--> statement-breakpoint
CREATE UNIQUE INDEX "imported_matters_ref_key" ON "imported_matters" USING btree ("tenant_id","external_ref");--> statement-breakpoint
CREATE INDEX "inquiry_parties_tenant_session_idx" ON "inquiry_parties" USING btree ("tenant_id","intake_session_id");--> statement-breakpoint
CREATE INDEX "inquiry_parties_tenant_party_idx" ON "inquiry_parties" USING btree ("tenant_id","party_id");--> statement-breakpoint
CREATE UNIQUE INDEX "interest_disclosure_confirmations_user_key" ON "interest_disclosure_confirmations" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE INDEX "interest_disclosures_tenant_user_idx" ON "interest_disclosures" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE INDEX "interest_disclosures_tenant_name_idx" ON "interest_disclosures" USING btree ("tenant_id","normalized_name");--> statement-breakpoint
CREATE INDEX "lateral_checks_tenant_status_idx" ON "lateral_checks" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "lateral_checks_tenant_user_idx" ON "lateral_checks" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE INDEX "lateral_prior_matters_tenant_check_idx" ON "lateral_prior_matters" USING btree ("tenant_id","lateral_check_id");--> statement-breakpoint
CREATE INDEX "non_engagement_letters_tenant_status_idx" ON "non_engagement_letters" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "party_addresses_party_address_key" ON "party_addresses" USING btree ("tenant_id","party_id","normalized_address");--> statement-breakpoint
CREATE UNIQUE INDEX "party_match_keys_party_key" ON "party_match_keys" USING btree ("tenant_id","party_id","key");--> statement-breakpoint
CREATE INDEX "party_match_keys_tenant_key_idx" ON "party_match_keys" USING btree ("tenant_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "party_merge_suggestions_pair_key" ON "party_merge_suggestions" USING btree ("tenant_id","party_a_id","party_b_id");--> statement-breakpoint
CREATE INDEX "party_merge_suggestions_tenant_status_idx" ON "party_merge_suggestions" USING btree ("tenant_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "party_merges_active_merged_key" ON "party_merges" USING btree ("tenant_id","merged_party_id") WHERE "party_merges"."undone_at" is null;--> statement-breakpoint
CREATE INDEX "party_name_variants_tenant_name_idx" ON "party_name_variants" USING btree ("tenant_id","normalized_name");--> statement-breakpoint
CREATE INDEX "party_name_variants_tenant_party_idx" ON "party_name_variants" USING btree ("tenant_id","party_id");--> statement-breakpoint
CREATE UNIQUE INDEX "party_name_variants_party_name_type_key" ON "party_name_variants" USING btree ("party_id","normalized_name","name_type");--> statement-breakpoint
CREATE UNIQUE INDEX "party_org_links_pair_key" ON "party_org_links" USING btree ("tenant_id","parent_party_id","child_party_id","link_type");--> statement-breakpoint
CREATE INDEX "party_retention_requests_tenant_status_idx" ON "party_retention_requests" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "intake_assignment_blocks_user_idx" ON "intake_assignment_blocks" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE INDEX "intake_busy_blocks_user_idx" ON "intake_busy_blocks" USING btree ("tenant_id","user_id","starts_at");--> statement-breakpoint
CREATE UNIQUE INDEX "intake_calendar_connections_user_provider_key" ON "intake_calendar_connections" USING btree ("tenant_id","user_id","provider");--> statement-breakpoint
CREATE INDEX "intake_consents_session_idx" ON "intake_consents" USING btree ("tenant_id","intake_session_id","consent_type");--> statement-breakpoint
CREATE INDEX "intake_consultations_lawyer_idx" ON "intake_consultations" USING btree ("tenant_id","lawyer_user_id","starts_at");--> statement-breakpoint
CREATE INDEX "intake_consultations_session_idx" ON "intake_consultations" USING btree ("tenant_id","intake_session_id");--> statement-breakpoint
CREATE INDEX "intake_emergency_alerts_open_idx" ON "intake_emergency_alerts" USING btree ("tenant_id","acknowledged_at","raised_at");--> statement-breakpoint
CREATE INDEX "intake_emergency_alerts_session_idx" ON "intake_emergency_alerts" USING btree ("tenant_id","intake_session_id");--> statement-breakpoint
CREATE INDEX "intake_fit_evaluations_session_idx" ON "intake_fit_evaluations" USING btree ("tenant_id","intake_session_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "intake_fit_rule_sets_tenant_version_key" ON "intake_fit_rule_sets" USING btree ("tenant_id","version");--> statement-breakpoint
CREATE INDEX "intake_fit_rule_sets_effective_idx" ON "intake_fit_rule_sets" USING btree ("tenant_id","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX "intake_follow_up_runs_active_key" ON "intake_follow_up_runs" USING btree ("tenant_id","intake_session_id") WHERE "intake_follow_up_runs"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "intake_lawyer_profiles_user_key" ON "intake_lawyer_profiles" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE INDEX "intake_matter_assignments_matter_idx" ON "intake_matter_assignments" USING btree ("tenant_id","matter_id","created_at");--> statement-breakpoint
CREATE INDEX "intake_matter_assignments_assignee_idx" ON "intake_matter_assignments" USING btree ("tenant_id","assignee_user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "intake_matter_firm_stages_matter_key" ON "intake_matter_firm_stages" USING btree ("tenant_id","matter_id");--> statement-breakpoint
CREATE UNIQUE INDEX "intake_matter_handoffs_item_key" ON "intake_matter_handoffs" USING btree ("tenant_id","matter_id","item");--> statement-breakpoint
CREATE UNIQUE INDEX "intake_matter_openings_matter_key" ON "intake_matter_openings" USING btree ("tenant_id","matter_id");--> statement-breakpoint
CREATE INDEX "intake_messages_session_idx" ON "intake_messages" USING btree ("tenant_id","intake_session_id","created_at");--> statement-breakpoint
CREATE INDEX "intake_on_call_rota_tenant_idx" ON "intake_on_call_rota" USING btree ("tenant_id","active");--> statement-breakpoint
CREATE INDEX "intake_open_gate_evidence_matter_idx" ON "intake_open_gate_evidence" USING btree ("tenant_id","matter_id","gate");--> statement-breakpoint
CREATE INDEX "intake_out_of_office_user_idx" ON "intake_out_of_office" USING btree ("tenant_id","user_id","ends_at");--> statement-breakpoint
CREATE UNIQUE INDEX "intake_pipeline_versions_tenant_version_key" ON "intake_pipeline_versions" USING btree ("tenant_id","version");--> statement-breakpoint
CREATE INDEX "intake_pipeline_versions_tenant_effective_idx" ON "intake_pipeline_versions" USING btree ("tenant_id","effective_from");--> statement-breakpoint
CREATE INDEX "intake_referral_directory_tenant_idx" ON "intake_referral_directory" USING btree ("tenant_id","active");--> statement-breakpoint
CREATE INDEX "intake_referrals_session_idx" ON "intake_referrals" USING btree ("tenant_id","intake_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "intake_session_state_session_key" ON "intake_session_state" USING btree ("tenant_id","intake_session_id");--> statement-breakpoint
CREATE INDEX "intake_session_state_thread_idx" ON "intake_session_state" USING btree ("tenant_id","channel","external_thread_id");--> statement-breakpoint
CREATE INDEX "intake_session_state_party_idx" ON "intake_session_state" USING btree ("tenant_id","party_id");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_identities_provider_subject_key" ON "auth_identities" USING btree ("tenant_id","provider","subject");--> statement-breakpoint
CREATE INDEX "auth_identities_tenant_user_idx" ON "auth_identities" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE INDEX "user_capabilities_tenant_user_idx" ON "user_capabilities" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_capabilities_active_key" ON "user_capabilities" USING btree ("tenant_id","user_id","capability") WHERE "user_capabilities"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "widget_embeds_key_hash_key" ON "widget_embeds" USING btree ("tenant_id","key_hash");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Hand-added (Drizzle's DSL does not express RLS or GRANTs). Implements the
-- MIGRATION NOTES at the bottom of src/db/tables/conflict-check.ts, intake.ts
-- and platform.ts, using the same tenant_isolation policy text as 0000.
--
-- NOTE: the public schema has ALTER DEFAULT PRIVILEGES granting app_runtime
-- SELECT/INSERT/UPDATE/DELETE on every new table (found applying 0002), so
-- every restriction below is an explicit REVOKE, not just a narrower GRANT.
-- ---------------------------------------------------------------------------

ALTER TABLE "conflict_checks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "conflict_decisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "conflict_exports" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "conflict_gates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "conflict_import_batches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "conflict_import_rows" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "conflict_matter_watch" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "conflict_role_grants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "conflict_screens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "conflict_sync_state" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "conflict_waivers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "imported_involvements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "imported_matters" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "inquiry_parties" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "interest_disclosure_confirmations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "interest_disclosures" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "lateral_checks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "lateral_prior_matters" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "non_engagement_letters" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "party_addresses" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "party_match_keys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "party_merge_suggestions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "party_merges" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "party_name_variants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "party_org_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "party_retention_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "intake_assignment_blocks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "intake_busy_blocks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "intake_calendar_connections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "intake_consents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "intake_consultations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "intake_emergency_alerts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "intake_fit_evaluations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "intake_fit_rule_sets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "intake_follow_up_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "intake_lawyer_profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "intake_matter_assignments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "intake_matter_firm_stages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "intake_matter_handoffs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "intake_matter_openings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "intake_messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "intake_on_call_rota" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "intake_open_gate_evidence" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "intake_out_of_office" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "intake_pipeline_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "intake_referral_directory" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "intake_referrals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "intake_session_state" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "auth_identities" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_capabilities" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "widget_embeds" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY tenant_isolation ON "conflict_checks" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "conflict_decisions" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "conflict_exports" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "conflict_gates" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "conflict_import_batches" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "conflict_import_rows" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "conflict_matter_watch" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "conflict_role_grants" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "conflict_screens" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "conflict_sync_state" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "conflict_waivers" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "imported_involvements" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "imported_matters" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "inquiry_parties" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "interest_disclosure_confirmations" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "interest_disclosures" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "lateral_checks" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "lateral_prior_matters" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "non_engagement_letters" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "party_addresses" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "party_match_keys" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "party_merge_suggestions" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "party_merges" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "party_name_variants" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "party_org_links" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "party_retention_requests" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "intake_assignment_blocks" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "intake_busy_blocks" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "intake_calendar_connections" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "intake_consents" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "intake_consultations" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "intake_emergency_alerts" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "intake_fit_evaluations" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "intake_fit_rule_sets" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "intake_follow_up_runs" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "intake_lawyer_profiles" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "intake_matter_assignments" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "intake_matter_firm_stages" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "intake_matter_handoffs" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "intake_matter_openings" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "intake_messages" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "intake_on_call_rota" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "intake_open_gate_evidence" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "intake_out_of_office" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "intake_pipeline_versions" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "intake_referral_directory" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "intake_referrals" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "intake_session_state" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "auth_identities" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "user_capabilities" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "widget_embeds" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON "conflict_checks", "conflict_decisions", "conflict_exports", "conflict_gates", "conflict_import_batches", "conflict_import_rows", "conflict_matter_watch", "conflict_role_grants", "conflict_screens", "conflict_sync_state", "conflict_waivers", "imported_involvements", "imported_matters", "inquiry_parties", "interest_disclosure_confirmations", "interest_disclosures", "lateral_checks", "lateral_prior_matters", "non_engagement_letters", "party_addresses", "party_match_keys", "party_merge_suggestions", "party_merges", "party_name_variants", "party_org_links", "party_retention_requests", "intake_assignment_blocks", "intake_busy_blocks", "intake_calendar_connections", "intake_consents", "intake_consultations", "intake_emergency_alerts", "intake_fit_evaluations", "intake_fit_rule_sets", "intake_follow_up_runs", "intake_lawyer_profiles", "intake_matter_assignments", "intake_matter_firm_stages", "intake_matter_handoffs", "intake_matter_openings", "intake_messages", "intake_on_call_rota", "intake_open_gate_evidence", "intake_out_of_office", "intake_pipeline_versions", "intake_referral_directory", "intake_referrals", "intake_session_state", "auth_identities", "user_capabilities", "widget_embeds" TO app_runtime;--> statement-breakpoint

-- conflict_decisions is append-only (c59 rule 4).
REVOKE UPDATE, DELETE ON "conflict_decisions" FROM app_runtime;--> statement-breakpoint
-- The conflicts log must never lose rows (c63 rule 2).
REVOKE DELETE ON "party_merges", "conflict_checks" FROM app_runtime;--> statement-breakpoint
-- Append-only intake history (c6). intake_consents keeps UPDATE for withdrawn_at.
REVOKE UPDATE, DELETE ON "intake_pipeline_versions", "intake_fit_rule_sets", "intake_messages", "intake_matter_openings" FROM app_runtime;--> statement-breakpoint
-- Capability history and identity links are kept; disable/revoke instead (c34).
REVOKE DELETE ON "auth_identities", "user_capabilities", "widget_embeds" FROM app_runtime;--> statement-breakpoint

-- Same hardening as 0001/0002: the app never uses Supabase's REST roles.
REVOKE ALL ON "conflict_checks", "conflict_decisions", "conflict_exports", "conflict_gates", "conflict_import_batches", "conflict_import_rows", "conflict_matter_watch", "conflict_role_grants", "conflict_screens", "conflict_sync_state", "conflict_waivers", "imported_involvements", "imported_matters", "inquiry_parties", "interest_disclosure_confirmations", "interest_disclosures", "lateral_checks", "lateral_prior_matters", "non_engagement_letters", "party_addresses", "party_match_keys", "party_merge_suggestions", "party_merges", "party_name_variants", "party_org_links", "party_retention_requests", "intake_assignment_blocks", "intake_busy_blocks", "intake_calendar_connections", "intake_consents", "intake_consultations", "intake_emergency_alerts", "intake_fit_evaluations", "intake_fit_rule_sets", "intake_follow_up_runs", "intake_lawyer_profiles", "intake_matter_assignments", "intake_matter_firm_stages", "intake_matter_handoffs", "intake_matter_openings", "intake_messages", "intake_on_call_rota", "intake_open_gate_evidence", "intake_out_of_office", "intake_pipeline_versions", "intake_referral_directory", "intake_referrals", "intake_session_state", "auth_identities", "user_capabilities", "widget_embeds" FROM anon, authenticated;--> statement-breakpoint

-- Carried over from 0002: compliance_approvals must be read-only for the app.
-- (This REVOKE was added to 0002 after PR #39 had already merged, so it
-- lands here; already applied to staging on 2026-10-01 as 0002b.)
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "compliance_approvals" FROM app_runtime;
