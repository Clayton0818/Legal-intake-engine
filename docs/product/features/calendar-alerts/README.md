# Calendar & deadline engine: alerts and client communication — feature specs

**Status:** Product specifications (draft). Docs only; no code. Compliance-sensitive parts are written as research plus a recommended approach and are flagged for review by a licensed Texas attorney before anything is built. Nothing in this group moves trust money, so no CPA review is required for these nine cards (c53 only *reads* the retainer-floor flag that c50 raises; c50 itself carries the CPA flag).
**Author:** Claude (workflow run, 2026-09-26), from the board card notes, which are authoritative.
**Read with:** `docs/product/case-management-expansion-scope.md` (scope memo), `docs/product/scope-and-problem-statement.md` (c17), `docs/product/spec/README.md` (c12), ADR-0001, and `migrations/0000_material_thanos.sql`.

No spec existed on `main` for any of these cards before this PR (checked `docs/product/`, which has no `features/` folder yet), so every file here is new.

## Index

| Card | Title | Priority | One-line summary | Depends on |
|---|---|---|---|---|
| [c45](c45-overdue-firm-tasks-internal-flags.md) | Overdue tasks for the firm and its lawyers are flagged automatically, internally only | P1 | The one task + flag mechanism every other alert in this group runs on; firm-side flags are invisible to clients, enforced by access control. | Data model extension (scope memo §4), c34, c37, c6, c51 |
| [c51](c51-flag-email-delivery.md) | Every flag also sends an email to the affected party, separate from the in-app notification | P1 | Two independent deliveries per flag (in-app + minimal, DV-safe email from the firm's domain), with bounce tracking. | Email subprocessor + DPA (c10), c34, c6 |
| [c43](c43-firm-reply-clock-24h-48h.md) | Firm must reply to a client within 24h (flagged if not); client is promised 48h | P1 | Every inbound client message starts an internal 24h clock and a 48h client promise, in business hours. | c45, c51, c37, c6, c35/c66, c91 |
| [c44](c44-deadline-question-reply-clock.md) | Client questions about a deadline must get a reply within 24h | **P0** | Stricter tier of c43 (12h flag / 24h promise) plus a real-clock safety net when the deadline itself is close; the AI never answers. | c43, c91, c35, c45, c51 |
| [c42](c42-client-non-response-ladder.md) | Client non-response is logged, flagged to lawyer and firm admin, and triggers a client reminder | P1 | Every outbound message gets a response window; a lapse is logged, flagged internally, and starts a neutral, firm-configured reminder ladder. | c45, c51, c37, c6, c11, c34 |
| [c46](c46-client-overdue-tasks.md) | Client's overdue tasks are flagged to the client (client-side) and to the firm and lawyer | P1 | Client-owned tasks go overdue on both sides; the client only ever sees their own tasks. | c45, c42, c11, c34, c51 |
| [c47](c47-stalled-workflow-catch-all.md) | Any other stalled workflow is flagged inside the firm and sent to the firm owner/admin | P1 | A periodic sweep that flags anything stuck in a stage longer than expected that no specific rule is watching. | c45, c37, c6, c51 |
| [c54](c54-client-updates-portal-and-email.md) | Client updates are sent by email and kept in the client portal | P1 | Permanent, searchable update history in the portal, email notice per c51, AI drafts need lawyer approval, corrections never overwrite. | c11, c34, c51, c43, c45 |
| [c53](c53-case-health-meter.md) | Case health meter based on client-firm interaction | P1 | Explainable 0–100 internal score with firm and client sub-scores built from the signals above; prompts a human, never acts. | c42–c47, c49, c50, c52, c54, c33 |

Suggested build order inside the group: **c45 → c51 → c43 → c44 → c42 → c46 → c54 → c47 → c53**. c44 is the only P0, but it cannot work without c45's task mechanism and c43's reply clock, so it is third, not first.

## Shared concepts (defined once, used by every spec)

### Two clocks

- **Business clock.** All response, reply, overdue, grace and stall timers count the firm's business hours: firm hours per weekday, firm time zone, firm holiday calendar. Proposed home: a `business_calendar` block in `firm_config_versions.config` (existing jsonb column): `{ time_zone, weekly_hours: {mon: ["08:00","17:00"], ...}, holidays: [dates] }`. A duration of *N business hours* is computed by walking forward through open hours only. A message received outside open hours starts its clock at the next opening.
- **Real clock.** Deadline safety nets (c44, c45 severity, c46 court-linked tasks) and court notices (c64) run on wall-clock time, weekends and nights included.
- When the firm edits its hours or holidays, timers that have not fired yet are recomputed from their original start time; timers that already fired are not re-run. Every recomputation is logged.

### Tasks and flags (proposed tables; owned by the case-management data-model extension, scope memo §4 item 3)

None of these exist in `migrations/` today. They are listed here so the nine specs describe one shape, not nine.

- `tasks` (proposed): `id, tenant_id, matter_id, intake_session_id?, kind, title, owner_type ('user'|'firm'|'client'), owner_user_id?, owner_party_id?, supervisor_user_id?, source_type, source_id, due_at, clock ('business'|'real'), severity ('standard'|'deadline_linked'), linked_calendar_entry_id?, visibility ('internal'|'client'), status ('open'|'completed'|'cancelled'), completed_at, completed_by, created_at`.
- `flags` (proposed): `id, tenant_id, matter_id?, subject_type ('task'|'message'|'workflow_item'|'matter_health'), subject_id, kind, level (1 = assignee, 2 = supervisor/admin, 3 = highest/urgent), visibility ('internal'|'client'), raised_at, cleared_at, cleared_by, clear_reason`.
- `messages` (proposed, scope memo §4 names it): `id, tenant_id, matter_id, direction ('inbound'|'outbound'), sender_type ('client'|'user'|'ai'), sender_user_id?, sender_party_id?, channel ('portal'|'email'|'sms'|'phone_log'), thread_id, in_reply_to_id?, is_auto_ack, expects_reply, reply_window_override?, deadline_related, deadline_tag_source ('ai'|'calendar'|'staff'), urgent, occurred_at`.
- `notifications` (proposed): the in-app delivery row per flag per recipient.
- `email_deliveries` (proposed): per flag or update per recipient: `status ('queued'|'sent'|'delivered'|'bounced'|'complained'|'suppressed'|'failed')`, provider id, timestamps. Sending itself reuses the existing `outbox` table (`destination = 'email'`).
- `contact_preferences` (proposed): per client party: safe email, channel opt-ins/outs, SMS consent evidence, quiet hours, "no email for sensitive flags".
- Timers reuse the existing `scheduled_tasks` table and worker (ADR-0001 D6). Note that `src/worker/tick.ts` today claims due rows and marks them completed without running any handler; a task-type dispatcher is a prerequisite for every card here.

### Gaps in the current schema that these specs depend on

1. **Audit trail cannot hold matter-only events yet.** `intake_events.intake_session_id` is `NOT NULL`, and `actor_type` allows only `system|user|caller`. Post-intake events (a reply clock lapsing on a retained matter) have no session. The data-model extension must either make `intake_session_id` nullable or add an append-only `matter_events` table with the same `REVOKE UPDATE, DELETE` protection. Every spec here says "logged in the audit trail (c6)" and means whichever of those is chosen.
2. **No client principal.** `user_role` has `firm_admin, attorney, intake_staff, read_only, integration_service`; clients are `parties`, not `users`. Client login and a client role come from c34 (vendor decision pending). The internal-only guarantees in c45/c47/c53 must be enforced against that client principal.
3. **No firm-owner or supervising-lawyer concept.** Proposed: firm config names owner user(s) and a managing attorney; `tasks.supervisor_user_id` or a per-user supervisor setting (decision in c45).
4. **`matter_parties.role`** is `caller|opposing_party|co_party`; a `client` role (or equivalent) is needed so tasks and messages can only ever be addressed to the firm's own client, never the opposing party.
5. **Calendar entries** (c91) do not exist yet; c44 and the severity rules in c45/c46 read them.

### Visibility boundary (applies to every spec)

- **Internal only, never client-visible:** firm-task flags (c45), reply-clock flags (c43, c44), stall flags (c47), case health (c53), and the firm-side copy of client-facing flags (c42, c46).
- **Client-visible:** reminders about the client's own outstanding replies (c42), the client's own tasks (c46), client updates (c54), auto-acknowledgements (c43/c44).
- The AI that talks to clients is never given internal task/flag/health data as input, so it cannot leak it. "Structure over convention" (ADR-0001 D5) applied to visibility.

## Combined open questions for Clayton

Grouped and de-duplicated from the individual specs. Each spec lists its own too.

1. **What does "24 business hours" mean?** Counted literally (24 working hours = about 3 business days with a 9-to-5 firm), or "24 hours with nights, weekends and holidays paused" read as one business day? The founder decision says "a Friday-evening message is flagged 24 business hours later", which works under both readings. The specs default to the literal reading, but it changes every clock in c42–c47 and the promise text the client reads (c43/c44). **This is the most important decision in the group.**
2. **What exactly does the client-facing promise say?** Recommended: a concrete day ("we'll reply by end of day Tuesday") rather than "48 hours", which would be misleading if the clock counts business hours (c43, c44).
3. **Does a staff holding reply ("got it, the lawyer will call you Thursday") stop the c43/c44 clock?** The card says any real reply from lawyer or staff counts; confirm that includes holding replies.
4. **Is SMS in v1 at all,** or email + portal only until the TCPA consent flow is reviewed (c42, c46, c51)?
5. **Do c42 reply windows apply to prospective clients before engagement,** or only after the engagement agreement (c39)? Pre-engagement follow-up overlaps intake cadences (c69) and the outbound-contact barratry flag in c1 §4.
6. **Sender domain fallback (c51):** if a firm has not verified its email domain yet, block client emails, or send from a vendor subdomain under the firm's display name?
7. **Who is "firm owner" and "managing attorney"** for escalations (c43 48h step, c47)? Proposed: named in firm settings.
8. **Does the client email for a c54 update contain the update text,** or only "you have a new update" plus a portal link (the c51 minimal default)?
9. **Backup routing when the responsible lawyer is out of office** for urgent c44 alerts: named backup per lawyer, or firm admin?
10. **Default numbers** the specs propose and you should confirm or change: c42 window 2 business days and ladder; c45 grace 4 business hours; c46 reminder cadence; c47 per-stage durations; c53 weights and thresholds; c54 update cadence (off by default).

## Needs licensed Texas attorney review (group summary)

- Client-facing wording: auto-acknowledgements, reminders, overdue-task notices, update templates — neutral, no legal consequences unless lawyer-approved (c42, c43, c44, c46, c54).
- The UPL line for AI-drafted updates and for the AI's refusal to answer deadline questions (TDRPC 5.05; scope memo §5; c1).
- Communication duty framing (TDRPC 1.03) behind the 24/48h and cadence rules — as rationale only, not a claim that these numbers are what the rule requires.
- Email of client matter information and the DV-safe contact model (TDRPC 1.05; c103 pilot practice area).
- SMS consent (TCPA) before any SMS ships; whether reminders to engaged clients or prospects raise any barratry/solicitation issue (c1 §4).
- Discoverability of internal flags and health scores in later disputes; factual-wording rules (c45, c47, c53).
- Records: how long flags, deliveries and updates are retained (c2).

## Sources consulted

- Board card notes for c42, c43, c44, c45, c46, c47, c51, c53, c54 and the cards they reference (c1, c3, c6, c10, c11, c23, c33, c34, c35, c37, c39, c40, c41, c48, c49, c50, c52, c59, c64, c66, c69, c91, c92, c93, c94, c95, c103).
- `docs/product/case-management-expansion-scope.md` (§4 data model, §5 UPL flag), `docs/product/scope-and-problem-statement.md`, `docs/product/spec/README.md`.
- `migrations/0000_material_thanos.sql`, `src/worker/tick.ts`, `src/audit/README.md` (existing schema and worker).
- Texas Disciplinary Rules of Professional Conduct, Rule 1.03 (Communication), Texas Center for Legal Ethics: https://www.legalethicstexas.com/resources/rules/texas-disciplinary-rules-of-professional-conduct/communication/ — verified for this PR because the c43 card cites it.
- Founder-verified points listed in the workflow brief: TDRPC 1.05, 1.06, 1.09, 1.10, 1.18, 5.05; TRCP 21a; TCPA consent for texts.
