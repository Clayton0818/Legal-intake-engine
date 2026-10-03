# All engines (cross-cutting): feature specs and build notes

**Status:** Built in wave 2 (engine slug `all-engines`). Code: `src/engines/all-engines/**`, tables `src/db/tables/all-engines.ts`, API `src/app/api/all-engines/**`, admin `src/app/admin/all-engines/**`.
**Not legal advice.** The Family Law pack is a draft pending review by a licensed Texas family-law attorney; every Texas rule is a gated reference with no value, and every client-facing sentence renders as a visible `[PENDING ATTORNEY REVIEW …]` placeholder until approved.

| Card | Title | Priority | Status | Spec |
|---|---|---|---|---|
| c99 | Detailed permissions for each role | P0 | Built | [c99-permissions.md](c99-permissions.md) |
| c102 | Practice areas chosen in firm settings | P0 | Built | [c102-practice-areas.md](c102-practice-areas.md) |
| c103 | Family Law pack (pilot practice area) | P0 | Built as draft data, pending attorney review | [c103-family-law-pack.md](c103-family-law-pack.md) |
| c98, c100, c101, c104, c105 | Data import, mobile, reports, Immigration and PI packs | — | Not in this wave | — |

## How the three fit together

```
c99 policy  can(actor, right, resource)  ──► every route / engine (after the Foundation moves it to src/core)
     │  owner/admin hold practice_areas.manage
     ▼
c102 settings flow ──► firm_settings.enabled_practice_areas (shared)
     │                 firm_settings.engine_settings["all-engines"].practiceAreaPacks (accepted pack snapshots)
     ▼
c103 Family Law pack (data) ──► read by intake, conflict-check, document, calendar-core, billing-trust
                                 through firm settings — never by import
```

All three write to one append-only `access_change_log` and to the shared `audit_events` (c6).
