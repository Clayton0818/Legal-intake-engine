-- ---------------------------------------------------------------------------
-- Hardening: remove Supabase's default anon/authenticated grants from the
-- eleven tables created by 0000.
--
-- 0001 did this for "firms"; 0002 and 0003 did it for every table they
-- created. The original 0000 tables were never covered, so they still carry
-- Supabase's default SELECT/INSERT/UPDATE/DELETE grants to the REST roles.
--
-- Nothing leaks today: all eleven have RLS enabled and only the
-- tenant_isolation policy, which matches no rows when app.tenant_id is
-- unset (as it always is for anon/authenticated). But that makes RLS the
-- only barrier, one policy mistake away from exposure over the public anon
-- key. The app never uses Supabase's REST/anon path (ADR-0001 §D5: it
-- connects as app_runtime over the transaction pooler), so revoking these
-- grants has no effect on the running application.
--
-- app_runtime's grants on these tables are deliberately untouched (incl.
-- intake_events staying INSERT/SELECT-only per c6 §3).
-- ---------------------------------------------------------------------------

REVOKE ALL ON
  "users", "parties", "matters", "matter_parties", "intake_sessions",
  "intake_events", "conflict_check_results", "documents",
  "firm_config_versions", "outbox", "scheduled_tasks"
  FROM anon, authenticated;
