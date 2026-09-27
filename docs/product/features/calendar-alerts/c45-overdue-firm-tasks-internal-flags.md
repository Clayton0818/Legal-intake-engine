# c45 — Overdue tasks for the firm and its lawyers are flagged automatically, internally only

**Card:** c45 · Calendar & deadline engine · P1 · Product
**Status:** Draft spec. Foundation for c42, c43, c44, c46, c47, c53, c54 (and c40, c41, c69 in other groups).

## 1. Summary

Every piece of firm-side work becomes a task with an owner and a due time. When a task passes its due time without being done, it is flagged to the owner, then to the supervising lawyer and firm admin after a grace period; tasks tied to a court date, filing deadline or statute of limitations are flagged at the highest level immediately on the real clock. These flags are for firm users only, and the database, not just the screen, stops clients from reading them.

## 2. Users and problem

- **Lawyers and staff** need to see what they owe and what is late, in one list.
- **Supervising lawyers and the firm admin** need to know when something is late before it becomes a missed deadline or a client complaint.
- **The founder's requirement:** clients must never see that the firm is behind.
- Problem today: nothing tracks firm-side work after intake. `scheduled_tasks` exists but no handler acts on it (`src/worker/tick.ts` only proves the claim mechanism). Each engine inventing its own timer would create inconsistent, duplicated alerts.

## 3. Scope

**In scope**
- One task model and one overdue mechanism for all firm-owned work (owner = lawyer, staff member, or "the firm" as a pool).
- "Due soon" warning, overdue flag, escalation after grace, highest-severity path for deadline-linked tasks.
- Clearing rules with logged reasons.
- Where flags appear: matter page, personal task list, ops attention queue (c37).
- Access control that makes flag and task data unreadable to client principals.
- Being the timer mechanism for c40, c41, c43, c44, c54 cadence, c69.

**Out of scope**
- Creating tasks from templates (c94) — c45 only runs the clock on tasks however they are created.
- Client-owned tasks and their client-side display (c46).
- Calculating legal deadlines (c92) or the statute of limitations (c93). c45 reads whether a task is linked to a confirmed deadline; it never computes one.
- Email delivery mechanics (c51).

## 4. Behaviour

**Create**
1. A task is created (manually, by a template from c94, or by another engine: e.g. c43 creates `firm_reply_due`). It must have: matter (or intake session), owner, due time, clock (`business` by default), severity (`standard` unless linked to a confirmed calendar entry of type court date / filing deadline / SOL, which makes it `deadline_linked` with clock `real`).
2. The system writes `scheduled_tasks` rows for the due-soon time, the due time and the escalation time, all keyed to the task id.

**Due soon**
3. At due time minus the due-soon lead (default 1 business day; for deadline-linked tasks, default 48 real hours), the owner gets an in-app notice and a c51 email. No flag is raised yet.

**Overdue — standard task**
4. At the due time, if the task is still open: raise flag level 1 to the owner. Show on the matter, the owner's task list and the ops queue. Log it. Email per c51.
5. After the grace period (default 4 business hours) with the task still open: raise level 2 to the supervising lawyer and firm admin. Log. Email per c51 (digest-eligible if the firm chose digests).

**Overdue — deadline-linked task**
6. At the due time (real clock), raise level 3 immediately to owner, supervising lawyer and firm admin together. No grace period. Email immediately, never digested, not held by anyone's quiet hours.

**Owner = the firm (pool)**
7. A pooled task goes straight to the firm admin at level 1, and to the managing attorney at level 2.

**Clearing**
8. A flag clears only when the task is (a) completed, (b) reassigned, or (c) has its due time changed. Each needs a reason (free text, required) and is logged with who and when.
9. Reassigning an overdue task: the old flag clears; if the task is still past due, the new owner gets a level-1 flag immediately (deadline-linked: level 3 immediately).
10. Changing the due time of a deadline-linked task to later than the linked court deadline is refused. Moving the court deadline itself happens only in the calendar (c91) by a lawyer.
11. Cancelling a task (e.g. matter closed) clears its flags with a logged reason and cancels its `scheduled_tasks` rows.

**Failure paths**
12. Worker was down: on restart, due rows are processed oldest first; each step is idempotent per (task id, level), so no duplicate flags or emails.
13. Owner is disabled (`users.status = 'disabled'`): the task is treated as owned by the firm pool and the admin is flagged at once.
14. Matter has no responsible lawyer (`matters.assigned_user_id` null): level 2 goes to the firm admin only, with a note "no responsible lawyer".
15. Linked calendar entry is deleted or unconfirmed: the task drops to `standard` severity with a logged reason, and the owner is notified of the change.

## 5. Business rules

