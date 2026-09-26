# c67 · Book a consultation with the right lawyer once the conflict check clears

**Card:** `c67` Intake engine · Book a consultation with the right lawyer once the conflict check clears (Product, P0)

## 1. Summary

Booking is offered only after the conflict check returns clear (c3/c58) or a lawyer clears a possible conflict (c59). The prospective client then sees real availability from the right lawyer's calendar (practice area and language, using c48's rules), books a video or in-person consult, and gets confirmations and reminders, easy reschedule/cancel and no-show handling. An optional paid consult fee can be collected at booking once the trust-accounting review allows it.

## 2. Users and problem

- **Prospective client:** wants to book without phone tag, in their language, at a time that works.
- **Lawyer:** wants consults only with people the firm can take, on their real calendar, without double-booking.
- **Firm:** booking before conflicts clear risks hearing from the other side of an existing matter (Rules 1.06, 1.09, 1.18).

## 3. Scope

**In scope**
- Gate on conflict result.
- Availability from Microsoft 365 / Google calendars (free/busy), for eligible lawyers per c48.
- Meeting types from firm config (`meetings.initial_meeting`, `meetings.paid_consult`, `always_paid_consult_matter_types`); video, phone or in-person per `booking.channels_offered`.
- Confirmation and reminders by email, and text with consent (c72).
- Reschedule, cancel, no-show handling.
- Optional consult fee collection (gated).
- Hand-off to the Calendar & deadline engine.

**Out of scope**
- Deciding representation (c68), engagement (c39).
- Payment processor choice (c80).
- Consult notes and outcome templates (Document engine), beyond recording the outcome.

## 4. Behaviour

