# c94 — Standard task lists per practice area and stage (P1)

## What it does
- Templates (`task_list_templates`) are versioned firm checklists keyed by practice area, optionally triggered by a stage key. Draft → active (by a lawyer or firm admin) → retired.
- Items: title, owner (`responsible_lawyer`, `firm`, `client`, or a named user), due hours on the business clock (or real clock; deadline-critical items must be real-clock and never client-owned), and dependencies (validated: no unknown keys, no loops).
- A run (`task_list_runs`, `task_list_run_items`) creates shared `tasks` for items without prerequisites at once. The worker hook `calendar-core.task_list_release` creates the rest when their prerequisites are done. Client-owned items become client-visible tasks (c46); everything else is internal (c45).
- A stage transition runs each template once (unique index).
- **DRAFT Family Law defaults** (`templates/familyLawDrafts.ts`): new matter, petition filed (serve respondent → calendar answer date, send client update — the card's example), respondent served, discovery, mediation, final orders. Seeded as drafts with `systemDraft = true`; never run until activated. No court deadline is computed in them.

## Routes
`task-lists` (GET/POST incl. `seed_family_drafts`), `task-lists/[id]` (activate/retire), `matters/[matterId]/task-lists` (GET/POST), `task-list-runs/[id]/cancel`.
