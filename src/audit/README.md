# audit/

Helpers for writing `intake_events` rows (`docs/architecture/audit-log-compliance-trail.md`, board card `c6`). The table itself is already immutable at the database-permission level (see `migrations/0000_*.sql`'s `REVOKE UPDATE, DELETE`) — this directory is where the *shape* of a well-formed event gets enforced in code, so every call site produces a consistent `event_type`/`payload` rather than each caller inventing its own format.

Nothing here yet beyond what's implied by `withTenant()` usage elsewhere — a typed `recordEvent()` helper is the natural first addition, whenever the next card that emits an audit event (most likely `c3`'s conflict-check outcomes, or `c13`'s classifier `safetyFlag`) needs one.
