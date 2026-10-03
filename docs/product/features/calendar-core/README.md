# Calendar & deadline engine: calendar core (c91–c95)

**Status:** Built (wave 2, `src/engines/calendar-core`). These docs describe what the code does and what still needs review. Legal-rule parts are written as a recommended approach and **must be reviewed by a licensed Texas attorney** before anything is relied on.
**Read with:** `src/engines/README.md` (engine contract), `docs/product/features/calendar-alerts/README.md` (the sibling alerts engine, which reads this engine's calendar and tasks), `docs/product/case-management-expansion-scope.md` §5 (the UPL flag on deadline automation).

## Index

| Card | Title | Priority | What it does |
|---|---|---|---|
| [c91](c91-matter-calendar.md) | The matter calendar, synced to Outlook and Google | P0 | Events on the shared `calendar_events` table, firm/lawyer/matter views, lawyer-only confirmation, vendor-gated two-way sync. |
| [c93](c93-statute-of-limitations.md) | Statute of limitations with a second person verifying it | P0 | Lawyer-entered dates, blind independent verification, daily flags until verified, escalating reminders, logged changes. |
| [c92](c92-deadline-calculators.md) | Deadline calculators based on court rules | P1 | Lawyer-approved, versioned rule sets under `rules.court_deadlines`; results are proposed events a lawyer confirms. |
| [c94](c94-task-lists.md) | Standard task lists per practice area and stage | P1 | Versioned firm checklists that create tasks (with owners, due times and dependencies) when a matter reaches a stage. |
| [c95](c95-stages-and-closing.md) | Matter stages and closing per practice area | P1 | Per-practice-area lifecycles; stage changes run task lists, client-update tasks and billing events; a gated closing flow. |

## Principles applied everywhere

- **The AI never decides a date.** Every date not typed by a person starts `proposed`; only a lawyer (role `attorney`) confirms a deadline or court date (`canConfirmEvent` + the `ATTORNEY_ONLY` rule in `src/auth/rbac.ts`).
- **Real clock for deadlines.** Deadline and limitation tasks are `deadlineCritical` (real clock, no grace, critical). Ordinary checklist tasks use business hours.
- **Legal rules are gated config.** Court rules: versioned rule sets a firm lawyer approves, applied only under `rules.court_deadlines`. Limitation periods: only used to *suggest* a date, under `rules.limitation_periods`. Nothing is hard-coded as settled law.
- **Vendors behind stubs.** Outlook/Google sync: `vendor.calendar_sync`. Licensed court-rules provider: `rules.calendar-core.licensed_rules_provider`.
- **Internal only.** Every flag this engine raises is `audience: internal`. Nothing here writes to a client; stage changes create a task for the lawyer to send an update through c54.
- **Logged.** Every change goes to `audit_events` (engine `calendar-core`); changes to confirmed dates need a reason.

## Combined open questions for Clayton / an attorney

1. Filing-task due time on a limitation date: default 00:00 local on the date (conservative). Should it be end of the previous business day?
2. Which staff count as "trained" to verify limitation dates (firm setting `limitationVerifierUserIds`)?
3. Should a firm admin who is not an attorney be able to confirm non-deadline events (meetings)? Today: yes (shared `canConfirmEvent`); deadlines and court dates: attorneys only.
4. Licensed rules provider: which vendor, and how are its updates reviewed before a new version is approved?
5. The example Texas rule set (TRCP 99(b), 4, 21a) is **unverified** and exists to show the mechanism; an attorney must check values before any firm approves a version.
6. Trust-at-zero on closing is a lawyer attestation until the Billing & trust engine exposes a shared balance read.
