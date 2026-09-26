# c47 — Any other stalled workflow is flagged inside the firm and sent to the firm owner/admin

**Card:** c47 · Calendar & deadline engine · P1 · Product
**Status:** Draft spec. Catch-all behind c42–c46.

## 1. Summary

Any workflow item that has sat in the same stage with no activity for longer than that stage is expected to take is flagged to the firm owner and firm admin, internally. It only fires for items no specific rule is already watching, and it clears when the item moves or when someone records a reason with a check-back date.

## 2. Users and problem

- **Firm owner and admin** need to see work that has quietly stopped.
- Real examples today: intake sessions parked at `existing_caller_handoff` or `out_of_scope_gate` (c23 made these waiting states on purpose) and conflict checks stuck at `possible` waiting on an attorney (c3).

## 3. Scope

**In scope**
- Item types: intake session, matter, document in review, conflict check, invoice, pending payment (each activated when its engine exists).
- Per-stage expected durations (firm settings with defaults), a periodic sweep, flag content, dedupe, clearing and check-back.

**Out of scope**
- Anything already covered by c42, c43, c44, c45, c46 (or another card's own timer, e.g. c59 if it defines one).
- Client visibility (never).

## 4. Behaviour

1. A sweep runs on the worker (ADR-0001 D6) per tenant, every hour (a recurring `scheduled_tasks` row `stall_sweep`).
2. For each active item type, find items whose current stage has an expected duration and whose **last activity** is older than that duration in business hours:
   - Intake session: `intake_sessions.terminal_state IS NULL`, stage = `current_node`, last activity = latest `intake_events.occurred_at` for the session.
   - Conflict check: `conflict_check_results.outcome = 'possible'` and `resolved_at IS NULL`, last activity = `created_at` or latest related event.
   - Matter: `matters.stage`, last activity = latest matter event (needs the audit gap fix and c95 stages).
   - Document in review, invoice, pending payment: from their future tables.
3. **Dedupe:** skip any item that has an open task (c45) or open flag from another rule whose source is that item; skip items with an active check-back date.
4. Raise one internal flag per item: stage, time stuck (business hours and calendar days), last activity (what and when), owner. Deliver to firm owner(s) and firm admin, ops queue (c37), email per c51 (non-urgent, digest-eligible). Log.
5. **Clearing:** the item moves to another stage or gets new activity → flag clears automatically (logged). Or a user records a reason and a check-back date (e.g. "waiting on the court until Oct 10") → flag clears; the item is not re-flagged before that date; on that date, if nothing changed, it is re-flagged. Both are logged.
6. An item re-flags only after it clears; no daily repeats of the same flag.

**Edge cases and failures**
- Stage has no configured duration → never flagged (and the settings page lists such stages).
- Sweep fails mid-tenant → next sweep repeats; flag creation is idempotent per (item, stage, stall episode).
- Owner unknown → flag says "no owner" and goes to admin.
- Item deleted under retention (c2) → open flag cancelled, logged.

## 5. Business rules

1. Expected duration per (item type, stage): **firm settings**. Proposed defaults: `existing_caller_handoff` 1 business day; `out_of_scope_gate` 1 business day; conflict `possible` unresolved 1 business day; other intake nodes 2 business days; matter stages none until c95 defines them; document review 3 business days; invoice draft 5 business days; pending payment 5 business days.
2. Durations count business hours.
3. An item watched by a specific rule is never flagged by c47.
4. At most one open stall flag per item.
5. A check-back date requires a reason and a date no more than **90 days** ahead (firm setting).
6. Internal only; never visible to clients or in client exports.
7. Flag wording is factual (stage, durations, last activity, owner), no judgments.
8. Every flag, clear and check-back is logged.

## 6. Data model touchpoints

- **Reuse (existing):** `intake_sessions.current_node`, `terminal_state`; `intake_events.occurred_at`, `event_type`; `conflict_check_results.outcome`, `resolved_at`, `created_at`; `matters.stage`, `assigned_user_id`; `scheduled_tasks` for the sweep; `firm_config_versions.config` (`stall.durations`).
- **Proposed:** `flags` with `subject_type = 'workflow_item'`; `stall_checkbacks` (item ref, reason, check_back_on, set_by); firm-owner designation in firm settings.
- **Gap:** matter-level last activity needs matter events (README gap 1).

## 7. Notifications and visibility

- Firm owner(s) + firm admin: in-app, ops queue, email (digest-eligible).
- Item owner: sees the flag on the item.
- Clients: nothing.

## 8. Dependencies

- **Needs first:** c45 (flag model and dedupe by open task), c37, c6 (and audit gap fix), c51, firm-owner designation (c34-era roles).
- **Reads:** c23 intake states, c3/c59 conflict states, c95 matter stages, invoice/payment engines (c79, c80, c81) when built.
- **Feeds:** c53 (stalled steps in firm responsiveness).

## 9. Compliance and review flags (licensed Texas attorney)

- Conflict checks stuck at `possible`: confirm whether a pending possible-conflict decision needs a shorter, dedicated timer (likely c59's), since a prospective client (TDRPC 1.18) is waiting.
- Factual wording of internal flags and check-back reasons (discoverable records).
- No trust money: pending-payment stall only reads status; no CPA review for c47.

## 10. Acceptance criteria

1. **Given** an intake session at `existing_caller_handoff` with no events for more than 1 business day, **when** the sweep runs, **then** one internal flag is raised to owner and admin stating stage, time stuck, last activity and owner.
2. **Given** the same item already has an open c45 task, **then** c47 raises no flag.
3. **Given** a flagged item, **when** a user records "waiting on court" with check-back Oct 10, **then** the flag clears and is not raised again before Oct 10.
4. **Given** Oct 10 arrives with no change, **then** the item is re-flagged.
5. **Given** a flagged conflict check is resolved, **then** the flag clears automatically and the clear is logged.
6. **Given** a signed-in client, **then** no stall flag is reachable through any client API.
7. **Given** the sweep runs hourly, **then** a still-stalled item does not produce repeated flags.

## 11. Open questions for Clayton

1. Confirm proposed per-stage defaults, especially 1 business day for parked intake states and unresolved possible conflicts.
2. Who are "firm owners" for this flag: a named setting, or all `firm_admin` users?
3. Max check-back horizon (90 days)?
