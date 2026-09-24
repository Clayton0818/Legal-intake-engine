-- ---------------------------------------------------------------------------
-- Fix: RLS was never enabled on "firms" (Supabase security advisor,
-- rls_disabled_in_public, ERROR level).
--
-- 0000's own RLS section says "`firms` is excluded deliberately — it is the
-- tenant root, not itself tenant-scoped." That reasoning is correct about
-- tenant filtering (there's no tenant_id column on firms to filter on) but
-- wrong about RLS: Supabase auto-exposes every table in the public schema
-- over PostgREST regardless of whether the app's own code ever queries it
-- that way, and "firms" still carried its default anon/authenticated
-- grants (SELECT, INSERT, UPDATE, DELETE) with nothing enforcing them.
-- With RLS off, those grants were live: anyone holding the project's public
-- anon key could read, create, modify, or delete rows in the tenant
-- registry table directly over the REST API, bypassing withTenant() and the
-- app entirely.
--
-- Fix shape: enable RLS, add one policy scoped to app_runtime (the only
-- role the application ever connects as) rather than a tenant_id-based
-- policy — there is no tenant_id column here for a policy to filter on,
-- and the isolation boundary for this one table is "must be app_runtime",
-- not "must be this tenant". Then revoke the dangling anon/authenticated
-- grants outright, since the app never uses Supabase's REST/anon path
-- (ADR-0001 §D5 — it connects directly as app_runtime over the transaction
-- pooler), so this has no effect on the running application.
-- ---------------------------------------------------------------------------

ALTER TABLE "firms" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY app_runtime_full_access ON "firms" TO app_runtime USING (true) WITH CHECK (true);--> statement-breakpoint

REVOKE ALL ON "firms" FROM anon, authenticated;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Same advisor pass also flagged this trigger function
-- (function_search_path_mutable, WARN): an unset search_path lets a
-- session-level search_path change which objects an unqualified reference
-- resolves to. Lower severity than the RLS gap above, but free to close.
-- ---------------------------------------------------------------------------

ALTER FUNCTION matters_set_eligible_for_deletion() SET search_path = public, pg_temp;
