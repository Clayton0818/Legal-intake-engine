# Intake engine: feature specs

**Status:** Draft product specs, docs only. Nothing here is code, and nothing here is a legal or accounting opinion. Every compliance-sensitive rule is written as research plus a recommended approach and is flagged for review by a licensed Texas attorney (and a CPA where trust money is touched) before it is built.
**Author:** Claude (workflow run), 2026-09-26.
**Pilot practice area:** Family Law, Texas (`c103`).

The Intake engine is the front door of the case-management product: every inquiry arrives here, is checked, sorted, answered by a human, booked, and either declined politely or turned into an open matter that the other four engines (Conflict-check, Document, Calendar & deadline, Billing & trust) pick up.

## Cards in this group

| Card | Title | Priority | One-line summary | Depends on (must exist first) | File |
|---|---|---|---|---|---|
| c65 | Intake from every channel lands in one intake record | P0 | Phone, web form, email inbox, SMS, referrals and staff-entered walk-ins all produce the same `intake_sessions` record and run the same disclosures, conflict check and triage. | c72, c58/c3, c13/c35, c71, c36, c34 | [c65-omnichannel-intake-record.md](c65-omnichannel-intake-record.md) |
| c66 | Emergencies and time-sensitive matters go to a live person immediately | P0 | Safety emergencies get a 911 message, a DV-safe path and a staff alert; urgent legal matters page the on-call lawyer on the real clock with escalation. | c35, c65, c72, c45, c51 | [c66-emergency-and-urgent-escalation.md](c66-emergency-and-urgent-escalation.md) |
| c67 | Book a consultation with the right lawyer once the conflict check clears | P0 | Self-booking against real calendar availability, only after a clear conflict result, with reminders, reschedule/cancel, no-show handling and an optional (gated) consult fee. | c3/c58, c59, c48, c72, c51, c75 (fee only) | [c67-consultation-booking.md](c67-consultation-booking.md) |
| c68 | Turn a prospect into an open matter when retained, and hand off to every other engine | P0 | A lawyer opens the matter only when conflict, signed engagement and first payment gates are met; every intake answer, party and document carries over and each engine is started. | c59, c39, c52, c50/c75, c56, c49, c53, c54, c11, c48, c6 | [c68-prospect-to-open-matter.md](c68-prospect-to-open-matter.md) |
| c14 | Configurable pipeline stages per firm | P1 | Firms relabel, reorder, hide and split pipeline stages on top of a fixed set of system stages that the rest of the product relies on. | c19, c24 | [c14-configurable-pipeline-stages.md](c14-configurable-pipeline-stages.md) |
| c48 | New work is automatically assigned to a lawyer or legal team | P1 | Eligibility filters then a firm-weighted score (cadence, workload, other factors); every assignment stores its score breakdown; humans can override. | c3, c59, c60, c34, c45, c44, c47, c6 | [c48-automatic-assignment.md](c48-automatic-assignment.md) |
| c69 | Every new inquiry gets a human response within a firm-set time | P1 | Speed-to-lead clock in business hours; only a real human contact stops it; misses become internal overdue tasks. | c65, c45, c51, c66 | [c69-speed-to-lead-response.md](c69-speed-to-lead-response.md) |
| c70 | Follow-up on unfinished chats and prospects who never booked | P1 | A short, capped, consent-based follow-up sequence that one STOP ends everywhere; never cold, never about the merits. | c72, c62, c65, c51, c1 barratry review | [c70-lead-follow-up-sequences.md](c70-lead-follow-up-sequences.md) |
| c73 | Each firm sets its own rules for which cases it takes | P1 | Versioned per-firm fit rules produce fit / borderline / no-fit; only clear no-fit is declined automatically (c62 letter); borderline always goes to a lawyer. | c13/c35, c62, c48, c102, c6 | [c73-firm-case-acceptance-rules.md](c73-firm-case-acceptance-rules.md) |

Note on `c14`: the card is in progress on the board but no spec or PR for it was found on `main` (checked `docs/product/` and PR search on 2026-09-26). This spec is written from scratch and is meant to be the design the in-progress work builds on.

## How the cards fit together

```
any channel (c65) -> disclosures (c72) -> minimal conflict check (c58/c3)
   |                         \-> emergency detection runs on every message (c66)
   v
triage (c13/c35) -> fit rules (c73) -> human response clock (c69)
   -> assignment of consult lawyer (c48) -> booking (c67)
   -> consult held -> engagement (c39) + first payment (c52/c50)
   -> lawyer opens matter (c68) -> hand-off to every engine
leads that stall at any step -> follow-up sequence (c70) or stall flag (c47)
all stage names shown to staff come from the firm's pipeline (c14)
```

## Cross-cutting rules every spec here follows

