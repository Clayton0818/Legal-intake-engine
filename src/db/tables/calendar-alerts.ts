// Tables owned by the Calendar & deadline engine — alerts, reply clocks, flags and client updates (c42–c47, c51, c53, c54, c64).
//
// Engine-specific tables go here. Shared tables live in ./foundation.ts and
// ../schema.ts (import from those; never redefine or edit them). Follow the
// conventions documented at the top of ./foundation.ts: NOT NULL tenantId ->
// firms.id on every tenant-scoped table, text + CHECK for statuses,
// timestamptz everywhere. Add any hand-written RLS/GRANT needs as a
// "MIGRATION NOTES" comment at the bottom of this file; migrations are
// generated once at integration time.

export {};
