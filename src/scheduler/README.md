# scheduler/

Helpers for writing to `scheduled_tasks` (`src/db/schema.ts`) — the due-at rows the worker (`src/worker/tick.ts`) claims with `FOR UPDATE SKIP LOCKED`, per ADR-0001 §D6. Cadence timing itself (`cadence_by_practice_area`, SLA windows) comes from `firm-config.example.yaml`, read through `firm_config_versions` the same way `flow/` does.

Nothing lives here yet beyond the worker's claim loop in `src/worker/tick.ts` — task-type-specific handlers (payment reminders, SLA escalations) arrive with whichever card first needs one (`c3`'s conflict-review SLA is the most likely first caller).
