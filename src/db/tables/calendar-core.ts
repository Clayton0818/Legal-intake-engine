// Tables owned by the Calendar & deadline engine — matter calendar, deadline calculators, limitation dates, task lists and stages (c91–c95).
//
// Engine-specific tables go here. Shared tables live in ./foundation.ts and
// ../schema.ts (import from those; never redefine or edit them). Follow the
// conventions documented at the top of ./foundation.ts: NOT NULL tenantId ->
// firms.id on every tenant-scoped table, text + CHECK for statuses,
// timestamptz everywhere. Add any hand-written RLS/GRANT needs as a
// "MIGRATION NOTES" comment at the bottom of this file; migrations are
// generated once at integration time.

export {};
