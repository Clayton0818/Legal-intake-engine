-- ---------------------------------------------------------------------------
-- Hardening: stop exposing 0005's SECURITY DEFINER trigger functions over
-- Supabase's REST RPC endpoint.
--
-- Postgres grants EXECUTE on new functions to PUBLIC, so the Supabase
-- security advisor flags these seven as callable by anon/authenticated via
-- /rest/v1/rpc/<name>. They RETURN trigger, so a direct call fails ("trigger
-- functions can only be called as triggers") and nothing is exploitable
-- today, but they should not be reachable at all.
--
-- Postgres only checks EXECUTE on a trigger function when the trigger is
-- created, not when it fires, so the ledger, hold, statement, sign-off and
-- period-close triggers keep working for app_runtime (verified locally:
-- trust.db.test.ts and the isolation test pass with EXECUTE revoked).
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION
  billing_trust_tx_before_insert(),
  billing_trust_entry_before_insert(),
  billing_trust_tx_check(),
  billing_trust_hold_after_insert(),
  billing_trust_statement_foot(),
  billing_trust_signoff_check(),
  billing_trust_period_close_check()
FROM PUBLIC, anon, authenticated;