1. Response and overdue timers count firm business hours (firm hours, time zone, holidays). Emergency routing (c66), deadline safety nets and court notices run on the real clock.
2. Overdue or missed-target flags on firm work are internal only. The client never sees them, in the portal, emails, AI messages or exports.
3. Every flag also emails the affected party (c51) with minimal content, to the DV-safe address the person chose.
4. The AI never gives legal advice, never states or decides a legal deadline, never clears a conflict, and never agrees to representation. Lawyers approve.
5. Every automated decision is written to the audit trail (c6) with the firm config version and rule that produced it (`intake_events.rule_name`, `intake_events.firm_config_version_id`).
6. Firm settings live in the versioned `firm_config_versions.config` document, extending `docs/product/spec/firm-config.example.yaml`.

## Existing schema these specs build on

From `migrations/0000_material_thanos.sql`: `firms`, `users` (roles `firm_admin`, `attorney`, `intake_staff`, `read_only`, `integration_service`; `restricted_to_unassigned_matters`), `parties`, `matters` (`stage` enum `matter_stage`, `assigned_user_id`, `practice_area`, `opened_at`), `matter_parties` (`party_role`: `caller`, `opposing_party`, `co_party`), `conflict_check_results` (`outcome`: `clear`/`possible`/`definite`), `documents`, `firm_config_versions`, `intake_sessions` (`channel`, `language`, `collected_answers`, `classifier_output`, `terminal_state`), `intake_events` (append-only), `scheduled_tasks` (ADR-0001 D6 timers), `outbox`. All tables are tenant-scoped with RLS via `withTenant()`. Any table named in these specs that is not in that list is marked **proposed**.

Proposed tables that more than one spec relies on (to be designed once, in the case-management data model extension, scope memo §6 item 3): `tasks` (c45), `firm_calendars` / business-hours calendar, `teams` and `team_members`, `user_profiles` (practice areas, languages, counties, capacity), `contact_preferences` (safe contact method, consents), `notifications` (c51 delivery log), `matter_assignments`.

## Combined open questions for Clayton

Deduplicated from the individual specs; the spec that raises each one is in brackets.

1. **Intake manager role.** `user_role` has no "intake manager" or "firm owner" value. Add roles, or use `role_label` plus a per-firm "escalation contacts" setting? [c69, c48, c66]
2. **Barratry review for follow-ups.** c17 §5 lists follow-up sequences as out of scope pending a barratry review, and c1 §8 leaves open whether automated follow-ups to inbound leads count as solicitation under Penal Code § 38.12. Do you want c70 blocked on that attorney review (recommended), or built behind a switch that stays off until review? [c70]
3. **Existing cadence setting.** `firm-config.example.yaml` has `cadence_by_practice_area` ([1, 2, 7, 7, 7] days, five touches) from the reference SOP; the c70 card says 3 messages over 10 days. Which is the product default? [c70]
4. **Paid consult fee before the trust review.** Until c75 is signed off, should paid consults be disabled in-product, or allowed with the fee collected outside the system and marked paid by staff? [c67]
5. **Initial retainer vs the $4,500 floor.** For retainer matters, must the first deposit be at least the floor before the matter can open, or is the first deposit whatever the engagement agreement says? [c68]
6. **What counts as "payment received"** for opening a matter: processor-confirmed, or funds cleared in the bank (ACH can take days)? Needs CPA input. [c68]
7. **Auto-decline default.** Should clear no-fit cases be declined automatically by default, or should every decline need a lawyer click during the pilot? [c73]
8. **Capacity as a decline reason.** Recommended: "we're full" never auto-declines; it goes to a lawyer. Agree? [c73, c48]
9. **Voicemail and unanswered attempts.** Does a voicemail or two unanswered call attempts stop the speed-to-lead clock? [c69]
10. **AI voice vendor and after-hours model.** AI answers after hours only, or also overflow during business hours? And which voice/SMS vendors to put through the DPA gate? [c65]
11. **On-call rota ownership.** Who maintains the on-call rota in a solo firm with no backup lawyer, and what is the final escalation if nobody acknowledges? [c66]
12. **Team assignment.** Should c48 assign to individual lawyers only in the pilot, or also to teams (which needs a new `teams` table)? [c48]
13. **Stage names shown to clients.** Should the client portal (c11) show firm-labelled stages at all, or only a small fixed set of client-safe statuses? [c14]
14. **Referral-created leads.** When a lawyer or client refers someone, can the firm reach out first, or only record the referral and wait for the person to contact the firm (recommended until attorney review)? [c65]

## Needs attorney review (group summary)

c65 (recording consent, SMS consent, unsolicited email details under Rule 1.18, referral outreach), c66 (detection wording, crisis scripts, DV-safe practices), c67 (booking and reminder wording, consult fee terms, cancellation/refund terms), c68 (gates for when representation begins, engagement terms), c69 (acknowledgement wording, whether a promised response time is advertising), c70 (every template, barratry and Part VII advertising rules, TCPA consent), c73 (decline letter, referral list and Rule 1.04 referral fees), c14 (client-visible stage labels), c48 (screen and restriction enforcement, 1.10/1.18). **Needs CPA review:** c67 (consult fee: operating vs trust), c68 (trust ledger creation, what "payment received" means).
