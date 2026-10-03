CREATE TABLE "access_change_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"area" text NOT NULL,
	"action" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_user_id" uuid,
	"target_user_id" uuid,
	"matter_id" uuid,
	"role" text,
	"right" text,
	"practice_area" text,
	"before" jsonb,
	"after" jsonb,
	"reason" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "access_change_log_area_check" CHECK ("access_change_log"."area" in ('permissions','roles','matter_access','practice_areas','packs')),
	CONSTRAINT "access_change_log_actor_type_check" CHECK ("access_change_log"."actor_type" in ('system','user'))
);
--> statement-breakpoint
CREATE TABLE "firm_role_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"granted_by_user_id" uuid,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"grant_reason" text NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" uuid,
	"revoke_reason" text,
	CONSTRAINT "firm_role_assignments_role_check" CHECK ("firm_role_assignments"."role" in ('owner','admin','lawyer','paralegal','intake_staff','bookkeeper','conflicts_attorney','read_only')),
	CONSTRAINT "firm_role_assignments_revoke_reason_check" CHECK ("firm_role_assignments"."revoked_at" is null or "firm_role_assignments"."revoke_reason" is not null)
);
--> statement-breakpoint
CREATE TABLE "matter_access_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"matter_id" uuid NOT NULL,
	"restricted" boolean DEFAULT false NOT NULL,
	"reason" text,
	"updated_by_user_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "matter_access_settings_reason_check" CHECK (not "matter_access_settings"."restricted" or "matter_access_settings"."reason" is not null)
);
--> statement-breakpoint
CREATE TABLE "matter_team_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"matter_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role_on_matter" text DEFAULT 'member' NOT NULL,
	"added_by_user_id" uuid,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	"removed_by_user_id" uuid
);
--> statement-breakpoint
CREATE TABLE "permission_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"role" text NOT NULL,
	"right" text NOT NULL,
	"effect" text NOT NULL,
	"reason" text NOT NULL,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "permission_overrides_effect_check" CHECK ("permission_overrides"."effect" in ('grant','deny')),
	CONSTRAINT "permission_overrides_role_check" CHECK ("permission_overrides"."role" in ('owner','admin','lawyer','paralegal','intake_staff','bookkeeper','conflicts_attorney','read_only'))
);
--> statement-breakpoint
CREATE TABLE "practice_area_pack_adoptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"practice_area" text NOT NULL,
	"version" text NOT NULL,
	"content_hash" text NOT NULL,
	"content" jsonb NOT NULL,
	"status" text DEFAULT 'accepted' NOT NULL,
	"accepted_by_user_id" uuid,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_at" timestamp with time zone,
	"notes" text,
	CONSTRAINT "practice_area_pack_adoptions_status_check" CHECK ("practice_area_pack_adoptions"."status" in ('accepted','superseded')),
	CONSTRAINT "practice_area_pack_adoptions_area_check" CHECK ("practice_area_pack_adoptions"."practice_area" in ('family','immigration','personal_injury'))
);
--> statement-breakpoint
CREATE TABLE "trust_account_books" (
	"trust_account_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"balance_cents" bigint DEFAULT 0 NOT NULL,
	"last_sequence" integer DEFAULT 0 NOT NULL,
	"last_hash" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trust_account_books_balance_check" CHECK ("trust_account_books"."balance_cents" >= 0),
	CONSTRAINT "trust_account_books_sequence_check" CHECK ("trust_account_books"."last_sequence" >= 0)
);
--> statement-breakpoint
CREATE TABLE "trust_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"bank_name" text NOT NULL,
	"account_number_last4" text NOT NULL,
	"account_type" text DEFAULT 'iolta' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"opened_on" date NOT NULL,
	"closed_on" date,
	"bank_fee_cushion_cap_cents" bigint DEFAULT 0 NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trust_accounts_type_check" CHECK ("trust_accounts"."account_type" in ('iolta','trust')),
	CONSTRAINT "trust_accounts_status_check" CHECK ("trust_accounts"."status" in ('active','closed')),
	CONSTRAINT "trust_accounts_last4_check" CHECK ("trust_accounts"."account_number_last4" ~ '^[0-9]{4}$'),
	CONSTRAINT "trust_accounts_cushion_check" CHECK ("trust_accounts"."bank_fee_cushion_cap_cents" >= 0),
	CONSTRAINT "trust_accounts_closed_check" CHECK (("trust_accounts"."status" = 'closed') = ("trust_accounts"."closed_on" is not null))
);
--> statement-breakpoint
CREATE TABLE "trust_bank_statement_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"statement_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"posted_on" date NOT NULL,
	"amount_cents" bigint NOT NULL,
	"description" text NOT NULL,
	"reference" text,
	"kind" text NOT NULL,
	CONSTRAINT "trust_bank_statement_lines_amount_check" CHECK ("trust_bank_statement_lines"."amount_cents" <> 0),
	CONSTRAINT "trust_bank_statement_lines_kind_check" CHECK ("trust_bank_statement_lines"."kind" in ('deposit','withdrawal','fee','iolta_interest','iolta_remittance','other'))
);
--> statement-breakpoint
CREATE TABLE "trust_bank_statements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"trust_account_id" uuid NOT NULL,
	"period" text NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"opening_balance_cents" bigint NOT NULL,
	"closing_balance_cents" bigint NOT NULL,
	"source" text NOT NULL,
	"source_sha256" text,
	"supersedes_statement_id" uuid,
	"note" text,
	"entered_by_user_id" uuid NOT NULL,
	"entered_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trust_bank_statements_period_check" CHECK ("trust_bank_statements"."period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "trust_bank_statements_dates_check" CHECK ("trust_bank_statements"."period_end" >= "trust_bank_statements"."period_start"),
	CONSTRAINT "trust_bank_statements_source_check" CHECK ("trust_bank_statements"."source" in ('manual','csv_import','bank_feed'))
);
--> statement-breakpoint
CREATE TABLE "trust_hold_releases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"hold_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"released_by_user_id" uuid NOT NULL,
	"released_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trust_hold_releases_reason_check" CHECK (length(btrim("trust_hold_releases"."reason")) >= 3)
);
--> statement-breakpoint
CREATE TABLE "trust_holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"trust_account_id" uuid NOT NULL,
	"subledger_id" uuid NOT NULL,
	"amount_cents" bigint NOT NULL,
	"reason" text NOT NULL,
	"placed_by_user_id" uuid NOT NULL,
	"placed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trust_holds_amount_check" CHECK ("trust_holds"."amount_cents" > 0),
	CONSTRAINT "trust_holds_reason_check" CHECK (length(btrim("trust_holds"."reason")) >= 3)
);
--> statement-breakpoint
CREATE TABLE "trust_ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"transaction_id" uuid NOT NULL,
	"trust_account_id" uuid NOT NULL,
	"subledger_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"amount_cents" bigint NOT NULL,
	"balance_after_cents" bigint NOT NULL,
	"book_balance_after_cents" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trust_ledger_entries_amount_check" CHECK ("trust_ledger_entries"."amount_cents" <> 0),
	CONSTRAINT "trust_ledger_entries_line_check" CHECK ("trust_ledger_entries"."line_no" between 1 and 2),
	CONSTRAINT "trust_ledger_entries_balance_check" CHECK ("trust_ledger_entries"."balance_after_cents" >= 0 and "trust_ledger_entries"."book_balance_after_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "trust_period_closes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"trust_account_id" uuid NOT NULL,
	"period" text NOT NULL,
	"period_end" date NOT NULL,
	"reconciliation_id" uuid NOT NULL,
	"closed_by_user_id" uuid NOT NULL,
	"closed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trust_reconciliation_signoffs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"reconciliation_id" uuid NOT NULL,
	"signoff_role" text NOT NULL,
	"user_id" uuid NOT NULL,
	"report_hash" text NOT NULL,
	"note" text,
	"signed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trust_reconciliation_signoffs_role_check" CHECK ("trust_reconciliation_signoffs"."signoff_role" in ('bookkeeper','lawyer'))
);
--> statement-breakpoint
CREATE TABLE "trust_reconciliations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"trust_account_id" uuid NOT NULL,
	"period" text NOT NULL,
	"period_end" date NOT NULL,
	"statement_id" uuid NOT NULL,
	"status" text NOT NULL,
	"bank_closing_balance_cents" bigint NOT NULL,
	"adjusted_bank_balance_cents" bigint NOT NULL,
	"book_balance_cents" bigint NOT NULL,
	"client_ledger_total_cents" bigint NOT NULL,
	"deposits_in_transit_cents" bigint NOT NULL,
	"outstanding_withdrawals_cents" bigint NOT NULL,
	"differences" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"worksheet" jsonb NOT NULL,
	"report_hash" text NOT NULL,
	"through_sequence" integer NOT NULL,
	"supersedes_reconciliation_id" uuid,
	"rules_approved" boolean NOT NULL,
	"prepared_by_user_id" uuid NOT NULL,
	"prepared_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trust_reconciliations_status_check" CHECK ("trust_reconciliations"."status" in ('balanced','unbalanced')),
	CONSTRAINT "trust_reconciliations_period_check" CHECK ("trust_reconciliations"."period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "trust_reconciliations_balanced_check" CHECK ("trust_reconciliations"."status" <> 'balanced' or ("trust_reconciliations"."adjusted_bank_balance_cents" = "trust_reconciliations"."book_balance_cents" and "trust_reconciliations"."book_balance_cents" = "trust_reconciliations"."client_ledger_total_cents")),
	CONSTRAINT "trust_reconciliations_hash_check" CHECK ("trust_reconciliations"."report_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "trust_subledgers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"trust_account_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"client_party_id" uuid,
	"matter_id" uuid,
	"balance_cents" bigint DEFAULT 0 NOT NULL,
	"held_cents" bigint DEFAULT 0 NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trust_subledgers_kind_check" CHECK ("trust_subledgers"."kind" in ('client_matter','firm_cushion')),
	CONSTRAINT "trust_subledgers_owner_check" CHECK (("trust_subledgers"."kind" = 'client_matter' and "trust_subledgers"."client_party_id" is not null and "trust_subledgers"."matter_id" is not null)
      or ("trust_subledgers"."kind" = 'firm_cushion' and "trust_subledgers"."client_party_id" is null and "trust_subledgers"."matter_id" is null)),
	CONSTRAINT "trust_subledgers_balance_check" CHECK ("trust_subledgers"."balance_cents" >= 0),
	CONSTRAINT "trust_subledgers_held_check" CHECK ("trust_subledgers"."held_cents" >= 0 and "trust_subledgers"."held_cents" <= "trust_subledgers"."balance_cents")
);
--> statement-breakpoint
CREATE TABLE "trust_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"trust_account_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"kind" text NOT NULL,
	"effective_date" date NOT NULL,
	"net_amount_cents" bigint NOT NULL,
	"reason" text NOT NULL,
	"memo" text,
	"counterparty" text,
	"reference" text,
	"funds_source" text,
	"invoice_id" uuid,
	"earned_basis" text,
	"reverses_transaction_id" uuid,
	"posted_by_user_id" uuid NOT NULL,
	"posted_at" timestamp with time zone NOT NULL,
	"approval_evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"prev_hash" text,
	"hash" text NOT NULL,
	CONSTRAINT "trust_transactions_kind_check" CHECK ("trust_transactions"."kind" in ('deposit','disbursement','earned_fee_transfer','refund','transfer','cushion_deposit','cushion_withdrawal','bank_fee','reversal')),
	CONSTRAINT "trust_transactions_sequence_check" CHECK ("trust_transactions"."sequence" >= 1),
	CONSTRAINT "trust_transactions_reason_check" CHECK (length(btrim("trust_transactions"."reason")) >= 3),
	CONSTRAINT "trust_transactions_funds_source_check" CHECK ("trust_transactions"."funds_source" is null or "trust_transactions"."funds_source" in ('client','third_party','firm_operating')),
	CONSTRAINT "trust_transactions_shape_check" CHECK (case "trust_transactions"."kind"
      when 'deposit' then "trust_transactions"."net_amount_cents" > 0 and "trust_transactions"."funds_source" in ('client','third_party')
      when 'cushion_deposit' then "trust_transactions"."net_amount_cents" > 0 and "trust_transactions"."funds_source" = 'firm_operating'
      when 'disbursement' then "trust_transactions"."net_amount_cents" < 0 and "trust_transactions"."counterparty" is not null and "trust_transactions"."funds_source" is null
      when 'earned_fee_transfer' then "trust_transactions"."net_amount_cents" < 0 and "trust_transactions"."funds_source" is null
        and ("trust_transactions"."invoice_id" is not null or length(btrim(coalesce("trust_transactions"."earned_basis", ''))) > 0)
      when 'refund' then "trust_transactions"."net_amount_cents" < 0 and "trust_transactions"."funds_source" is null
      when 'cushion_withdrawal' then "trust_transactions"."net_amount_cents" < 0 and "trust_transactions"."funds_source" is null
      when 'bank_fee' then "trust_transactions"."net_amount_cents" < 0 and "trust_transactions"."funds_source" is null
      when 'transfer' then "trust_transactions"."net_amount_cents" = 0 and "trust_transactions"."funds_source" is null
      when 'reversal' then "trust_transactions"."funds_source" is null
      else false end),
	CONSTRAINT "trust_transactions_reversal_check" CHECK (("trust_transactions"."kind" = 'reversal') = ("trust_transactions"."reverses_transaction_id" is not null)),
	CONSTRAINT "trust_transactions_hash_check" CHECK ("trust_transactions"."hash" ~ '^[0-9a-f]{64}$' and ("trust_transactions"."prev_hash" is null or "trust_transactions"."prev_hash" ~ '^[0-9a-f]{64}$')),
	CONSTRAINT "trust_transactions_first_check" CHECK (("trust_transactions"."sequence" = 1) = ("trust_transactions"."prev_hash" is null))
);
--> statement-breakpoint
CREATE TABLE "alert_digest_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"flag_id" uuid NOT NULL,
	"notification_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "alert_job_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"job" text NOT NULL,
	"last_run_at" timestamp with time zone NOT NULL,
	"last_summary" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "client_chase_ladders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"matter_id" uuid,
	"subject_type" text NOT NULL,
	"task_id" uuid NOT NULL,
	"message_id" uuid,
	"party_id" uuid NOT NULL,
	"next_step" integer DEFAULT 0 NOT NULL,
	"next_at" timestamp with time zone,
	"reminders_sent" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"paused_reason" text,
	"paused_by" text,
	"internal_flag_id" uuid,
	"decision_task_id" uuid,
	"ladder_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"last_step_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"end_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_chase_ladders_subject_check" CHECK ("client_chase_ladders"."subject_type" in ('message','task')),
	CONSTRAINT "client_chase_ladders_status_check" CHECK ("client_chase_ladders"."status" in ('active','paused','awaiting_lawyer','completed','stopped')),
	CONSTRAINT "client_chase_ladders_paused_by_check" CHECK ("client_chase_ladders"."paused_by" is null or "client_chase_ladders"."paused_by" in ('lawyer','help_request')),
	CONSTRAINT "client_chase_ladders_paused_reason_check" CHECK ("client_chase_ladders"."status" <> 'paused' or ("client_chase_ladders"."paused_reason" is not null and length("client_chase_ladders"."paused_reason") > 0))
);
--> statement-breakpoint
CREATE TABLE "client_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"matter_id" uuid NOT NULL,
	"thread_key" text DEFAULT 'main' NOT NULL,
	"direction" text NOT NULL,
	"sender_type" text NOT NULL,
	"sender_user_id" uuid,
	"sender_party_id" uuid,
	"client_party_id" uuid,
	"channel" text NOT NULL,
	"body" text NOT NULL,
	"is_auto_ack" boolean DEFAULT false NOT NULL,
	"auto_submitted" boolean DEFAULT false NOT NULL,
	"expects_reply" boolean DEFAULT false NOT NULL,
	"reply_window_hours" integer,
	"related_calendar_event_id" uuid,
	"deadline_related" boolean DEFAULT false NOT NULL,
	"deadline_tag_source" text,
	"deadline_tag_detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"client_stated_event_at" timestamp with time zone,
	"urgent" boolean DEFAULT false NOT NULL,
	"in_reply_to_message_id" uuid,
	"in_reply_to_update_id" uuid,
	"delivery_state" text DEFAULT 'logged' NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_messages_direction_check" CHECK ("client_messages"."direction" in ('inbound','outbound')),
	CONSTRAINT "client_messages_sender_type_check" CHECK ("client_messages"."sender_type" in ('client','user','ai','system')),
	CONSTRAINT "client_messages_channel_check" CHECK ("client_messages"."channel" in ('portal','email','sms','phone_log')),
	CONSTRAINT "client_messages_delivery_state_check" CHECK ("client_messages"."delivery_state" in ('delivered','held','logged')),
	CONSTRAINT "client_messages_direction_sender_check" CHECK (("client_messages"."direction" = 'inbound' and "client_messages"."sender_type" = 'client') or ("client_messages"."direction" = 'outbound' and "client_messages"."sender_type" <> 'client')),
	CONSTRAINT "client_messages_tag_source_check" CHECK ("client_messages"."deadline_tag_source" is null or "client_messages"."deadline_tag_source" in ('rules','ai','calendar','staff'))
);
--> statement-breakpoint
CREATE TABLE "client_update_cadences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"matter_id" uuid NOT NULL,
	"every_business_days" integer NOT NULL,
	"current_task_id" uuid,
	"set_by_user_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_update_cadences_positive_check" CHECK ("client_update_cadences"."every_business_days" > 0 and "client_update_cadences"."every_business_days" <= 260)
);
--> statement-breakpoint
CREATE TABLE "client_update_reads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"update_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"first_opened_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "client_updates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"matter_id" uuid NOT NULL,
	"recipient_party_ids" uuid[] NOT NULL,
	"body" text NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"author_type" text NOT NULL,
	"author_user_id" uuid,
	"status" text NOT NULL,
	"approved_by_user_id" uuid,
	"approved_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"corrects_update_id" uuid,
	"source_event_ref" text,
	"source_version" text,
	"check_findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"approval_task_id" uuid,
	"discarded_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_updates_author_type_check" CHECK ("client_updates"."author_type" in ('user','ai','system_draft')),
	CONSTRAINT "client_updates_status_check" CHECK ("client_updates"."status" in ('draft','pending_approval','sent','discarded')),
	CONSTRAINT "client_updates_recipients_check" CHECK (cardinality("client_updates"."recipient_party_ids") > 0),
	CONSTRAINT "client_updates_ai_approval_check" CHECK ("client_updates"."status" <> 'sent' or "client_updates"."author_type" = 'user' or ("client_updates"."approved_by_user_id" is not null and "client_updates"."approved_at" is not null)),
	CONSTRAINT "client_updates_sent_at_check" CHECK ("client_updates"."status" <> 'sent' or "client_updates"."sent_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "court_case_refs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"matter_id" uuid NOT NULL,
	"cause_number" text NOT NULL,
	"court_name" text,
	"added_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "court_notice_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"notice_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"mime_type" text,
	"size_bytes" bigint,
	"sha256" text,
	"storage_key" text,
	"document_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "court_notice_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"notice_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"snippet" text NOT NULL,
	"proposed_at" timestamp with time zone,
	"extracted_by" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"calendar_event_id" uuid,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "court_notice_suggestions_kind_check" CHECK ("court_notice_suggestions"."kind" in ('explicit_date','relative_period')),
	CONSTRAINT "court_notice_suggestions_label_check" CHECK ("court_notice_suggestions"."label" in ('hearing','trial','deadline','other')),
	CONSTRAINT "court_notice_suggestions_extracted_by_check" CHECK ("court_notice_suggestions"."extracted_by" in ('rules','ai')),
	CONSTRAINT "court_notice_suggestions_status_check" CHECK ("court_notice_suggestions"."status" in ('open','confirmed','rejected')),
	CONSTRAINT "court_notice_suggestions_relative_no_date_check" CHECK ("court_notice_suggestions"."kind" <> 'relative_period' or "court_notice_suggestions"."proposed_at" is null),
	CONSTRAINT "court_notice_suggestions_decided_check" CHECK ("court_notice_suggestions"."status" = 'open' or ("court_notice_suggestions"."decided_by_user_id" is not null and "court_notice_suggestions"."decided_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "court_notices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"source" text NOT NULL,
	"source_account" text,
	"external_id" text NOT NULL,
	"from_address" text NOT NULL,
	"from_domain" text NOT NULL,
	"from_display_name" text,
	"subject" text NOT NULL,
	"body_text" text,
	"received_at" timestamp with time zone NOT NULL,
	"auth_results" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"classification" text NOT NULL,
	"classification_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"trusted_sender" text,
	"matter_id" uuid,
	"match_method" text,
	"match_detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text NOT NULL,
	"alert_flag_id" uuid,
	"ack_due_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by_user_id" uuid,
	"escalation_step" integer DEFAULT 0 NOT NULL,
	"dismissed_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "court_notices_source_check" CHECK ("court_notices"."source" in ('mailbox','efiling','manual')),
	CONSTRAINT "court_notices_classification_check" CHECK ("court_notices"."classification" in ('court_verified','possible_phishing')),
	CONSTRAINT "court_notices_status_check" CHECK ("court_notices"."status" in ('matched','unmatched','phishing_review','dismissed')),
	CONSTRAINT "court_notices_match_method_check" CHECK ("court_notices"."match_method" is null or "court_notices"."match_method" in ('cause_number','party_name','staff')),
	CONSTRAINT "court_notices_phishing_no_body_check" CHECK ("court_notices"."classification" <> 'possible_phishing' or "court_notices"."body_text" is null),
	CONSTRAINT "court_notices_matched_has_matter_check" CHECK ("court_notices"."status" <> 'matched' or "court_notices"."matter_id" is not null),
	CONSTRAINT "court_notices_dismissed_reason_check" CHECK ("court_notices"."status" <> 'dismissed' or ("court_notices"."dismissed_reason" is not null and length("court_notices"."dismissed_reason") > 0))
);
--> statement-breakpoint
CREATE TABLE "delivery_followups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"notification_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"flag_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_followups_kind_check" CHECK ("delivery_followups"."kind" in ('bounced','failed','suppressed_no_address','email_missing'))
);
--> statement-breakpoint
CREATE TABLE "matter_health_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"matter_id" uuid NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	"score" integer,
	"firm_subscore" integer,
	"client_subscore" integer,
	"band" text NOT NULL,
	"falling_sharply" boolean DEFAULT false NOT NULL,
	"urgency_multiplier_pct" integer DEFAULT 100 NOT NULL,
	"rank_value" integer DEFAULT 0 NOT NULL,
	"reasons" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"signals" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"flag_id" uuid,
	CONSTRAINT "matter_health_snapshots_band_check" CHECK ("matter_health_snapshots"."band" in ('green','amber','red','insufficient_data')),
	CONSTRAINT "matter_health_snapshots_score_check" CHECK ("matter_health_snapshots"."score" is null or ("matter_health_snapshots"."score" between 0 and 100))
);
--> statement-breakpoint
CREATE TABLE "reply_clocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"matter_id" uuid NOT NULL,
	"thread_key" text DEFAULT 'main' NOT NULL,
	"first_message_id" uuid NOT NULL,
	"task_id" uuid,
	"tier" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"flag_hours" integer NOT NULL,
	"promise_hours" integer NOT NULL,
	"flag_at" timestamp with time zone NOT NULL,
	"promise_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"flagged_at" timestamp with time zone,
	"promise_missed_at" timestamp with time zone,
	"immediate_alert_at" timestamp with time zone,
	"immediate_alert_reason" text,
	"immediate_flag_id" uuid,
	"earliest_deadline_at" timestamp with time zone,
	"earliest_deadline_source" text,
	"message_count" integer DEFAULT 1 NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_by_user_id" uuid,
	"close_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reply_clocks_tier_check" CHECK ("reply_clocks"."tier" in ('standard','deadline')),
	CONSTRAINT "reply_clocks_status_check" CHECK ("reply_clocks"."status" in ('open','replied','closed','cancelled')),
	CONSTRAINT "reply_clocks_flag_before_promise_check" CHECK ("reply_clocks"."flag_hours" <= "reply_clocks"."promise_hours"),
	CONSTRAINT "reply_clocks_close_reason_check" CHECK ("reply_clocks"."status" <> 'closed' or ("reply_clocks"."close_reason" is not null and length("reply_clocks"."close_reason") > 0)),
	CONSTRAINT "reply_clocks_deadline_source_check" CHECK ("reply_clocks"."earliest_deadline_source" is null or "reply_clocks"."earliest_deadline_source" in ('calendar','client_stated'))
);
--> statement-breakpoint
CREATE TABLE "stall_watches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"item_type" text NOT NULL,
	"item_id" uuid NOT NULL,
	"matter_id" uuid,
	"stage" text NOT NULL,
	"last_activity_at" timestamp with time zone NOT NULL,
	"last_activity_label" text,
	"owner_user_id" uuid,
	"flag_id" uuid,
	"status" text NOT NULL,
	"check_back_at" timestamp with time zone,
	"reason" text,
	"set_by_user_id" uuid,
	"cleared_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stall_watches_item_type_check" CHECK ("stall_watches"."item_type" in ('intake_session','conflict_check','matter','document')),
	CONSTRAINT "stall_watches_status_check" CHECK ("stall_watches"."status" in ('flagged','check_back','cleared')),
	CONSTRAINT "stall_watches_check_back_check" CHECK ("stall_watches"."status" <> 'check_back' or ("stall_watches"."check_back_at" is not null and "stall_watches"."reason" is not null and length("stall_watches"."reason") > 0))
);
--> statement-breakpoint
CREATE TABLE "calendar_event_parties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"role" text DEFAULT 'other' NOT NULL,
	"added_by_user_id" uuid,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_event_parties_role_check" CHECK ("calendar_event_parties"."role" in ('client','witness','opposing_counsel','opposing_party','mediator','judge','expert','other'))
);
--> statement-breakpoint
CREATE TABLE "calendar_sync_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"token_ref" text,
	"external_calendar_id" text,
	"direction" text DEFAULT 'two_way' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"pull_cursor" text,
	"last_pushed_at" timestamp with time zone,
	"last_pulled_at" timestamp with time zone,
	"last_error" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disconnected_at" timestamp with time zone,
	CONSTRAINT "calendar_sync_connections_provider_check" CHECK ("calendar_sync_connections"."provider" in ('microsoft','google')),
	CONSTRAINT "calendar_sync_connections_direction_check" CHECK ("calendar_sync_connections"."direction" in ('two_way','push_only','pull_only'))
);
--> statement-breakpoint
CREATE TABLE "calendar_sync_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"external_id" text,
	"external_etag" text,
	"pending_op" text DEFAULT 'create' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"origin" text DEFAULT 'outbound' NOT NULL,
	"last_synced_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_sync_links_op_check" CHECK ("calendar_sync_links"."pending_op" in ('create','update','delete','none')),
	CONSTRAINT "calendar_sync_links_status_check" CHECK ("calendar_sync_links"."status" in ('pending','synced','held','failed')),
	CONSTRAINT "calendar_sync_links_origin_check" CHECK ("calendar_sync_links"."origin" in ('outbound','inbound'))
);
--> statement-breakpoint
CREATE TABLE "deadline_calculations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"matter_id" uuid NOT NULL,
	"rule_set_id" uuid NOT NULL,
	"rule_set_version" integer NOT NULL,
	"trigger_key" text NOT NULL,
	"trigger_at" timestamp with time zone NOT NULL,
	"service_method" text,
	"results" jsonb NOT NULL,
	"calculated_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deadline_rule_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"key" text NOT NULL,
	"version" integer NOT NULL,
	"name" text NOT NULL,
	"jurisdiction" text NOT NULL,
	"court" text,
	"origin" text DEFAULT 'firm_config' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"config" jsonb NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_by_user_id" uuid,
	"approved_at" timestamp with time zone,
	"approval_note" text,
	"retired_at" timestamp with time zone,
	CONSTRAINT "deadline_rule_sets_status_check" CHECK ("deadline_rule_sets"."status" in ('draft','approved','retired')),
	CONSTRAINT "deadline_rule_sets_origin_check" CHECK ("deadline_rule_sets"."origin" in ('firm_config','licensed_provider','example')),
	CONSTRAINT "deadline_rule_sets_approved_check" CHECK ("deadline_rule_sets"."status" <> 'approved' or ("deadline_rule_sets"."approved_by_user_id" is not null and "deadline_rule_sets"."approved_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "limitation_date_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"limitation_id" uuid NOT NULL,
	"from_version" integer NOT NULL,
	"to_version" integer NOT NULL,
	"from_date" text NOT NULL,
	"to_date" text NOT NULL,
	"reason" text NOT NULL,
	"changed_by_user_id" uuid NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "limitation_date_changes_reason_check" CHECK (length(trim("limitation_date_changes"."reason")) > 0)
);
--> statement-breakpoint
CREATE TABLE "limitation_dates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"matter_id" uuid NOT NULL,
	"claim_description" text NOT NULL,
	"limitation_date" text NOT NULL,
	"accrual_date" text,
	"basis" text,
	"status" text DEFAULT 'unverified' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"entered_by_user_id" uuid NOT NULL,
	"entered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_changed_by_user_id" uuid,
	"last_changed_at" timestamp with time zone,
	"verified_by_user_id" uuid,
	"verified_at" timestamp with time zone,
	"closed_reason" text,
	"closed_by_user_id" uuid,
	"closed_at" timestamp with time zone,
	"calendar_event_id" uuid,
	"filing_task_id" uuid,
	"verify_task_id" uuid,
	"source" text DEFAULT 'lawyer_entry' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "limitation_dates_date_check" CHECK ("limitation_dates"."limitation_date" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
	CONSTRAINT "limitation_dates_accrual_check" CHECK ("limitation_dates"."accrual_date" is null or "limitation_dates"."accrual_date" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
	CONSTRAINT "limitation_dates_status_check" CHECK ("limitation_dates"."status" in ('unverified','verified','disputed','satisfied','withdrawn')),
	CONSTRAINT "limitation_dates_source_check" CHECK ("limitation_dates"."source" in ('lawyer_entry','intake_risk')),
	CONSTRAINT "limitation_dates_verified_check" CHECK ("limitation_dates"."status" <> 'verified' or ("limitation_dates"."verified_by_user_id" is not null and "limitation_dates"."verified_at" is not null
      and "limitation_dates"."verified_by_user_id" <> "limitation_dates"."entered_by_user_id"
      and ("limitation_dates"."last_changed_by_user_id" is null or "limitation_dates"."verified_by_user_id" <> "limitation_dates"."last_changed_by_user_id"))),
	CONSTRAINT "limitation_dates_closed_check" CHECK ("limitation_dates"."status" not in ('satisfied','withdrawn') or ("limitation_dates"."closed_by_user_id" is not null and coalesce(length(trim("limitation_dates"."closed_reason")), 0) > 0))
);
--> statement-breakpoint
CREATE TABLE "limitation_reminders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"limitation_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"threshold_days" integer NOT NULL,
	"sent" boolean DEFAULT true NOT NULL,
	"flag_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "limitation_verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"limitation_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"verifier_user_id" uuid NOT NULL,
	"verifier_date" text NOT NULL,
	"outcome" text NOT NULL,
	"method" text,
	"notes" text,
	"verified_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "limitation_verifications_outcome_check" CHECK ("limitation_verifications"."outcome" in ('match','mismatch')),
	CONSTRAINT "limitation_verifications_date_check" CHECK ("limitation_verifications"."verifier_date" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
);
--> statement-breakpoint
CREATE TABLE "matter_closings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"matter_id" uuid NOT NULL,
	"status" text DEFAULT 'in_progress' NOT NULL,
	"started_by_user_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"checklist_task_id" uuid,
	"trust_zero_confirmed_by_user_id" uuid,
	"trust_zero_confirmed_at" timestamp with time zone,
	"trust_zero_source" text,
	"closed_by_user_id" uuid,
	"closed_at" timestamp with time zone,
	"abandon_reason" text,
	CONSTRAINT "matter_closings_status_check" CHECK ("matter_closings"."status" in ('in_progress','closed','abandoned')),
	CONSTRAINT "matter_closings_trust_source_check" CHECK ("matter_closings"."trust_zero_source" is null or "matter_closings"."trust_zero_source" in ('lawyer_attestation','billing_engine')),
	CONSTRAINT "matter_closings_closed_check" CHECK ("matter_closings"."status" <> 'closed' or ("matter_closings"."closed_by_user_id" is not null and "matter_closings"."closed_at" is not null and "matter_closings"."trust_zero_confirmed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "matter_lifecycle" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"matter_id" uuid NOT NULL,
	"practice_area" text NOT NULL,
	"definition_id" uuid NOT NULL,
	"stage_key" text NOT NULL,
	"entered_stage_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "matter_lifecycle_status_check" CHECK ("matter_lifecycle"."status" in ('open','closing','closed'))
);
--> statement-breakpoint
CREATE TABLE "matter_limitation_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"matter_id" uuid NOT NULL,
	"applicability" text DEFAULT 'unknown' NOT NULL,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"reason" text,
	"intake_risk_flag_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "matter_limitation_profiles_applicability_check" CHECK ("matter_limitation_profiles"."applicability" in ('unknown','applies','not_applicable')),
	CONSTRAINT "matter_limitation_profiles_decided_check" CHECK ("matter_limitation_profiles"."applicability" = 'unknown' or ("matter_limitation_profiles"."decided_by_user_id" is not null and "matter_limitation_profiles"."decided_at" is not null)),
	CONSTRAINT "matter_limitation_profiles_na_reason_check" CHECK ("matter_limitation_profiles"."applicability" <> 'not_applicable' or coalesce(length(trim("matter_limitation_profiles"."reason")), 0) > 0)
);
--> statement-breakpoint
CREATE TABLE "matter_stage_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"practice_area" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"name" text NOT NULL,
	"stages" jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"system_draft" boolean DEFAULT false NOT NULL,
	"created_by_user_id" uuid,
	"activated_by_user_id" uuid,
	"activated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "matter_stage_definitions_status_check" CHECK ("matter_stage_definitions"."status" in ('draft','active','retired')),
	CONSTRAINT "matter_stage_definitions_active_check" CHECK ("matter_stage_definitions"."status" <> 'active' or ("matter_stage_definitions"."activated_by_user_id" is not null and "matter_stage_definitions"."activated_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "matter_stage_transitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"matter_id" uuid NOT NULL,
	"definition_id" uuid NOT NULL,
	"from_stage_key" text,
	"to_stage_key" text NOT NULL,
	"reason" text,
	"billing_event" text,
	"by_user_id" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_list_run_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"item_key" text NOT NULL,
	"depends_on" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" text DEFAULT 'waiting' NOT NULL,
	"task_id" uuid,
	"released_at" timestamp with time zone,
	"skip_reason" text,
	CONSTRAINT "task_list_run_items_status_check" CHECK ("task_list_run_items"."status" in ('waiting','released','skipped')),
	CONSTRAINT "task_list_run_items_released_check" CHECK ("task_list_run_items"."status" <> 'released' or "task_list_run_items"."task_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "task_list_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"matter_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"template_key" text NOT NULL,
	"template_version" integer NOT NULL,
	"stage_transition_id" uuid,
	"status" text DEFAULT 'running' NOT NULL,
	"started_by_user_id" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "task_list_runs_status_check" CHECK ("task_list_runs"."status" in ('running','completed','cancelled'))
);
--> statement-breakpoint
CREATE TABLE "task_list_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"key" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"practice_area" text NOT NULL,
	"name" text NOT NULL,
	"trigger_stage_key" text,
	"items" jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"system_draft" boolean DEFAULT false NOT NULL,
	"created_by_user_id" uuid,
	"activated_by_user_id" uuid,
	"activated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_list_templates_status_check" CHECK ("task_list_templates"."status" in ('draft','active','retired')),
	CONSTRAINT "task_list_templates_active_check" CHECK ("task_list_templates"."status" <> 'active' or ("task_list_templates"."activated_by_user_id" is not null and "task_list_templates"."activated_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "document_access_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"matter_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"note" text,
	"source" text DEFAULT 'manual' NOT NULL,
	"source_ref" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"ended_by_user_id" uuid,
	"ended_reason" text,
	CONSTRAINT "document_access_blocks_reason_check" CHECK ("document_access_blocks"."reason" in ('ethical_screen','restricted','other')),
	CONSTRAINT "document_access_blocks_source_check" CHECK ("document_access_blocks"."source" in ('manual','sync')),
	CONSTRAINT "document_access_blocks_ended_check" CHECK ("document_access_blocks"."ended_at" is null or "document_access_blocks"."ended_reason" is not null)
);
--> statement-breakpoint
CREATE TABLE "document_access_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"document_id" uuid,
	"group_id" uuid,
	"matter_id" uuid,
	"actor_type" text NOT NULL,
	"actor_user_id" uuid,
	"actor_party_id" uuid,
	"action" text NOT NULL,
	"outcome" text NOT NULL,
	"reason" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_access_log_actor_type_check" CHECK ("document_access_log"."actor_type" in ('user','client','system')),
	CONSTRAINT "document_access_log_action_check" CHECK ("document_access_log"."action" in ('view','download','list','search','version_history')),
	CONSTRAINT "document_access_log_outcome_check" CHECK ("document_access_log"."outcome" in ('allowed','denied')),
	CONSTRAINT "document_access_log_denied_reason_check" CHECK ("document_access_log"."outcome" <> 'denied' or "document_access_log"."reason" is not null)
);
--> statement-breakpoint
CREATE TABLE "document_folder_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"practice_area" text,
	"version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"folders" jsonb NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone,
	"activated_by_user_id" uuid,
	"retired_at" timestamp with time zone,
	CONSTRAINT "document_folder_templates_status_check" CHECK ("document_folder_templates"."status" in ('draft','active','retired')),
	CONSTRAINT "document_folder_templates_version_check" CHECK ("document_folder_templates"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "document_folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"matter_id" uuid NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"template_key" text,
	"template_id" uuid,
	"default_privilege_tag" text DEFAULT 'none' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "document_folders_privilege_tag_check" CHECK ("document_folders"."default_privilege_tag" in ('none','privileged','work_product','confidential','sealed'))
);
--> statement-breakpoint
CREATE TABLE "document_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"group_document_id" uuid NOT NULL,
	"matter_id" uuid NOT NULL,
	"folder_id" uuid,
	"title" text NOT NULL,
	"current_document_id" uuid NOT NULL,
	"latest_version" integer DEFAULT 1 NOT NULL,
	"legal_hold" boolean DEFAULT false NOT NULL,
	"legal_hold_reason" text,
	"original_held" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "document_groups_latest_version_check" CHECK ("document_groups"."latest_version" >= 1),
	CONSTRAINT "document_groups_hold_reason_check" CHECK (not "document_groups"."legal_hold" or "document_groups"."legal_hold_reason" is not null)
);
--> statement-breakpoint
CREATE TABLE "document_retention_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"practice_area" text,
	"document_type" text,
	"retain_years_after_close" integer NOT NULL,
	"basis" text NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_at" timestamp with time zone,
	"superseded_by_user_id" uuid,
	CONSTRAINT "document_retention_rules_years_check" CHECK ("document_retention_rules"."retain_years_after_close" between 0 and 100)
);
--> statement-breakpoint
CREATE TABLE "document_text" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"matter_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"method" text,
	"content" text DEFAULT '' NOT NULL,
	"truncated" boolean DEFAULT false NOT NULL,
	"page_count" integer,
	"detail" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"extracted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"search_vector" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('english'::regconfig, coalesce(title, '')), 'A') || setweight(to_tsvector('english'::regconfig, coalesce(content, '')), 'B')) STORED,
	CONSTRAINT "document_text_status_check" CHECK ("document_text"."status" in ('pending','extracted','ocr_pending','unsupported','failed','blocked')),
	CONSTRAINT "document_text_method_check" CHECK ("document_text"."method" is null or "document_text"."method" in ('native','ocr'))
);
--> statement-breakpoint
CREATE TABLE "document_version_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"storage_adapter" text NOT NULL,
	"storage_key" text NOT NULL,
	"sha256" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"detected_mime_type" text,
	"declared_mime_type" text,
	"original_filename" text,
	"encryption" text NOT NULL,
	"scan_status" text DEFAULT 'pending' NOT NULL,
	"scan_detail" text,
	"scanned_at" timestamp with time zone,
	"quarantined_at" timestamp with time zone,
	"last_verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_version_files_scan_status_check" CHECK ("document_version_files"."scan_status" in ('pending','clean','infected','error','not_scanned')),
	CONSTRAINT "document_version_files_sha_check" CHECK ("document_version_files"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "document_version_files_size_check" CHECK ("document_version_files"."size_bytes" >= 0),
	CONSTRAINT "document_version_files_quarantine_check" CHECK ("document_version_files"."scan_status" <> 'infected' or "document_version_files"."quarantined_at" is not null)
);
--> statement-breakpoint
ALTER TABLE "access_change_log" ADD CONSTRAINT "access_change_log_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_change_log" ADD CONSTRAINT "access_change_log_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_change_log" ADD CONSTRAINT "access_change_log_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_change_log" ADD CONSTRAINT "access_change_log_matter_id_matters_id_fk" FOREIGN KEY ("matter_id") REFERENCES "public"."matters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "firm_role_assignments" ADD CONSTRAINT "firm_role_assignments_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "firm_role_assignments" ADD CONSTRAINT "firm_role_assignments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "firm_role_assignments" ADD CONSTRAINT "firm_role_assignments_granted_by_user_id_users_id_fk" FOREIGN KEY ("granted_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "firm_role_assignments" ADD CONSTRAINT "firm_role_assignments_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matter_access_settings" ADD CONSTRAINT "matter_access_settings_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matter_access_settings" ADD CONSTRAINT "matter_access_settings_matter_id_matters_id_fk" FOREIGN KEY ("matter_id") REFERENCES "public"."matters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matter_access_settings" ADD CONSTRAINT "matter_access_settings_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matter_team_members" ADD CONSTRAINT "matter_team_members_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matter_team_members" ADD CONSTRAINT "matter_team_members_matter_id_matters_id_fk" FOREIGN KEY ("matter_id") REFERENCES "public"."matters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matter_team_members" ADD CONSTRAINT "matter_team_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matter_team_members" ADD CONSTRAINT "matter_team_members_added_by_user_id_users_id_fk" FOREIGN KEY ("added_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matter_team_members" ADD CONSTRAINT "matter_team_members_removed_by_user_id_users_id_fk" FOREIGN KEY ("removed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_overrides" ADD CONSTRAINT "permission_overrides_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_overrides" ADD CONSTRAINT "permission_overrides_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "practice_area_pack_adoptions" ADD CONSTRAINT "practice_area_pack_adoptions_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "practice_area_pack_adoptions" ADD CONSTRAINT "practice_area_pack_adoptions_accepted_by_user_id_users_id_fk" FOREIGN KEY ("accepted_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trust_account_books" ADD CONSTRAINT "trust_account_books_trust_account_id_trust_accounts_id_fk" FOREIGN KEY ("trust_account_id") REFERENCES "public"."trust_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trust_account_books" ADD CONSTRAINT "trust_account_books_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trust_accounts" ADD CONSTRAINT "trust_accounts_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trust_accounts" ADD CONSTRAINT "trust_accounts_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trust_bank_statement_lines" ADD CONSTRAINT "trust_bank_statement_lines_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trust_bank_statement_lines" ADD CONSTRAINT "trust_bank_statement_lines_statement_id_trust_bank_statements_id_fk" FOREIGN KEY ("statement_id") REFERENCES "public"."trust_bank_statements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trust_bank_statements" ADD CONSTRAINT "trust_bank_statements_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trust_bank_statements" ADD CONSTRAINT "trust_bank_statements_trust_account_id_trust_accounts_id_fk" FOREIGN KEY ("trust_account_id") REFERENCES "public"."trust_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trust_bank_statements" ADD CONSTRAINT "trust_bank_statements_entered_by_user_id_users_id_fk" FOREIGN KEY ("entered_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trust_hold_releases" ADD CONSTRAINT "trust_hold_releases_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trust_hold_releases" ADD CONSTRAINT "trust_hold_releases_hold_id_trust_holds_id_fk" FOREIGN KEY ("hold_id") REFERENCES "public"."trust_holds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trust_hold_releases" ADD CONSTRAINT "trust_hold_releases_released_by_user_id_users_id_fk" FOREIGN KEY ("released_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trust_holds" ADD CONSTRAINT "trust_holds_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trust_holds" ADD CONSTRAINT "trust_holds_trust_account_id_trust_accounts_id_fk" FOREIGN KEY ("trust_account_id") REFERENCES "public"."trust_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trust_holds" ADD CONSTRAINT "trust_holds_subledger_id_trust_subledgers_id_fk" FOREIGN KEY ("subledger_id") REFERENCES "public"."trust_subledgers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trust_holds" ADD CONSTRAINT "trust_holds_placed_by_user_id_users_id_fk" FOREIGN KEY ("placed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trust_ledger_entries" ADD CONSTRAINT "trust_ledger_entries_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trust_ledger_entries" ADD CONSTRAINT "trust_ledger_entries_transaction_id_trust_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."trust_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trust_ledger_entries" ADD CONSTRAINT "trust_ledger_entries_trust_account_id_trust_accounts_id_fk" FOREIGN KEY ("trust_account_id") REFERENCES "public"."trust_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trust_ledger_entries" ADD CONSTRAINT "trust_ledger_entries_subledger_id_trust_subledgers_id_fk" FOREIGN KEY ("subledger_id") REFERENCES "public"."trust_subledgers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trust_period_closes" ADD CONSTRAINT "trust_period_closes_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trust_period_closes" ADD CONSTRAINT "trust_period_closes_trust_account_id_trust_accounts_id_fk" FOREIGN KEY ("trust_account_id") REFERENCES "public"."trust_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trust_period_closes" ADD CONSTRAINT "trust_period_closes_reconciliation_id_trust_reconciliations_id_fk" FOREIGN KEY ("reconciliation_id") REFERENCES "public"."trust_reconciliations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trust_period_closes" ADD CONSTRAINT "trust_period_closes_closed_by_user_id_users_id_fk" FOREIGN KEY ("closed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trust_reconciliation_signoffs" ADD CONSTRAINT "trust_reconciliation_signoffs_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trust_reconciliation_signoffs" ADD CONSTRAINT "trust_reconciliation_signoffs_reconciliation_id_trust_reconciliations_id_fk" FOREIGN KEY ("reconciliation_id") REFERENCES "public"."trust_reconciliations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trust_reconciliation_signoffs" ADD CONSTRAINT "trust_reconciliation_signoffs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trust_reconciliations" ADD CONSTRAINT "trust_reconciliations_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trust_reconciliations" ADD CONSTRAINT "trust_reconciliations_trust_account_id_trust_accounts_id_fk" FOREIGN KEY ("trust_account_id") REFERENCES "public"."trust_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trust_reconciliations" ADD CONSTRAINT "trust_reconciliations_statement_id_trust_bank_statements_id_fk" FOREIGN KEY ("statement_id") REFERENCES "public"."trust_bank_statements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trust_reconciliations" ADD CONSTRAINT "trust_reconciliations_prepared_by_user_id_users_id_fk" FOREIGN KEY ("prepared_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trust_subledgers" ADD CONSTRAINT "trust_subledgers_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trust_subledgers" ADD CONSTRAINT "trust_subledgers_trust_account_id_trust_accounts_id_fk" FOREIGN KEY ("trust_account_id") REFERENCES "public"."trust_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trust_subledgers" ADD CONSTRAINT "trust_subledgers_client_party_id_parties_id_fk" FOREIGN KEY ("client_party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trust_subledgers" ADD CONSTRAINT "trust_subledgers_matter_id_matters_id_fk" FOREIGN KEY ("matter_id") REFERENCES "public"."matters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trust_subledgers" ADD CONSTRAINT "trust_subledgers_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trust_transactions" ADD CONSTRAINT "trust_transactions_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trust_transactions" ADD CONSTRAINT "trust_transactions_trust_account_id_trust_accounts_id_fk" FOREIGN KEY ("trust_account_id") REFERENCES "public"."trust_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trust_transactions" ADD CONSTRAINT "trust_transactions_posted_by_user_id_users_id_fk" FOREIGN KEY ("posted_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_digest_items" ADD CONSTRAINT "alert_digest_items_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_digest_items" ADD CONSTRAINT "alert_digest_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_digest_items" ADD CONSTRAINT "alert_digest_items_flag_id_flags_id_fk" FOREIGN KEY ("flag_id") REFERENCES "public"."flags"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_digest_items" ADD CONSTRAINT "alert_digest_items_notification_id_notification_outbox_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notification_outbox"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_job_runs" ADD CONSTRAINT "alert_job_runs_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_chase_ladders" ADD CONSTRAINT "client_chase_ladders_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_chase_ladders" ADD CONSTRAINT "client_chase_ladders_matter_id_matters_id_fk" FOREIGN KEY ("matter_id") REFERENCES "public"."matters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_chase_ladders" ADD CONSTRAINT "client_chase_ladders_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_chase_ladders" ADD CONSTRAINT "client_chase_ladders_message_id_client_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."client_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_chase_ladders" ADD CONSTRAINT "client_chase_ladders_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_chase_ladders" ADD CONSTRAINT "client_chase_ladders_internal_flag_id_flags_id_fk" FOREIGN KEY ("internal_flag_id") REFERENCES "public"."flags"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_chase_ladders" ADD CONSTRAINT "client_chase_ladders_decision_task_id_tasks_id_fk" FOREIGN KEY ("decision_task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_messages" ADD CONSTRAINT "client_messages_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_messages" ADD CONSTRAINT "client_messages_matter_id_matters_id_fk" FOREIGN KEY ("matter_id") REFERENCES "public"."matters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_messages" ADD CONSTRAINT "client_messages_sender_user_id_users_id_fk" FOREIGN KEY ("sender_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_messages" ADD CONSTRAINT "client_messages_sender_party_id_parties_id_fk" FOREIGN KEY ("sender_party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_messages" ADD CONSTRAINT "client_messages_client_party_id_parties_id_fk" FOREIGN KEY ("client_party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_messages" ADD CONSTRAINT "client_messages_related_calendar_event_id_calendar_events_id_fk" FOREIGN KEY ("related_calendar_event_id") REFERENCES "public"."calendar_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_update_cadences" ADD CONSTRAINT "client_update_cadences_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_update_cadences" ADD CONSTRAINT "client_update_cadences_matter_id_matters_id_fk" FOREIGN KEY ("matter_id") REFERENCES "public"."matters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_update_cadences" ADD CONSTRAINT "client_update_cadences_current_task_id_tasks_id_fk" FOREIGN KEY ("current_task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_update_cadences" ADD CONSTRAINT "client_update_cadences_set_by_user_id_users_id_fk" FOREIGN KEY ("set_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_update_reads" ADD CONSTRAINT "client_update_reads_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_update_reads" ADD CONSTRAINT "client_update_reads_update_id_client_updates_id_fk" FOREIGN KEY ("update_id") REFERENCES "public"."client_updates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_update_reads" ADD CONSTRAINT "client_update_reads_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_updates" ADD CONSTRAINT "client_updates_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_updates" ADD CONSTRAINT "client_updates_matter_id_matters_id_fk" FOREIGN KEY ("matter_id") REFERENCES "public"."matters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_updates" ADD CONSTRAINT "client_updates_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_updates" ADD CONSTRAINT "client_updates_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_updates" ADD CONSTRAINT "client_updates_approval_task_id_tasks_id_fk" FOREIGN KEY ("approval_task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "court_case_refs" ADD CONSTRAINT "court_case_refs_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "court_case_refs" ADD CONSTRAINT "court_case_refs_matter_id_matters_id_fk" FOREIGN KEY ("matter_id") REFERENCES "public"."matters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "court_case_refs" ADD CONSTRAINT "court_case_refs_added_by_user_id_users_id_fk" FOREIGN KEY ("added_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "court_notice_attachments" ADD CONSTRAINT "court_notice_attachments_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "court_notice_attachments" ADD CONSTRAINT "court_notice_attachments_notice_id_court_notices_id_fk" FOREIGN KEY ("notice_id") REFERENCES "public"."court_notices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "court_notice_attachments" ADD CONSTRAINT "court_notice_attachments_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "court_notice_suggestions" ADD CONSTRAINT "court_notice_suggestions_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "court_notice_suggestions" ADD CONSTRAINT "court_notice_suggestions_notice_id_court_notices_id_fk" FOREIGN KEY ("notice_id") REFERENCES "public"."court_notices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "court_notice_suggestions" ADD CONSTRAINT "court_notice_suggestions_calendar_event_id_calendar_events_id_fk" FOREIGN KEY ("calendar_event_id") REFERENCES "public"."calendar_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "court_notice_suggestions" ADD CONSTRAINT "court_notice_suggestions_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "court_notices" ADD CONSTRAINT "court_notices_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "court_notices" ADD CONSTRAINT "court_notices_matter_id_matters_id_fk" FOREIGN KEY ("matter_id") REFERENCES "public"."matters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "court_notices" ADD CONSTRAINT "court_notices_alert_flag_id_flags_id_fk" FOREIGN KEY ("alert_flag_id") REFERENCES "public"."flags"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "court_notices" ADD CONSTRAINT "court_notices_acknowledged_by_user_id_users_id_fk" FOREIGN KEY ("acknowledged_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_followups" ADD CONSTRAINT "delivery_followups_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_followups" ADD CONSTRAINT "delivery_followups_notification_id_notification_outbox_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notification_outbox"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_followups" ADD CONSTRAINT "delivery_followups_flag_id_flags_id_fk" FOREIGN KEY ("flag_id") REFERENCES "public"."flags"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matter_health_snapshots" ADD CONSTRAINT "matter_health_snapshots_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matter_health_snapshots" ADD CONSTRAINT "matter_health_snapshots_matter_id_matters_id_fk" FOREIGN KEY ("matter_id") REFERENCES "public"."matters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matter_health_snapshots" ADD CONSTRAINT "matter_health_snapshots_flag_id_flags_id_fk" FOREIGN KEY ("flag_id") REFERENCES "public"."flags"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reply_clocks" ADD CONSTRAINT "reply_clocks_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reply_clocks" ADD CONSTRAINT "reply_clocks_matter_id_matters_id_fk" FOREIGN KEY ("matter_id") REFERENCES "public"."matters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reply_clocks" ADD CONSTRAINT "reply_clocks_first_message_id_client_messages_id_fk" FOREIGN KEY ("first_message_id") REFERENCES "public"."client_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reply_clocks" ADD CONSTRAINT "reply_clocks_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reply_clocks" ADD CONSTRAINT "reply_clocks_immediate_flag_id_flags_id_fk" FOREIGN KEY ("immediate_flag_id") REFERENCES "public"."flags"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reply_clocks" ADD CONSTRAINT "reply_clocks_closed_by_user_id_users_id_fk" FOREIGN KEY ("closed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stall_watches" ADD CONSTRAINT "stall_watches_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stall_watches" ADD CONSTRAINT "stall_watches_matter_id_matters_id_fk" FOREIGN KEY ("matter_id") REFERENCES "public"."matters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stall_watches" ADD CONSTRAINT "stall_watches_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stall_watches" ADD CONSTRAINT "stall_watches_flag_id_flags_id_fk" FOREIGN KEY ("flag_id") REFERENCES "public"."flags"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stall_watches" ADD CONSTRAINT "stall_watches_set_by_user_id_users_id_fk" FOREIGN KEY ("set_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_event_parties" ADD CONSTRAINT "calendar_event_parties_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_event_parties" ADD CONSTRAINT "calendar_event_parties_event_id_calendar_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."calendar_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_event_parties" ADD CONSTRAINT "calendar_event_parties_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_event_parties" ADD CONSTRAINT "calendar_event_parties_added_by_user_id_users_id_fk" FOREIGN KEY ("added_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_sync_connections" ADD CONSTRAINT "calendar_sync_connections_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_sync_connections" ADD CONSTRAINT "calendar_sync_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_sync_connections" ADD CONSTRAINT "calendar_sync_connections_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_sync_links" ADD CONSTRAINT "calendar_sync_links_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_sync_links" ADD CONSTRAINT "calendar_sync_links_event_id_calendar_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."calendar_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_sync_links" ADD CONSTRAINT "calendar_sync_links_connection_id_calendar_sync_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."calendar_sync_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deadline_calculations" ADD CONSTRAINT "deadline_calculations_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deadline_calculations" ADD CONSTRAINT "deadline_calculations_matter_id_matters_id_fk" FOREIGN KEY ("matter_id") REFERENCES "public"."matters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deadline_calculations" ADD CONSTRAINT "deadline_calculations_rule_set_id_deadline_rule_sets_id_fk" FOREIGN KEY ("rule_set_id") REFERENCES "public"."deadline_rule_sets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deadline_calculations" ADD CONSTRAINT "deadline_calculations_calculated_by_user_id_users_id_fk" FOREIGN KEY ("calculated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deadline_rule_sets" ADD CONSTRAINT "deadline_rule_sets_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deadline_rule_sets" ADD CONSTRAINT "deadline_rule_sets_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deadline_rule_sets" ADD CONSTRAINT "deadline_rule_sets_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "limitation_date_changes" ADD CONSTRAINT "limitation_date_changes_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "limitation_date_changes" ADD CONSTRAINT "limitation_date_changes_limitation_id_limitation_dates_id_fk" FOREIGN KEY ("limitation_id") REFERENCES "public"."limitation_dates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "limitation_date_changes" ADD CONSTRAINT "limitation_date_changes_changed_by_user_id_users_id_fk" FOREIGN KEY ("changed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "limitation_dates" ADD CONSTRAINT "limitation_dates_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "limitation_dates" ADD CONSTRAINT "limitation_dates_matter_id_matters_id_fk" FOREIGN KEY ("matter_id") REFERENCES "public"."matters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "limitation_dates" ADD CONSTRAINT "limitation_dates_entered_by_user_id_users_id_fk" FOREIGN KEY ("entered_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "limitation_dates" ADD CONSTRAINT "limitation_dates_last_changed_by_user_id_users_id_fk" FOREIGN KEY ("last_changed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "limitation_dates" ADD CONSTRAINT "limitation_dates_verified_by_user_id_users_id_fk" FOREIGN KEY ("verified_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "limitation_dates" ADD CONSTRAINT "limitation_dates_closed_by_user_id_users_id_fk" FOREIGN KEY ("closed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "limitation_dates" ADD CONSTRAINT "limitation_dates_calendar_event_id_calendar_events_id_fk" FOREIGN KEY ("calendar_event_id") REFERENCES "public"."calendar_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "limitation_dates" ADD CONSTRAINT "limitation_dates_filing_task_id_tasks_id_fk" FOREIGN KEY ("filing_task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "limitation_dates" ADD CONSTRAINT "limitation_dates_verify_task_id_tasks_id_fk" FOREIGN KEY ("verify_task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "limitation_reminders" ADD CONSTRAINT "limitation_reminders_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "limitation_reminders" ADD CONSTRAINT "limitation_reminders_limitation_id_limitation_dates_id_fk" FOREIGN KEY ("limitation_id") REFERENCES "public"."limitation_dates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "limitation_reminders" ADD CONSTRAINT "limitation_reminders_flag_id_flags_id_fk" FOREIGN KEY ("flag_id") REFERENCES "public"."flags"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "limitation_verifications" ADD CONSTRAINT "limitation_verifications_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "limitation_verifications" ADD CONSTRAINT "limitation_verifications_limitation_id_limitation_dates_id_fk" FOREIGN KEY ("limitation_id") REFERENCES "public"."limitation_dates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "limitation_verifications" ADD CONSTRAINT "limitation_verifications_verifier_user_id_users_id_fk" FOREIGN KEY ("verifier_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matter_closings" ADD CONSTRAINT "matter_closings_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matter_closings" ADD CONSTRAINT "matter_closings_matter_id_matters_id_fk" FOREIGN KEY ("matter_id") REFERENCES "public"."matters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matter_closings" ADD CONSTRAINT "matter_closings_started_by_user_id_users_id_fk" FOREIGN KEY ("started_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matter_closings" ADD CONSTRAINT "matter_closings_checklist_task_id_tasks_id_fk" FOREIGN KEY ("checklist_task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matter_closings" ADD CONSTRAINT "matter_closings_trust_zero_confirmed_by_user_id_users_id_fk" FOREIGN KEY ("trust_zero_confirmed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matter_closings" ADD CONSTRAINT "matter_closings_closed_by_user_id_users_id_fk" FOREIGN KEY ("closed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matter_lifecycle" ADD CONSTRAINT "matter_lifecycle_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matter_lifecycle" ADD CONSTRAINT "matter_lifecycle_matter_id_matters_id_fk" FOREIGN KEY ("matter_id") REFERENCES "public"."matters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matter_lifecycle" ADD CONSTRAINT "matter_lifecycle_definition_id_matter_stage_definitions_id_fk" FOREIGN KEY ("definition_id") REFERENCES "public"."matter_stage_definitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matter_limitation_profiles" ADD CONSTRAINT "matter_limitation_profiles_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matter_limitation_profiles" ADD CONSTRAINT "matter_limitation_profiles_matter_id_matters_id_fk" FOREIGN KEY ("matter_id") REFERENCES "public"."matters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matter_limitation_profiles" ADD CONSTRAINT "matter_limitation_profiles_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matter_limitation_profiles" ADD CONSTRAINT "matter_limitation_profiles_intake_risk_flag_id_flags_id_fk" FOREIGN KEY ("intake_risk_flag_id") REFERENCES "public"."flags"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matter_stage_definitions" ADD CONSTRAINT "matter_stage_definitions_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matter_stage_definitions" ADD CONSTRAINT "matter_stage_definitions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matter_stage_definitions" ADD CONSTRAINT "matter_stage_definitions_activated_by_user_id_users_id_fk" FOREIGN KEY ("activated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matter_stage_transitions" ADD CONSTRAINT "matter_stage_transitions_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matter_stage_transitions" ADD CONSTRAINT "matter_stage_transitions_matter_id_matters_id_fk" FOREIGN KEY ("matter_id") REFERENCES "public"."matters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matter_stage_transitions" ADD CONSTRAINT "matter_stage_transitions_definition_id_matter_stage_definitions_id_fk" FOREIGN KEY ("definition_id") REFERENCES "public"."matter_stage_definitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matter_stage_transitions" ADD CONSTRAINT "matter_stage_transitions_by_user_id_users_id_fk" FOREIGN KEY ("by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_list_run_items" ADD CONSTRAINT "task_list_run_items_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_list_run_items" ADD CONSTRAINT "task_list_run_items_run_id_task_list_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."task_list_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_list_run_items" ADD CONSTRAINT "task_list_run_items_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_list_runs" ADD CONSTRAINT "task_list_runs_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_list_runs" ADD CONSTRAINT "task_list_runs_matter_id_matters_id_fk" FOREIGN KEY ("matter_id") REFERENCES "public"."matters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_list_runs" ADD CONSTRAINT "task_list_runs_template_id_task_list_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."task_list_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_list_runs" ADD CONSTRAINT "task_list_runs_started_by_user_id_users_id_fk" FOREIGN KEY ("started_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_list_templates" ADD CONSTRAINT "task_list_templates_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_list_templates" ADD CONSTRAINT "task_list_templates_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_list_templates" ADD CONSTRAINT "task_list_templates_activated_by_user_id_users_id_fk" FOREIGN KEY ("activated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_access_blocks" ADD CONSTRAINT "document_access_blocks_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_access_blocks" ADD CONSTRAINT "document_access_blocks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_access_blocks" ADD CONSTRAINT "document_access_blocks_matter_id_matters_id_fk" FOREIGN KEY ("matter_id") REFERENCES "public"."matters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_access_blocks" ADD CONSTRAINT "document_access_blocks_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_access_blocks" ADD CONSTRAINT "document_access_blocks_ended_by_user_id_users_id_fk" FOREIGN KEY ("ended_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_access_log" ADD CONSTRAINT "document_access_log_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_access_log" ADD CONSTRAINT "document_access_log_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_access_log" ADD CONSTRAINT "document_access_log_group_id_document_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."document_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_access_log" ADD CONSTRAINT "document_access_log_matter_id_matters_id_fk" FOREIGN KEY ("matter_id") REFERENCES "public"."matters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_access_log" ADD CONSTRAINT "document_access_log_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_access_log" ADD CONSTRAINT "document_access_log_actor_party_id_parties_id_fk" FOREIGN KEY ("actor_party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_folder_templates" ADD CONSTRAINT "document_folder_templates_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_folder_templates" ADD CONSTRAINT "document_folder_templates_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_folder_templates" ADD CONSTRAINT "document_folder_templates_activated_by_user_id_users_id_fk" FOREIGN KEY ("activated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_folders" ADD CONSTRAINT "document_folders_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_folders" ADD CONSTRAINT "document_folders_matter_id_matters_id_fk" FOREIGN KEY ("matter_id") REFERENCES "public"."matters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_folders" ADD CONSTRAINT "document_folders_parent_id_document_folders_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."document_folders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_folders" ADD CONSTRAINT "document_folders_template_id_document_folder_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."document_folder_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_folders" ADD CONSTRAINT "document_folders_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_groups" ADD CONSTRAINT "document_groups_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_groups" ADD CONSTRAINT "document_groups_group_document_id_documents_id_fk" FOREIGN KEY ("group_document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_groups" ADD CONSTRAINT "document_groups_matter_id_matters_id_fk" FOREIGN KEY ("matter_id") REFERENCES "public"."matters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_groups" ADD CONSTRAINT "document_groups_folder_id_document_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."document_folders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_groups" ADD CONSTRAINT "document_groups_current_document_id_documents_id_fk" FOREIGN KEY ("current_document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_retention_rules" ADD CONSTRAINT "document_retention_rules_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_retention_rules" ADD CONSTRAINT "document_retention_rules_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_retention_rules" ADD CONSTRAINT "document_retention_rules_superseded_by_user_id_users_id_fk" FOREIGN KEY ("superseded_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_text" ADD CONSTRAINT "document_text_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_text" ADD CONSTRAINT "document_text_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_text" ADD CONSTRAINT "document_text_matter_id_matters_id_fk" FOREIGN KEY ("matter_id") REFERENCES "public"."matters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_text" ADD CONSTRAINT "document_text_group_id_document_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."document_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_version_files" ADD CONSTRAINT "document_version_files_tenant_id_firms_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_version_files" ADD CONSTRAINT "document_version_files_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "access_change_log_tenant_occurred_idx" ON "access_change_log" USING btree ("tenant_id","occurred_at");--> statement-breakpoint
CREATE INDEX "access_change_log_tenant_area_idx" ON "access_change_log" USING btree ("tenant_id","area","occurred_at");--> statement-breakpoint
CREATE INDEX "access_change_log_tenant_target_idx" ON "access_change_log" USING btree ("tenant_id","target_user_id");--> statement-breakpoint
CREATE INDEX "firm_role_assignments_tenant_user_idx" ON "firm_role_assignments" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "firm_role_assignments_active_key" ON "firm_role_assignments" USING btree ("tenant_id","user_id","role") WHERE "firm_role_assignments"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "matter_access_settings_matter_key" ON "matter_access_settings" USING btree ("tenant_id","matter_id");--> statement-breakpoint
CREATE INDEX "matter_team_members_tenant_matter_idx" ON "matter_team_members" USING btree ("tenant_id","matter_id");--> statement-breakpoint
CREATE INDEX "matter_team_members_tenant_user_idx" ON "matter_team_members" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "matter_team_members_active_key" ON "matter_team_members" USING btree ("tenant_id","matter_id","user_id") WHERE "matter_team_members"."removed_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "permission_overrides_role_right_key" ON "permission_overrides" USING btree ("tenant_id","role","right");--> statement-breakpoint
CREATE INDEX "practice_area_pack_adoptions_tenant_area_idx" ON "practice_area_pack_adoptions" USING btree ("tenant_id","practice_area","accepted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "practice_area_pack_adoptions_current_key" ON "practice_area_pack_adoptions" USING btree ("tenant_id","practice_area") WHERE "practice_area_pack_adoptions"."status" = 'accepted';--> statement-breakpoint
CREATE INDEX "trust_account_books_tenant_idx" ON "trust_account_books" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "trust_accounts_tenant_idx" ON "trust_accounts" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "trust_bank_statement_lines_key" ON "trust_bank_statement_lines" USING btree ("statement_id","line_no");--> statement-breakpoint
CREATE INDEX "trust_bank_statement_lines_tenant_idx" ON "trust_bank_statement_lines" USING btree ("tenant_id","statement_id");--> statement-breakpoint
CREATE INDEX "trust_bank_statements_tenant_period_idx" ON "trust_bank_statements" USING btree ("tenant_id","trust_account_id","period");--> statement-breakpoint
CREATE UNIQUE INDEX "trust_bank_statements_supersedes_key" ON "trust_bank_statements" USING btree ("supersedes_statement_id") WHERE "trust_bank_statements"."supersedes_statement_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "trust_hold_releases_hold_key" ON "trust_hold_releases" USING btree ("hold_id");--> statement-breakpoint
CREATE INDEX "trust_hold_releases_tenant_idx" ON "trust_hold_releases" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "trust_holds_tenant_subledger_idx" ON "trust_holds" USING btree ("tenant_id","subledger_id");--> statement-breakpoint
CREATE UNIQUE INDEX "trust_ledger_entries_line_key" ON "trust_ledger_entries" USING btree ("transaction_id","line_no");--> statement-breakpoint
CREATE UNIQUE INDEX "trust_ledger_entries_subledger_once_key" ON "trust_ledger_entries" USING btree ("transaction_id","subledger_id");--> statement-breakpoint
CREATE INDEX "trust_ledger_entries_tenant_subledger_idx" ON "trust_ledger_entries" USING btree ("tenant_id","subledger_id","created_at");--> statement-breakpoint
CREATE INDEX "trust_ledger_entries_tenant_account_idx" ON "trust_ledger_entries" USING btree ("tenant_id","trust_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "trust_period_closes_period_key" ON "trust_period_closes" USING btree ("tenant_id","trust_account_id","period");--> statement-breakpoint
CREATE UNIQUE INDEX "trust_period_closes_reconciliation_key" ON "trust_period_closes" USING btree ("reconciliation_id");--> statement-breakpoint
CREATE INDEX "trust_period_closes_tenant_end_idx" ON "trust_period_closes" USING btree ("tenant_id","trust_account_id","period_end");--> statement-breakpoint
CREATE UNIQUE INDEX "trust_reconciliation_signoffs_role_key" ON "trust_reconciliation_signoffs" USING btree ("reconciliation_id","signoff_role");--> statement-breakpoint
CREATE INDEX "trust_reconciliation_signoffs_tenant_idx" ON "trust_reconciliation_signoffs" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "trust_reconciliations_tenant_period_idx" ON "trust_reconciliations" USING btree ("tenant_id","trust_account_id","period","prepared_at");--> statement-breakpoint
CREATE UNIQUE INDEX "trust_reconciliations_supersedes_key" ON "trust_reconciliations" USING btree ("supersedes_reconciliation_id") WHERE "trust_reconciliations"."supersedes_reconciliation_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "trust_subledgers_client_matter_key" ON "trust_subledgers" USING btree ("tenant_id","trust_account_id","client_party_id","matter_id") WHERE "trust_subledgers"."kind" = 'client_matter';--> statement-breakpoint
CREATE UNIQUE INDEX "trust_subledgers_cushion_key" ON "trust_subledgers" USING btree ("tenant_id","trust_account_id") WHERE "trust_subledgers"."kind" = 'firm_cushion';--> statement-breakpoint
CREATE INDEX "trust_subledgers_tenant_matter_idx" ON "trust_subledgers" USING btree ("tenant_id","matter_id");--> statement-breakpoint
CREATE INDEX "trust_subledgers_tenant_client_idx" ON "trust_subledgers" USING btree ("tenant_id","client_party_id");--> statement-breakpoint
CREATE UNIQUE INDEX "trust_transactions_sequence_key" ON "trust_transactions" USING btree ("tenant_id","trust_account_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "trust_transactions_reverses_key" ON "trust_transactions" USING btree ("reverses_transaction_id") WHERE "trust_transactions"."reverses_transaction_id" is not null;--> statement-breakpoint
CREATE INDEX "trust_transactions_tenant_date_idx" ON "trust_transactions" USING btree ("tenant_id","trust_account_id","effective_date");--> statement-breakpoint
CREATE INDEX "trust_transactions_tenant_invoice_idx" ON "trust_transactions" USING btree ("tenant_id","invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "alert_digest_items_key" ON "alert_digest_items" USING btree ("tenant_id","user_id","flag_id");--> statement-breakpoint
CREATE INDEX "alert_digest_items_pending_idx" ON "alert_digest_items" USING btree ("tenant_id","sent_at");--> statement-breakpoint
CREATE UNIQUE INDEX "alert_job_runs_key" ON "alert_job_runs" USING btree ("tenant_id","job");--> statement-breakpoint
CREATE UNIQUE INDEX "client_chase_ladders_task_key" ON "client_chase_ladders" USING btree ("tenant_id","task_id");--> statement-breakpoint
CREATE INDEX "client_chase_ladders_due_idx" ON "client_chase_ladders" USING btree ("tenant_id","status","next_at");--> statement-breakpoint
CREATE INDEX "client_messages_tenant_matter_idx" ON "client_messages" USING btree ("tenant_id","matter_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "client_update_cadences_matter_key" ON "client_update_cadences" USING btree ("tenant_id","matter_id");--> statement-breakpoint
CREATE UNIQUE INDEX "client_update_reads_key" ON "client_update_reads" USING btree ("tenant_id","update_id","party_id");--> statement-breakpoint
CREATE INDEX "client_updates_tenant_matter_idx" ON "client_updates" USING btree ("tenant_id","matter_id","sent_at");--> statement-breakpoint
CREATE INDEX "client_updates_tenant_status_idx" ON "client_updates" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "court_case_refs_key" ON "court_case_refs" USING btree ("tenant_id","cause_number","matter_id");--> statement-breakpoint
CREATE INDEX "court_notice_attachments_notice_idx" ON "court_notice_attachments" USING btree ("tenant_id","notice_id");--> statement-breakpoint
CREATE INDEX "court_notice_suggestions_notice_idx" ON "court_notice_suggestions" USING btree ("tenant_id","notice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "court_notices_external_key" ON "court_notices" USING btree ("tenant_id","source","external_id");--> statement-breakpoint
CREATE INDEX "court_notices_tenant_status_idx" ON "court_notices" USING btree ("tenant_id","status","received_at");--> statement-breakpoint
CREATE INDEX "court_notices_tenant_matter_idx" ON "court_notices" USING btree ("tenant_id","matter_id");--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_followups_key" ON "delivery_followups" USING btree ("tenant_id","notification_id","kind");--> statement-breakpoint
CREATE INDEX "matter_health_snapshots_matter_idx" ON "matter_health_snapshots" USING btree ("tenant_id","matter_id","computed_at");--> statement-breakpoint
CREATE INDEX "matter_health_snapshots_tenant_computed_idx" ON "matter_health_snapshots" USING btree ("tenant_id","computed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "reply_clocks_one_open_per_thread" ON "reply_clocks" USING btree ("tenant_id","matter_id","thread_key") WHERE "reply_clocks"."status" = 'open';--> statement-breakpoint
CREATE INDEX "reply_clocks_tenant_status_idx" ON "reply_clocks" USING btree ("tenant_id","status","promise_at");--> statement-breakpoint
CREATE UNIQUE INDEX "stall_watches_one_live_per_item" ON "stall_watches" USING btree ("tenant_id","item_type","item_id") WHERE "stall_watches"."status" <> 'cleared';--> statement-breakpoint
CREATE INDEX "stall_watches_tenant_status_idx" ON "stall_watches" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_event_parties_key" ON "calendar_event_parties" USING btree ("tenant_id","event_id","party_id");--> statement-breakpoint
CREATE INDEX "calendar_event_parties_party_idx" ON "calendar_event_parties" USING btree ("tenant_id","party_id");--> statement-breakpoint
CREATE INDEX "calendar_sync_connections_user_idx" ON "calendar_sync_connections" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_sync_connections_active_key" ON "calendar_sync_connections" USING btree ("tenant_id","user_id","provider") WHERE "calendar_sync_connections"."active";--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_sync_links_key" ON "calendar_sync_links" USING btree ("tenant_id","event_id","connection_id");--> statement-breakpoint
CREATE INDEX "calendar_sync_links_status_idx" ON "calendar_sync_links" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_sync_links_external_key" ON "calendar_sync_links" USING btree ("tenant_id","connection_id","external_id") WHERE "calendar_sync_links"."external_id" is not null;--> statement-breakpoint
CREATE INDEX "deadline_calculations_matter_idx" ON "deadline_calculations" USING btree ("tenant_id","matter_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "deadline_rule_sets_version_key" ON "deadline_rule_sets" USING btree ("tenant_id","key","version");--> statement-breakpoint
CREATE UNIQUE INDEX "deadline_rule_sets_one_approved" ON "deadline_rule_sets" USING btree ("tenant_id","key") WHERE "deadline_rule_sets"."status" = 'approved';--> statement-breakpoint
CREATE INDEX "limitation_date_changes_limitation_idx" ON "limitation_date_changes" USING btree ("tenant_id","limitation_id");--> statement-breakpoint
CREATE INDEX "limitation_dates_matter_idx" ON "limitation_dates" USING btree ("tenant_id","matter_id");--> statement-breakpoint
CREATE INDEX "limitation_dates_status_date_idx" ON "limitation_dates" USING btree ("tenant_id","status","limitation_date");--> statement-breakpoint
CREATE UNIQUE INDEX "limitation_reminders_key" ON "limitation_reminders" USING btree ("tenant_id","limitation_id","version","threshold_days");--> statement-breakpoint
CREATE INDEX "limitation_verifications_limitation_idx" ON "limitation_verifications" USING btree ("tenant_id","limitation_id","version");--> statement-breakpoint
CREATE INDEX "matter_closings_matter_idx" ON "matter_closings" USING btree ("tenant_id","matter_id");--> statement-breakpoint
CREATE UNIQUE INDEX "matter_closings_one_open" ON "matter_closings" USING btree ("tenant_id","matter_id") WHERE "matter_closings"."status" = 'in_progress';--> statement-breakpoint
CREATE UNIQUE INDEX "matter_lifecycle_matter_key" ON "matter_lifecycle" USING btree ("tenant_id","matter_id");--> statement-breakpoint
CREATE INDEX "matter_lifecycle_stage_idx" ON "matter_lifecycle" USING btree ("tenant_id","practice_area","stage_key");--> statement-breakpoint
CREATE UNIQUE INDEX "matter_limitation_profiles_matter_key" ON "matter_limitation_profiles" USING btree ("tenant_id","matter_id");--> statement-breakpoint
CREATE UNIQUE INDEX "matter_stage_definitions_version_key" ON "matter_stage_definitions" USING btree ("tenant_id","practice_area","version");--> statement-breakpoint
CREATE UNIQUE INDEX "matter_stage_definitions_one_active" ON "matter_stage_definitions" USING btree ("tenant_id","practice_area") WHERE "matter_stage_definitions"."status" = 'active';--> statement-breakpoint
CREATE INDEX "matter_stage_transitions_matter_idx" ON "matter_stage_transitions" USING btree ("tenant_id","matter_id","at");--> statement-breakpoint
CREATE INDEX "matter_stage_transitions_billing_idx" ON "matter_stage_transitions" USING btree ("tenant_id","billing_event") WHERE "matter_stage_transitions"."billing_event" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "task_list_run_items_key" ON "task_list_run_items" USING btree ("tenant_id","run_id","item_key");--> statement-breakpoint
CREATE INDEX "task_list_run_items_status_idx" ON "task_list_run_items" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "task_list_runs_matter_idx" ON "task_list_runs" USING btree ("tenant_id","matter_id");--> statement-breakpoint
CREATE INDEX "task_list_runs_status_idx" ON "task_list_runs" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "task_list_runs_transition_key" ON "task_list_runs" USING btree ("tenant_id","stage_transition_id","template_id") WHERE "task_list_runs"."stage_transition_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "task_list_templates_version_key" ON "task_list_templates" USING btree ("tenant_id","key","version");--> statement-breakpoint
CREATE UNIQUE INDEX "task_list_templates_one_active" ON "task_list_templates" USING btree ("tenant_id","key") WHERE "task_list_templates"."status" = 'active';--> statement-breakpoint
CREATE INDEX "task_list_templates_area_idx" ON "task_list_templates" USING btree ("tenant_id","practice_area","status");--> statement-breakpoint
CREATE INDEX "document_access_blocks_tenant_user_idx" ON "document_access_blocks" USING btree ("tenant_id","user_id","ended_at");--> statement-breakpoint
CREATE INDEX "document_access_blocks_tenant_matter_idx" ON "document_access_blocks" USING btree ("tenant_id","matter_id");--> statement-breakpoint
CREATE UNIQUE INDEX "document_access_blocks_active_key" ON "document_access_blocks" USING btree ("tenant_id","user_id","matter_id") WHERE "document_access_blocks"."ended_at" is null;--> statement-breakpoint
CREATE INDEX "document_access_log_tenant_document_idx" ON "document_access_log" USING btree ("tenant_id","document_id","occurred_at");--> statement-breakpoint
CREATE INDEX "document_access_log_tenant_matter_idx" ON "document_access_log" USING btree ("tenant_id","matter_id","occurred_at");--> statement-breakpoint
CREATE INDEX "document_access_log_tenant_user_idx" ON "document_access_log" USING btree ("tenant_id","actor_user_id","occurred_at");--> statement-breakpoint
CREATE INDEX "document_folder_templates_tenant_area_idx" ON "document_folder_templates" USING btree ("tenant_id","practice_area","status");--> statement-breakpoint
CREATE UNIQUE INDEX "document_folder_templates_one_active_key" ON "document_folder_templates" USING btree ("tenant_id",coalesce("practice_area", '')) WHERE "document_folder_templates"."status" = 'active';--> statement-breakpoint
CREATE INDEX "document_folders_tenant_matter_idx" ON "document_folders" USING btree ("tenant_id","matter_id","parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "document_folders_sibling_name_key" ON "document_folders" USING btree ("tenant_id","matter_id",coalesce("parent_id", '00000000-0000-0000-0000-000000000000'::uuid),"normalized_name") WHERE "document_folders"."archived_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "document_folders_template_key_key" ON "document_folders" USING btree ("tenant_id","matter_id","template_key") WHERE "document_folders"."template_key" is not null and "document_folders"."archived_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "document_groups_group_document_key" ON "document_groups" USING btree ("tenant_id","group_document_id");--> statement-breakpoint
CREATE INDEX "document_groups_tenant_matter_idx" ON "document_groups" USING btree ("tenant_id","matter_id","folder_id");--> statement-breakpoint
CREATE INDEX "document_retention_rules_tenant_idx" ON "document_retention_rules" USING btree ("tenant_id","practice_area","document_type");--> statement-breakpoint
CREATE UNIQUE INDEX "document_retention_rules_live_key" ON "document_retention_rules" USING btree ("tenant_id",coalesce("practice_area", ''),coalesce("document_type", '')) WHERE "document_retention_rules"."superseded_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "document_text_document_key" ON "document_text" USING btree ("tenant_id","document_id");--> statement-breakpoint
CREATE INDEX "document_text_tenant_matter_idx" ON "document_text" USING btree ("tenant_id","matter_id");--> statement-breakpoint
CREATE INDEX "document_text_tenant_status_idx" ON "document_text" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "document_text_search_idx" ON "document_text" USING gin ("search_vector");--> statement-breakpoint
CREATE UNIQUE INDEX "document_version_files_document_key" ON "document_version_files" USING btree ("tenant_id","document_id");--> statement-breakpoint
CREATE INDEX "document_version_files_tenant_sha_idx" ON "document_version_files" USING btree ("tenant_id","sha256");--> statement-breakpoint
CREATE INDEX "document_version_files_tenant_scan_idx" ON "document_version_files" USING btree ("tenant_id","scan_status");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Hand-added (Drizzle's DSL does not express RLS, GRANTs or triggers).
-- Implements the MIGRATION NOTES at the bottom of src/db/tables/
-- calendar-core.ts, calendar-alerts.ts, document.ts, all-engines.ts and
-- billing-trust.ts, using the same tenant_isolation policy text as 0000/0003.
--
-- NOTE: the public schema has ALTER DEFAULT PRIVILEGES granting app_runtime
-- SELECT/INSERT/UPDATE/DELETE on every new table (found applying 0002), so
-- every restriction below is an explicit REVOKE, not just a narrower GRANT.
-- All 58 tables created above are tenant-scoped (NOT NULL tenant_id).
-- ---------------------------------------------------------------------------

ALTER TABLE "calendar_event_parties" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "calendar_sync_connections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "calendar_sync_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "matter_limitation_profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "limitation_dates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "limitation_date_changes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "limitation_verifications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "limitation_reminders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "deadline_rule_sets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "deadline_calculations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "task_list_templates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "task_list_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "task_list_run_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "matter_stage_definitions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "matter_lifecycle" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "matter_stage_transitions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "matter_closings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "client_messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "reply_clocks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "client_chase_ladders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "client_updates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "client_update_reads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "client_update_cadences" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "court_notices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "court_notice_attachments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "court_notice_suggestions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "court_case_refs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "stall_watches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "matter_health_snapshots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "alert_digest_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "delivery_followups" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "alert_job_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "document_folder_templates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "document_folders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "document_groups" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "document_version_files" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "document_text" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "document_access_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "document_access_blocks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "document_retention_rules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "permission_overrides" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "firm_role_assignments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "matter_access_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "matter_team_members" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "access_change_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "practice_area_pack_adoptions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "trust_accounts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "trust_account_books" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "trust_subledgers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "trust_transactions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "trust_ledger_entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "trust_holds" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "trust_hold_releases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "trust_bank_statements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "trust_bank_statement_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "trust_reconciliations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "trust_reconciliation_signoffs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "trust_period_closes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY tenant_isolation ON "calendar_event_parties" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "calendar_sync_connections" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "calendar_sync_links" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "matter_limitation_profiles" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "limitation_dates" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "limitation_date_changes" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "limitation_verifications" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "limitation_reminders" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "deadline_rule_sets" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "deadline_calculations" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "task_list_templates" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "task_list_runs" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "task_list_run_items" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "matter_stage_definitions" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "matter_lifecycle" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "matter_stage_transitions" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "matter_closings" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "client_messages" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "reply_clocks" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "client_chase_ladders" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "client_updates" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "client_update_reads" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "client_update_cadences" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "court_notices" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "court_notice_attachments" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "court_notice_suggestions" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "court_case_refs" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "stall_watches" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "matter_health_snapshots" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "alert_digest_items" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "delivery_followups" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "alert_job_runs" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "document_folder_templates" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "document_folders" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "document_groups" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "document_version_files" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "document_text" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "document_access_log" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "document_access_blocks" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "document_retention_rules" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "permission_overrides" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "firm_role_assignments" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "matter_access_settings" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "matter_team_members" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "access_change_log" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "practice_area_pack_adoptions" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "trust_accounts" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "trust_account_books" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "trust_subledgers" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "trust_transactions" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "trust_ledger_entries" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "trust_holds" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "trust_hold_releases" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "trust_bank_statements" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "trust_bank_statement_lines" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "trust_reconciliations" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "trust_reconciliation_signoffs" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "trust_period_closes" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON "calendar_event_parties", "calendar_sync_connections", "calendar_sync_links", "matter_limitation_profiles", "limitation_dates", "limitation_date_changes", "limitation_verifications", "limitation_reminders", "deadline_rule_sets", "deadline_calculations", "task_list_templates", "task_list_runs", "task_list_run_items", "matter_stage_definitions", "matter_lifecycle", "matter_stage_transitions", "matter_closings", "client_messages", "reply_clocks", "client_chase_ladders", "client_updates", "client_update_reads", "client_update_cadences", "court_notices", "court_notice_attachments", "court_notice_suggestions", "court_case_refs", "stall_watches", "matter_health_snapshots", "alert_digest_items", "delivery_followups", "alert_job_runs", "document_folder_templates", "document_folders", "document_groups", "document_version_files", "document_text", "document_access_log", "document_access_blocks", "document_retention_rules", "permission_overrides", "firm_role_assignments", "matter_access_settings", "matter_team_members", "access_change_log", "practice_area_pack_adoptions" TO app_runtime;--> statement-breakpoint

-- calendar-core: append-only audit records (c93 logged reason, c92 calculation trail, c95 stage history).
REVOKE UPDATE, DELETE ON "limitation_date_changes", "limitation_verifications", "deadline_calculations", "matter_stage_transitions" FROM app_runtime;--> statement-breakpoint
-- calendar-core: never deleted (status changes only).
REVOKE DELETE ON "limitation_dates", "matter_limitation_profiles", "limitation_reminders", "deadline_rule_sets", "task_list_templates", "matter_stage_definitions", "matter_closings", "task_list_runs", "task_list_run_items", "matter_lifecycle" FROM app_runtime;--> statement-breakpoint
-- calendar_event_parties, calendar_sync_connections, calendar_sync_links keep full CRUD.

-- calendar-alerts: client_messages is the correspondence record (c6): append-only.
REVOKE UPDATE, DELETE ON "client_messages" FROM app_runtime;--> statement-breakpoint
-- calendar-alerts: append-only logs.
REVOKE UPDATE, DELETE ON "matter_health_snapshots", "client_update_reads", "delivery_followups" FROM app_runtime;--> statement-breakpoint
-- calendar-alerts: never lose rows (c54 rule 5, c64, c47 rule 8).
REVOKE DELETE ON "client_updates", "reply_clocks", "client_chase_ladders", "court_notices", "court_notice_attachments", "court_notice_suggestions", "stall_watches", "alert_digest_items" FROM app_runtime;--> statement-breakpoint

-- document: every view/download/search/denial must survive.
REVOKE UPDATE, DELETE ON "document_access_log" FROM app_runtime;--> statement-breakpoint
-- document: version history never loses rows (c84). Destruction (c90) runs under a separate purge role.
REVOKE DELETE ON "document_groups", "document_version_files", "document_text", "document_folders", "document_folder_templates", "document_retention_rules", "document_access_blocks" FROM app_runtime;--> statement-breakpoint
-- document_retention_rules is supersede-only.
REVOKE UPDATE ON "document_retention_rules" FROM app_runtime;--> statement-breakpoint
GRANT UPDATE ("superseded_at", "superseded_by_user_id") ON "document_retention_rules" TO app_runtime;--> statement-breakpoint
-- document_version_files: the bytes' identity never changes; only scan/verification facts do.
REVOKE UPDATE ON "document_version_files" FROM app_runtime;--> statement-breakpoint
GRANT UPDATE ("scan_status", "scan_detail", "scanned_at", "quarantined_at", "last_verified_at") ON "document_version_files" TO app_runtime;--> statement-breakpoint

-- all-engines: access_change_log is append-only (c6 / c99).
REVOKE UPDATE, DELETE ON "access_change_log" FROM app_runtime;--> statement-breakpoint
-- all-engines: history tables keep every row (revoke/remove/supersede instead). permission_overrides keeps DELETE.
REVOKE DELETE ON "firm_role_assignments", "matter_team_members", "practice_area_pack_adoptions", "matter_access_settings" FROM app_runtime;--> statement-breakpoint

-- billing-trust: the journal, holds, statements, reconciliations, sign-offs and closes are append-only.
REVOKE UPDATE, DELETE, TRUNCATE ON "trust_transactions", "trust_ledger_entries", "trust_holds", "trust_hold_releases", "trust_bank_statements", "trust_bank_statement_lines", "trust_reconciliations", "trust_reconciliation_signoffs", "trust_period_closes" FROM app_runtime;--> statement-breakpoint
GRANT SELECT, INSERT ON "trust_transactions", "trust_ledger_entries", "trust_holds", "trust_hold_releases", "trust_bank_statements", "trust_bank_statement_lines", "trust_reconciliations", "trust_reconciliation_signoffs", "trust_period_closes" TO app_runtime;--> statement-breakpoint
-- billing-trust: balances are trigger-maintained only. The table-level INSERT from the default
-- privileges is revoked too, so only the listed columns can be supplied on INSERT.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "trust_account_books", "trust_subledgers" FROM app_runtime;--> statement-breakpoint
GRANT SELECT ON "trust_account_books", "trust_subledgers" TO app_runtime;--> statement-breakpoint
GRANT INSERT ("trust_account_id", "tenant_id") ON "trust_account_books" TO app_runtime;--> statement-breakpoint
GRANT INSERT ("id", "tenant_id", "trust_account_id", "kind", "client_party_id", "matter_id", "created_by_user_id") ON "trust_subledgers" TO app_runtime;--> statement-breakpoint
-- billing-trust: accounts are never deleted; only name / cushion cap / updated_at change.
REVOKE UPDATE, DELETE, TRUNCATE ON "trust_accounts" FROM app_runtime;--> statement-breakpoint
GRANT SELECT, INSERT ON "trust_accounts" TO app_runtime;--> statement-breakpoint
GRANT UPDATE ("name", "bank_fee_cushion_cap_cents", "updated_at") ON "trust_accounts" TO app_runtime;--> statement-breakpoint

-- Same hardening as 0001-0004: the app never uses Supabase's REST roles.
REVOKE ALL ON "calendar_event_parties", "calendar_sync_connections", "calendar_sync_links", "matter_limitation_profiles", "limitation_dates", "limitation_date_changes", "limitation_verifications", "limitation_reminders", "deadline_rule_sets", "deadline_calculations", "task_list_templates", "task_list_runs", "task_list_run_items", "matter_stage_definitions", "matter_lifecycle", "matter_stage_transitions", "matter_closings", "client_messages", "reply_clocks", "client_chase_ladders", "client_updates", "client_update_reads", "client_update_cadences", "court_notices", "court_notice_attachments", "court_notice_suggestions", "court_case_refs", "stall_watches", "matter_health_snapshots", "alert_digest_items", "delivery_followups", "alert_job_runs", "document_folder_templates", "document_folders", "document_groups", "document_version_files", "document_text", "document_access_log", "document_access_blocks", "document_retention_rules", "permission_overrides", "firm_role_assignments", "matter_access_settings", "matter_team_members", "access_change_log", "practice_area_pack_adoptions", "trust_accounts", "trust_account_books", "trust_subledgers", "trust_transactions", "trust_ledger_entries", "trust_holds", "trust_hold_releases", "trust_bank_statements", "trust_bank_statement_lines", "trust_reconciliations", "trust_reconciliation_signoffs", "trust_period_closes" FROM anon, authenticated;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- calendar-core note 3 (recommended hardening): an approved deadline rule
-- set's config can never change; the engine already refuses, this makes it
-- structural.
-- ---------------------------------------------------------------------------

CREATE FUNCTION deadline_rule_sets_config_frozen() RETURNS trigger LANGUAGE plpgsql
  SET search_path = public, pg_temp AS $$
BEGIN
  IF OLD.status = 'approved' AND NEW.config IS DISTINCT FROM OLD.config THEN
    RAISE EXCEPTION 'deadline_rule_sets: an approved rule set''s config cannot change; create a new version'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER deadline_rule_sets_config_frozen BEFORE UPDATE ON "deadline_rule_sets"
  FOR EACH ROW EXECUTE FUNCTION deadline_rule_sets_config_frozen();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- calendar-alerts note 3: sent client updates are immutable (c54 rule 5).
-- ---------------------------------------------------------------------------

CREATE FUNCTION client_updates_immutable() RETURNS trigger LANGUAGE plpgsql
  SET search_path = public, pg_temp AS $$
BEGIN
  IF OLD.status = 'sent' THEN
    RAISE EXCEPTION 'client_updates: a sent update cannot be changed; send a correction';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER client_updates_immutable BEFORE UPDATE ON "client_updates"
  FOR EACH ROW EXECUTE FUNCTION client_updates_immutable();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- billing-trust note 3: ledger functions and triggers. Nothing posts without
-- these (the posting service verifies the balances moved). SECURITY DEFINER
-- functions are owned by the migrations role, pin search_path and re-check
-- the tenant explicitly because they bypass RLS.
-- ---------------------------------------------------------------------------

-- 3a. append-only guard (every role, incl. the owner by mistake)
CREATE FUNCTION billing_trust_append_only() RETURNS trigger LANGUAGE plpgsql
  SET search_path = public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'billing-trust: % is append-only (corrections are reversing entries)', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END $$;--> statement-breakpoint
CREATE TRIGGER trust_transactions_append_only BEFORE UPDATE OR DELETE ON "trust_transactions"
  FOR EACH ROW EXECUTE FUNCTION billing_trust_append_only();--> statement-breakpoint
CREATE TRIGGER trust_transactions_no_truncate BEFORE TRUNCATE ON "trust_transactions"
  FOR EACH STATEMENT EXECUTE FUNCTION billing_trust_append_only();--> statement-breakpoint
CREATE TRIGGER trust_ledger_entries_append_only BEFORE UPDATE OR DELETE ON "trust_ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION billing_trust_append_only();--> statement-breakpoint
CREATE TRIGGER trust_ledger_entries_no_truncate BEFORE TRUNCATE ON "trust_ledger_entries"
  FOR EACH STATEMENT EXECUTE FUNCTION billing_trust_append_only();--> statement-breakpoint
CREATE TRIGGER trust_holds_append_only BEFORE UPDATE OR DELETE ON "trust_holds"
  FOR EACH ROW EXECUTE FUNCTION billing_trust_append_only();--> statement-breakpoint
CREATE TRIGGER trust_holds_no_truncate BEFORE TRUNCATE ON "trust_holds"
  FOR EACH STATEMENT EXECUTE FUNCTION billing_trust_append_only();--> statement-breakpoint
CREATE TRIGGER trust_hold_releases_append_only BEFORE UPDATE OR DELETE ON "trust_hold_releases"
  FOR EACH ROW EXECUTE FUNCTION billing_trust_append_only();--> statement-breakpoint
CREATE TRIGGER trust_hold_releases_no_truncate BEFORE TRUNCATE ON "trust_hold_releases"
  FOR EACH STATEMENT EXECUTE FUNCTION billing_trust_append_only();--> statement-breakpoint
CREATE TRIGGER trust_bank_statements_append_only BEFORE UPDATE OR DELETE ON "trust_bank_statements"
  FOR EACH ROW EXECUTE FUNCTION billing_trust_append_only();--> statement-breakpoint
CREATE TRIGGER trust_bank_statements_no_truncate BEFORE TRUNCATE ON "trust_bank_statements"
  FOR EACH STATEMENT EXECUTE FUNCTION billing_trust_append_only();--> statement-breakpoint
CREATE TRIGGER trust_bank_statement_lines_append_only BEFORE UPDATE OR DELETE ON "trust_bank_statement_lines"
  FOR EACH ROW EXECUTE FUNCTION billing_trust_append_only();--> statement-breakpoint
CREATE TRIGGER trust_bank_statement_lines_no_truncate BEFORE TRUNCATE ON "trust_bank_statement_lines"
  FOR EACH STATEMENT EXECUTE FUNCTION billing_trust_append_only();--> statement-breakpoint
CREATE TRIGGER trust_reconciliations_append_only BEFORE UPDATE OR DELETE ON "trust_reconciliations"
  FOR EACH ROW EXECUTE FUNCTION billing_trust_append_only();--> statement-breakpoint
CREATE TRIGGER trust_reconciliations_no_truncate BEFORE TRUNCATE ON "trust_reconciliations"
  FOR EACH STATEMENT EXECUTE FUNCTION billing_trust_append_only();--> statement-breakpoint
CREATE TRIGGER trust_reconciliation_signoffs_append_only BEFORE UPDATE OR DELETE ON "trust_reconciliation_signoffs"
  FOR EACH ROW EXECUTE FUNCTION billing_trust_append_only();--> statement-breakpoint
CREATE TRIGGER trust_reconciliation_signoffs_no_truncate BEFORE TRUNCATE ON "trust_reconciliation_signoffs"
  FOR EACH STATEMENT EXECUTE FUNCTION billing_trust_append_only();--> statement-breakpoint
CREATE TRIGGER trust_period_closes_append_only BEFORE UPDATE OR DELETE ON "trust_period_closes"
  FOR EACH ROW EXECUTE FUNCTION billing_trust_append_only();--> statement-breakpoint
CREATE TRIGGER trust_period_closes_no_truncate BEFORE TRUNCATE ON "trust_period_closes"
  FOR EACH STATEMENT EXECUTE FUNCTION billing_trust_append_only();--> statement-breakpoint

-- 3b. balances only change from inside a journal trigger; new rows start at zero
CREATE FUNCTION billing_trust_balance_guard() RETURNS trigger LANGUAGE plpgsql
  SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF TG_TABLE_NAME = 'trust_subledgers' THEN
      NEW.balance_cents := 0; NEW.held_cents := 0;
    ELSE
      NEW.balance_cents := 0; NEW.last_sequence := 0; NEW.last_hash := NULL;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'billing-trust: % rows are never deleted', TG_TABLE_NAME;
  END IF;
  IF pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'billing-trust: % is maintained only by the ledger triggers', TG_TABLE_NAME;
  END IF;
  IF NEW.tenant_id <> OLD.tenant_id THEN
    RAISE EXCEPTION 'billing-trust: tenant cannot change';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER trust_subledgers_guard BEFORE INSERT OR UPDATE OR DELETE ON "trust_subledgers"
  FOR EACH ROW EXECUTE FUNCTION billing_trust_balance_guard();--> statement-breakpoint
CREATE TRIGGER trust_account_books_guard BEFORE INSERT OR UPDATE OR DELETE ON "trust_account_books"
  FOR EACH ROW EXECUTE FUNCTION billing_trust_balance_guard();--> statement-breakpoint

-- 3b (cont.). A client-matter sub-ledger's client must be the matter's client:
-- its primary party, or a current matter_parties row with role 'client'
-- (same tenant). Runs as the caller, so RLS applies as well.
CREATE FUNCTION billing_trust_subledger_client_check() RETURNS trigger LANGUAGE plpgsql
  SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.kind = 'client_matter' AND NOT EXISTS (
       SELECT 1 FROM matters m
        WHERE m.id = NEW.matter_id AND m.tenant_id = NEW.tenant_id
          AND (m.primary_party_id = NEW.client_party_id
               OR EXISTS (SELECT 1 FROM matter_parties mp
                           WHERE mp.tenant_id = NEW.tenant_id AND mp.matter_id = NEW.matter_id
                             AND mp.party_id = NEW.client_party_id AND mp.role = 'client'
                             AND mp.ended_at IS NULL))) THEN
    RAISE EXCEPTION 'billing-trust: the sub-ledger''s client is not the client on that matter'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER trust_subledgers_client_check BEFORE INSERT ON "trust_subledgers"
  FOR EACH ROW EXECUTE FUNCTION billing_trust_subledger_client_check();--> statement-breakpoint

-- 3c. journal header: tenant, sequence, hash link, account active, closed periods
CREATE FUNCTION billing_trust_tx_before_insert() RETURNS trigger LANGUAGE plpgsql
  SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE b trust_account_books%ROWTYPE; a trust_accounts%ROWTYPE; orig trust_transactions%ROWTYPE;
BEGIN
  IF NEW.tenant_id::text IS DISTINCT FROM current_setting('app.tenant_id', true) THEN
    RAISE EXCEPTION 'billing-trust: tenant mismatch';
  END IF;
  SELECT * INTO a FROM trust_accounts WHERE id = NEW.trust_account_id AND tenant_id = NEW.tenant_id;
  IF NOT FOUND OR a.status <> 'active' THEN
    RAISE EXCEPTION 'billing-trust: account not active';
  END IF;
  SELECT * INTO b FROM trust_account_books
   WHERE trust_account_id = NEW.trust_account_id AND tenant_id = NEW.tenant_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'billing-trust: account has no book row';
  END IF;
  IF NEW.sequence <> b.last_sequence + 1 OR NEW.prev_hash IS DISTINCT FROM b.last_hash THEN
    RAISE EXCEPTION 'billing-trust: stale sequence/hash (concurrent posting)' USING ERRCODE = 'serialization_failure';
  END IF;
  IF NEW.effective_date > (now() AT TIME ZONE 'UTC')::date + 1 THEN
    RAISE EXCEPTION 'billing-trust: entry dated in the future';
  END IF;
  IF EXISTS (SELECT 1 FROM trust_period_closes c
              WHERE c.trust_account_id = NEW.trust_account_id AND c.period_end >= NEW.effective_date) THEN
    RAISE EXCEPTION 'billing-trust: period is closed';
  END IF;
  IF NEW.posted_at > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'billing-trust: posted_at in the future';
  END IF;
  IF NEW.reverses_transaction_id IS NOT NULL THEN
    SELECT * INTO orig FROM trust_transactions WHERE id = NEW.reverses_transaction_id;
    IF NOT FOUND OR orig.trust_account_id <> NEW.trust_account_id OR orig.tenant_id <> NEW.tenant_id
       OR orig.kind = 'reversal' OR NEW.net_amount_cents <> -orig.net_amount_cents THEN
      RAISE EXCEPTION 'billing-trust: invalid reversal';
    END IF;
  END IF;
  UPDATE trust_account_books SET last_sequence = NEW.sequence, last_hash = NEW.hash, updated_at = now()
   WHERE trust_account_id = NEW.trust_account_id;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER trust_transactions_before_insert BEFORE INSERT ON "trust_transactions"
  FOR EACH ROW EXECUTE FUNCTION billing_trust_tx_before_insert();--> statement-breakpoint

-- 3d. each line: lock the sub-ledger, re-check the rules, move both balances
CREATE FUNCTION billing_trust_entry_before_insert() RETURNS trigger LANGUAGE plpgsql
  SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE t trust_transactions%ROWTYPE; s trust_subledgers%ROWTYPE; b trust_account_books%ROWTYPE;
        new_bal bigint; new_book bigint;
BEGIN
  SELECT * INTO t FROM trust_transactions WHERE id = NEW.transaction_id;
  IF NOT FOUND OR t.tenant_id <> NEW.tenant_id OR t.trust_account_id <> NEW.trust_account_id THEN
    RAISE EXCEPTION 'billing-trust: line does not match its transaction';
  END IF;
  -- lock order is always book -> sub-ledger (the header trigger already holds the book lock)
  SELECT * INTO b FROM trust_account_books WHERE trust_account_id = NEW.trust_account_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'billing-trust: account has no book row';
  END IF;
  SELECT * INTO s FROM trust_subledgers WHERE id = NEW.subledger_id FOR UPDATE;
  IF NOT FOUND OR s.tenant_id <> NEW.tenant_id OR s.trust_account_id <> NEW.trust_account_id THEN
    RAISE EXCEPTION 'billing-trust: sub-ledger not in this account';
  END IF;
  -- the firm cushion only takes cushion kinds; client ledgers never do
  IF (s.kind = 'firm_cushion') <> (t.kind IN ('cushion_deposit','cushion_withdrawal','bank_fee')
       OR (t.kind = 'reversal' AND s.kind = 'firm_cushion')) THEN
    RAISE EXCEPTION 'billing-trust: % cannot post to a % ledger', t.kind, s.kind USING ERRCODE = 'check_violation';
  END IF;
  new_bal := s.balance_cents + NEW.amount_cents;
  IF new_bal < 0 THEN
    RAISE EXCEPTION 'billing-trust: ledger would go below zero' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.amount_cents < 0 AND new_bal < s.held_cents THEN
    RAISE EXCEPTION 'billing-trust: funds are held for a dispute' USING ERRCODE = 'check_violation';
  END IF;
  new_book := b.balance_cents + NEW.amount_cents;
  IF NEW.balance_after_cents <> new_bal OR NEW.book_balance_after_cents <> new_book THEN
    RAISE EXCEPTION 'billing-trust: stated running balances are wrong';
  END IF;
  UPDATE trust_subledgers SET balance_cents = new_bal, updated_at = now() WHERE id = s.id;
  UPDATE trust_account_books SET balance_cents = new_book, updated_at = now() WHERE trust_account_id = b.trust_account_id;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER trust_ledger_entries_before_insert BEFORE INSERT ON "trust_ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION billing_trust_entry_before_insert();--> statement-breakpoint

-- 3e. aggregate invariants at COMMIT (CHECKs cannot see aggregates)
CREATE FUNCTION billing_trust_tx_check() RETURNS trigger LANGUAGE plpgsql
  SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n int; total bigint; clients int; book bigint; ledgers bigint; orig_lines int; mismatched int;
BEGIN
  SELECT count(*), coalesce(sum(e.amount_cents), 0), count(DISTINCT s.client_party_id)
    INTO n, total, clients
    FROM trust_ledger_entries e JOIN trust_subledgers s ON s.id = e.subledger_id
   WHERE e.transaction_id = NEW.id;
  IF n = 0 OR total <> NEW.net_amount_cents THEN
    RAISE EXCEPTION 'billing-trust: transaction % lines do not match its amount', NEW.id;
  END IF;
  IF NEW.kind = 'transfer' THEN
    -- exactly two lines, both client ledgers of ONE client (one client's money never covers another's)
    IF n <> 2 OR clients <> 1 OR EXISTS (
         SELECT 1 FROM trust_ledger_entries e JOIN trust_subledgers s ON s.id = e.subledger_id
          WHERE e.transaction_id = NEW.id AND s.kind <> 'client_matter') THEN
      RAISE EXCEPTION 'billing-trust: transfers are between two matters of the same client';
    END IF;
  ELSIF NEW.kind = 'reversal' THEN
    -- exact negation of the original, line for line
    SELECT count(*) INTO orig_lines FROM trust_ledger_entries WHERE transaction_id = NEW.reverses_transaction_id;
    SELECT count(*) INTO mismatched FROM trust_ledger_entries o
      LEFT JOIN trust_ledger_entries r ON r.transaction_id = NEW.id AND r.subledger_id = o.subledger_id
     WHERE o.transaction_id = NEW.reverses_transaction_id AND (r.id IS NULL OR r.amount_cents <> -o.amount_cents);
    IF orig_lines <> n OR mismatched > 0 THEN
      RAISE EXCEPTION 'billing-trust: reversal is not exact';
    END IF;
  ELSIF n <> 1 THEN
    RAISE EXCEPTION 'billing-trust: % has exactly one line', NEW.kind;
  END IF;
  -- I3: book balance = sum of sub-ledgers for the account
  SELECT balance_cents INTO book FROM trust_account_books WHERE trust_account_id = NEW.trust_account_id;
  SELECT coalesce(sum(balance_cents), 0) INTO ledgers FROM trust_subledgers WHERE trust_account_id = NEW.trust_account_id;
  IF book <> ledgers THEN
    RAISE EXCEPTION 'billing-trust: book % <> sum of ledgers %', book, ledgers;
  END IF;
  -- I5: the cushion never exceeds the firm's cap
  IF NEW.kind = 'cushion_deposit' AND EXISTS (
       SELECT 1 FROM trust_subledgers s JOIN trust_accounts a ON a.id = s.trust_account_id
        WHERE s.trust_account_id = NEW.trust_account_id AND s.kind = 'firm_cushion'
          AND s.balance_cents > a.bank_fee_cushion_cap_cents) THEN
    RAISE EXCEPTION 'billing-trust: cushion above cap';
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER trust_transactions_check AFTER INSERT ON "trust_transactions"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION billing_trust_tx_check();--> statement-breakpoint

-- 3f. holds move held_cents (CHECK held <= balance does the rest)
CREATE FUNCTION billing_trust_hold_after_insert() RETURNS trigger LANGUAGE plpgsql
  SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE h trust_holds%ROWTYPE;
BEGIN
  IF NEW.tenant_id::text IS DISTINCT FROM current_setting('app.tenant_id', true) THEN
    RAISE EXCEPTION 'billing-trust: tenant mismatch';
  END IF;
  IF TG_TABLE_NAME = 'trust_holds' THEN
    PERFORM 1 FROM trust_account_books WHERE trust_account_id = NEW.trust_account_id FOR UPDATE;
    UPDATE trust_subledgers SET held_cents = held_cents + NEW.amount_cents, updated_at = now()
     WHERE id = NEW.subledger_id AND tenant_id = NEW.tenant_id AND trust_account_id = NEW.trust_account_id
       AND kind = 'client_matter';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'billing-trust: hold on an unknown or non-client ledger';
    END IF;
  ELSE
    SELECT * INTO h FROM trust_holds WHERE id = NEW.hold_id AND tenant_id = NEW.tenant_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'billing-trust: unknown hold';
    END IF;
    PERFORM 1 FROM trust_account_books WHERE trust_account_id = h.trust_account_id FOR UPDATE;
    UPDATE trust_subledgers SET held_cents = held_cents - h.amount_cents, updated_at = now() WHERE id = h.subledger_id;
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE TRIGGER trust_holds_after_insert AFTER INSERT ON "trust_holds"
  FOR EACH ROW EXECUTE FUNCTION billing_trust_hold_after_insert();--> statement-breakpoint
CREATE TRIGGER trust_hold_releases_after_insert AFTER INSERT ON "trust_hold_releases"
  FOR EACH ROW EXECUTE FUNCTION billing_trust_hold_after_insert();--> statement-breakpoint

-- 3g. statements foot (opening + sum of lines = closing; every line inside the period), checked at commit
CREATE FUNCTION billing_trust_statement_foot() RETURNS trigger LANGUAGE plpgsql
  SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE total bigint; outside int;
BEGIN
  SELECT coalesce(sum(l.amount_cents), 0),
         count(*) FILTER (WHERE l.posted_on < NEW.period_start OR l.posted_on > NEW.period_end
                                OR l.tenant_id <> NEW.tenant_id)
    INTO total, outside
    FROM trust_bank_statement_lines l
   WHERE l.statement_id = NEW.id;
  IF NEW.opening_balance_cents + total <> NEW.closing_balance_cents THEN
    RAISE EXCEPTION 'billing-trust: statement % does not foot (opening % + lines % <> closing %)',
      NEW.id, NEW.opening_balance_cents, total, NEW.closing_balance_cents USING ERRCODE = 'check_violation';
  END IF;
  IF outside > 0 THEN
    RAISE EXCEPTION 'billing-trust: statement % has lines outside its period', NEW.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER trust_bank_statements_foot AFTER INSERT ON "trust_bank_statements"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION billing_trust_statement_foot();--> statement-breakpoint

-- 3h. a sign-off records exactly the balanced report it signed
CREATE FUNCTION billing_trust_signoff_check() RETURNS trigger LANGUAGE plpgsql
  SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r trust_reconciliations%ROWTYPE;
BEGIN
  IF NEW.tenant_id::text IS DISTINCT FROM current_setting('app.tenant_id', true) THEN
    RAISE EXCEPTION 'billing-trust: tenant mismatch';
  END IF;
  SELECT * INTO r FROM trust_reconciliations WHERE id = NEW.reconciliation_id AND tenant_id = NEW.tenant_id;
  IF NOT FOUND OR r.status <> 'balanced' OR NEW.report_hash <> r.report_hash THEN
    RAISE EXCEPTION 'billing-trust: sign-offs are only for the exact report of a balanced reconciliation'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER trust_reconciliation_signoffs_before_insert BEFORE INSERT ON "trust_reconciliation_signoffs"
  FOR EACH ROW EXECUTE FUNCTION billing_trust_signoff_check();--> statement-breakpoint

-- 3h. a month closes only on a balanced, current, signed-off reconciliation, in order
CREATE FUNCTION billing_trust_period_close_check() RETURNS trigger LANGUAGE plpgsql
  SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r trust_reconciliations%ROWTYPE; last_period text;
BEGIN
  IF NEW.tenant_id::text IS DISTINCT FROM current_setting('app.tenant_id', true) THEN
    RAISE EXCEPTION 'billing-trust: tenant mismatch';
  END IF;
  SELECT * INTO r FROM trust_reconciliations WHERE id = NEW.reconciliation_id;
  IF NOT FOUND OR r.tenant_id <> NEW.tenant_id OR r.trust_account_id <> NEW.trust_account_id
     OR r.period <> NEW.period OR r.period_end <> NEW.period_end THEN
    RAISE EXCEPTION 'billing-trust: the reconciliation is not for this account and period'
      USING ERRCODE = 'check_violation';
  END IF;
  IF r.status <> 'balanced' THEN
    RAISE EXCEPTION 'billing-trust: only a balanced reconciliation closes a month' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM trust_reconciliations s WHERE s.supersedes_reconciliation_id = r.id) THEN
    RAISE EXCEPTION 'billing-trust: the reconciliation has been superseded' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM trust_reconciliation_signoffs g
                  WHERE g.reconciliation_id = r.id AND g.tenant_id = r.tenant_id AND g.report_hash = r.report_hash) THEN
    RAISE EXCEPTION 'billing-trust: the reconciliation has no matching sign-off' USING ERRCODE = 'check_violation';
  END IF;
  -- in order: nothing at or after this month is closed, and no month is skipped
  PERFORM 1 FROM trust_account_books WHERE trust_account_id = NEW.trust_account_id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM trust_period_closes c
              WHERE c.trust_account_id = NEW.trust_account_id AND c.period_end >= NEW.period_end) THEN
    RAISE EXCEPTION 'billing-trust: a later or equal month is already closed' USING ERRCODE = 'check_violation';
  END IF;
  SELECT c.period INTO last_period FROM trust_period_closes c
   WHERE c.trust_account_id = NEW.trust_account_id ORDER BY c.period_end DESC LIMIT 1;
  IF last_period IS NOT NULL
     AND to_char(to_date(last_period || '-01', 'YYYY-MM-DD') + interval '1 month', 'YYYY-MM') <> NEW.period THEN
    RAISE EXCEPTION 'billing-trust: months are closed in order (last closed %)', last_period
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER trust_period_closes_before_insert BEFORE INSERT ON "trust_period_closes"
  FOR EACH ROW EXECUTE FUNCTION billing_trust_period_close_check();