**Offer booking**
1. Conflict result `clear` (or c59 decision `cleared` / `proceed_with_consent` with signed waivers / `proceed_with_screen`), fit result not `no_fit` (c73), no open safety alert without safe-contact confirmation (c66).
2. Meeting type chosen from config: paid if the matter type is in `always_paid_consult_matter_types`, else initial meeting (the firm may offer both).
3. Eligible lawyers come from c48 eligibility. Firm setting `booking.lawyer_choice`: `assigned_only` (default; the c48 winner's calendar) or `any_eligible` (pooled slots, c48 ranking breaks ties).
4. Slots shown in the person's time zone, respecting `same_day_minimum_lead_hours` (existing, default 2), meeting duration, buffers and business hours.

**Book**
1. Person picks a slot and a format. The slot is held for 10 minutes while they confirm.
2. If a fee applies and fee collection is enabled: payment step; `payment_required_before_confirmation` (existing setting) decides whether the booking is confirmed before payment. Unpaid holds expire after `payment_hold_hours` (existing, default 24).
3. On confirm: calendar event written to the lawyer's calendar (event title minimal, e.g. "Consult - [initials]" per firm setting), a video link if video, `matters.stage` moves to `consultation_scheduled` (firm label per c14), confirmation sent.
4. Hand-off: a calendar entry and a task "Hold consult and record outcome" (c45) for the lawyer are created in the Calendar & deadline engine.

**Reminders**
1. Default reminders: 24 hours and 2 hours before (real clock; firm setting). Email always to the safe address; text only with SMS opt-in (c72); never to a channel marked unsafe (c66).
2. Reminder content: date, time, format, reschedule/cancel link, firm name. No case facts.

**Reschedule / cancel**
1. Link opens a page after a light identity check (one-time code to the contact method used to book). Reschedule shows fresh availability; cancel asks for an optional reason.
2. Refunds follow existing `cancellation` settings (`refund_on_client_cancellation_before_consult`, `refund_on_no_show`, `refund_on_firm_error`).
3. The firm can reschedule too; the client is notified with a reason category.

**No-show**
1. At start time + `grace_period_minutes` (existing, default 15) with no join/arrival recorded by the lawyer, the lawyer marks no-show (or the system prompts them to).
2. One re-book offer is sent. If the person re-books and no-shows again, or does not re-book within 5 business days, the lead is flagged to intake staff (internal) and becomes eligible for c70 only if consent rules allow.

**After the consult**
1. Lawyer records the outcome: `retain_offered`, `needs_follow_up` (maps to `consult_completed_manual_follow_up`), `declined_by_firm` (c62 letter), `client_declined`.

**Failure paths**
- Calendar sync fails: slots are not shown; the person is offered a request-a-callback path and staff are flagged. Never book against stale data older than 5 minutes.
- Slot taken between display and confirm: refuse, show next slots.
- A new party is added before the consult: c58 re-runs; if not clear, the booking is put on hold and the lawyer notified; the client is told the firm needs to reschedule, with no reason given.

## 5. Business rules

1. No booking UI, link or staff booking action exists for a session whose latest conflict result is not clear or attorney-cleared.
2. Only c48-eligible lawyers' slots are ever shown.
3. Availability reads free/busy only; the product does not read event contents from lawyers' calendars.
4. Reminders: firm-configurable offsets, default 24 h and 2 h before, real clock, respecting quiet hours for texts.
5. Texts only with SMS opt-in; email to the safe address; nothing to unsafe channels.
6. One re-book offer after a no-show (firm setting, 0 or 1; default 1).
7. Consult fee collection is disabled until the trust-accounting review (c75) is signed off and the firm has set, with its CPA, whether consult fees go to operating or trust. Firm setting `consult_fee.destination_account` has no default.
8. Card processing fees never come out of trust (c52/c80).
9. Every booking, reschedule, cancel, no-show and fee event is logged in c6.
10. The lawyer may book, reschedule or cancel on behalf of the client from the console.

## 6. Data model touchpoints

- **Reuse** `matters.stage` (`consultation_scheduled`), `matters.assigned_user_id`, `conflict_check_results`, `intake_sessions`, `scheduled_tasks` (reminders, holds, no-show check), `outbox` (calendar writes, retries), `firm_config_versions.config` (`meetings`, `booking`, `cancellation` already exist).
- **Proposed** `consultations` (id, tenant_id, matter_id, intake_session_id, lawyer_user_id, meeting_type, format, starts_at, ends_at, status `held|booked|rescheduled|cancelled|no_show|completed`, outcome, external_event_id, video_link, fee_amount, payment_status, rebook_offered_at).
- **Proposed** `calendar_connections` (user_id, provider `microsoft|google`, scopes, token reference in secret store, last_synced_at).
- Fee payments: proposed `payments` rows from Billing & trust (c80); not designed here.

## 7. Notifications and visibility

- Client: confirmation, reminders, reschedule/cancel notices, one re-book offer (email per c51 content rules; text only with consent).
- Lawyer: calendar event, in-app notice, consult task (c45). Overdue "record outcome" task follows c45 (internal only).
- Intake staff: no-show flag (internal), calendar-sync failure flag (internal), both emailed per c51.
- Client never sees internal flags or why a booking was put on hold.

## 8. Dependencies

- Needs: c3/c58 and c59 (gate), c48 (who), c73 (fit), c72 (consents), c66 (safe contact), c51 (delivery), c45 (tasks), calendar vendor DPAs, c34.
- Fee part needs: c75 (trust review, attorney + CPA), c80 (processor), c52.
- Feeds: c68 (consult outcome), Calendar & deadline engine, c70 (never-booked and no-show leads), c74 (consult booked / held).

## 9. Compliance and review flags

- **Attorney review:** booking, confirmation, reminder and no-show wording (English and Spanish); that a booked consult does not create an attorney-client relationship and says so.
- **Attorney review:** paid consult terms, refund rules and what the client is told the fee covers.
- **Attorney review:** TCPA consent for reminder texts.
- **CPA and attorney review:** whether a consult fee paid in advance must go to trust until the consult is held. Per the State Bar of Texas trust guide, *Cluck v. Comm'n for Lawyer Discipline*, 214 S.W.3d 736, and Opinion 611, advance fees belong in trust until earned; whether a consult fee is "earned" at booking is exactly the question for review. The product leaves the destination unset until the firm decides with its CPA.

## 10. Acceptance criteria

1. Given a session whose conflict result is `possible` and undecided, when the person asks to book, then no slots are shown and they are told the firm will follow up.
2. Given a clear result and a Spanish-language intake, when slots are shown, then only Spanish-speaking eligible lawyers' free time appears.
3. Given a booked consult, when 24 hours remain, then an email reminder goes to the safe address, and a text only if SMS opt-in is on record.
4. Given a no-show, when the lawyer marks it, then exactly one re-book offer is sent, and a second no-show flags the lead to intake staff internally.
5. Given fee collection is not enabled for the firm, when a paid-consult matter type books, then no payment step appears and staff see "fee to be handled outside the system" (or the pilot rule chosen in open question 1).
6. Given calendar sync last succeeded 10 minutes ago, when a person opens booking, then no slots are shown and a callback request is offered.
7. Given a confirmed booking, when the lawyer's calendar is viewed, then the event title contains no case facts.

## 11. Open questions for Clayton

1. Until c75 is signed off, should paid consults be disabled, or booked with the fee collected outside the product and marked paid by staff?
2. Default `booking.lawyer_choice`: assigned lawyer only (proposed), or let the client pick among eligible lawyers?
3. Which video provider (it becomes a subprocessor needing a DPA)?