1. Every task has exactly one owner and one due time. (Testable: insert without either is rejected.)
2. Due-soon lead: **firm setting, default 1 business day** (standard); **default 48 real hours** (deadline-linked).
3. Grace before level 2: **firm setting, default 4 business hours**. Not applied to deadline-linked tasks.
4. Deadline-linked tasks use the real clock for due-soon, overdue and escalation.
5. Only one open flag per (task, level). Re-raising the same level is a no-op.
6. No silent clearing: every clear has actor, reason and timestamp in the audit trail.
7. There is no "snooze" for firm-task flags (c47 has check-back dates for stalled items; c45 does not).
8. Visibility: a lawyer sees flags on their own tasks and on tasks of people they supervise; a firm admin sees all firm flags; `intake_staff` see their own; `read_only` sees none (proposed default; open question 2).
9. Client principals have no read access to `tasks` where `visibility = 'internal'` or to `flags` where `visibility = 'internal'`, enforced by a database policy and checked by an automated test that fails CI.
10. Nothing from `tasks`/`flags` with internal visibility is ever included in: the client portal (c11), client notifications, client-facing AI prompts or context, or any client-shared export.
11. When a client asks about status, the client-facing AI gives a neutral acknowledgement and routes the question to the lawyer (which creates a c43 reply task); it never says the firm is behind.

## 6. Data model touchpoints

- **Reuse:** `scheduled_tasks` (existing) with `task_type` values `task_due_soon`, `task_overdue`, `task_escalate`, `payload.task_id`. `matters.assigned_user_id` (existing) as the responsible lawyer. `users.role` (existing) for visibility. `firm_config_versions.config` (existing) for grace/lead settings and the business calendar.
- **Proposed:** `tasks`, `flags`, `notifications` (see README). `tasks.supervisor_user_id` or a per-user `supervisor_user_id` on `users` (decision below).
- **Proposed dependency:** calendar entries (c91) with a confirmed flag and type, for `linked_calendar_entry_id`.
- **Audit:** every create/flag/clear/reassign event goes to the audit trail. Today `intake_events` requires `intake_session_id`, so post-intake matter events need the change noted in the README.
- **RLS:** `tasks` and `flags` get the standard `tenant_isolation` policy plus a principal-type policy (client principals: no rows where visibility is internal).

## 7. Notifications and visibility

| Event | Who | In-app | Email (c51) | Client sees? |
|---|---|---|---|---|
| Due soon | Owner | Yes | Yes | Never |
| Overdue L1 | Owner | Yes, matter + task list + ops queue | Yes | Never |
| Overdue L2 | Supervising lawyer, firm admin | Yes | Yes (digest-eligible) | Never |
| Deadline-linked L3 | Owner + supervisor + admin | Yes, top of ops queue | Yes, immediate | Never |
| Cleared | Everyone who was flagged | Yes | No | Never |

## 8. Dependencies

- **Needs first:** case-management data-model extension (tasks/flags tables; audit gap fix), c34 (real users and a client principal to deny), c37 (ops queue view), c6 (audit trail), c51 (email), c91 (calendar entries for severity).
- **Feeds:** c40, c41, c42, c43, c44, c46, c47 (dedupe), c48 (workload uses overdue tasks), c53 (overdue firm tasks signal), c54 (missed update cadence), c69, c94.

## 9. Compliance and review flags (licensed Texas attorney)

- Confirm that internal overdue flags and their reasons are appropriate internal records given they may be produced in a later grievance, fee dispute or malpractice matter; approve the "factual wording only" rule for clear reasons.
- Confirm the neutral status answer the AI gives a client ("your lawyer will get back to you") does not itself breach the duty to keep the client reasonably informed (TDRPC 1.03) when the firm is in fact behind; recommended approach is that the reply task still forces a human answer within c43's window.
- Confirm which calendar entry types make a task deadline-linked (court date, filing deadline, SOL, anything else such as discovery deadlines in family cases).
- No trust money: no CPA review.

## 10. Acceptance criteria

1. **Given** a standard task due Friday 16:00 with firm hours Mon–Fri 08:00–17:00 and a 4-business-hour grace, **when** it is still open at Friday 16:00, **then** the owner is flagged at L1 at 16:00 and the supervisor and admin at L2 at Monday 11:00.
2. **Given** a task linked to a confirmed hearing, due Saturday 10:00, **when** Saturday 10:00 passes with the task open, **then** owner, supervisor and admin are flagged at L3 at Saturday 10:00 and emails go out immediately.
3. **Given** an overdue flagged task, **when** a user marks it complete without a reason, **then** the action is refused; **when** they add a reason, **then** the flag clears and an audit event records actor, reason and time.
4. **Given** a signed-in client principal, **when** it queries `tasks` or `flags` directly through any API or the database role it uses, **then** zero internal rows are returned, and the CI test asserting this passes.
5. **Given** a client asks the portal AI "are you behind on my case?", **when** the firm has overdue tasks on the matter, **then** the AI's reply contains no reference to overdue work and a c43 reply task is created for the lawyer.
6. **Given** the worker was stopped for two hours over a task's due time, **when** it restarts, **then** exactly one L1 flag and one email are produced for that task.
7. **Given** a deadline-linked task, **when** a user tries to move its due time past the linked court date, **then** the change is refused with an explanation.

## 11. Open questions for Clayton

1. Where does "supervising lawyer" come from: a per-user supervisor setting, a per-matter supervising attorney, or always the managing attorney?
2. Should `read_only` users see firm-wide overdue flags, or none?
3. Confirm the defaults: due-soon 1 business day (48 real hours for deadline-linked), grace 4 business hours.
4. Which calendar entry types count as "deadline-linked" for the pilot (Family Law, Texas)?
