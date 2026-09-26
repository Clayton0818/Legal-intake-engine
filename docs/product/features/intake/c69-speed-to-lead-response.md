# c69 · Every new inquiry gets a human response within a firm-set time

**Card:** `c69` Intake engine · Every new inquiry gets a human response within a firm-set time (Product, P1)

## 1. Summary

A speed-to-lead promise. The firm sets a target (for example 15 minutes during business hours, first thing next business morning otherwise). The AI acknowledges immediately, but only a real contact from staff or a lawyer stops the clock. Missed targets become overdue firm tasks (c45) that go to the intake manager, then the owner/admin; emergencies bypass the queue (c66).

## 2. Users and problem

- **Prospective client:** people often contact several firms; the first human response often wins.
- **Intake staff / intake manager:** need a clear queue sorted by time left.
- **Firm owner:** needs to know response times are being met (c33, c74).

## 3. Scope

**In scope**
- Per-inquiry response clock in business hours.
- Immediate AI acknowledgement (does not stop the clock).
- Definition of "real human contact".
- Overdue task and escalation via c45.
- Metrics to c33 and c74.

**Out of scope**
- Emergencies (c66, real clock).
- Existing-client message replies (c43/c44).
- Follow-up sequences after contact (c70).

## 4. Behaviour

1. Inquiry arrives on any channel (c65). The clock starts at the first inbound message with usable contact details.
2. The AI acknowledges immediately in the same channel (firm-approved text, e.g. "Thanks, a member of our team will contact you"). Whether it names the target time is a firm setting (default: no).
3. A task "First human response" (c45) is created, owned by the intake queue, due at the target time computed in business hours.
4. Staff see the queue sorted by time remaining; a "due soon" warning fires at 50% of the target (firm setting).
5. The clock stops on the first **real human contact**: a connected phone call by staff or a lawyer, or a message written and sent by a named staff member or lawyer through the person's consented channel. Logged with who and how.
6. Unanswered attempts (voicemail, no answer, message not replied to) are logged as attempts. Default: after 2 logged attempts on different channels or at least 1 business hour apart, the task is completed as `attempted` (stops the overdue flag, reported separately). Firm-configurable.
7. Target missed: the task goes overdue per c45: flag to the intake manager; if still open after the grace period (firm setting, default 30 business minutes), to the firm owner/admin. Each flag also emails per c51 (internal only).
8. Emergency detected (c66): the item leaves this queue and follows the real-clock emergency path; the c69 clock is marked `bypassed_emergency`.

**Edge cases**
- Spam, vendor, wrong number, existing client: staff close as `not_an_inquiry` with a reason; clock stops; excluded from metrics.
- Safety-flagged person without safe-contact confirmation: staff may not message or call an unsafe channel; the task shows "contact only via confirmed safe channel"; if none, the lawyer on the c66 alert decides.
- Conflict `definite`: the human response is the lawyer-approved neutral decline (c62); approving it stops the clock.
- Inquiry arrives outside business hours: due time = business opening + target (default rule "first thing next business morning" = 60 business minutes after opening).
- Holiday calendar missing: falls back to Mon-Fri 9-5 firm time zone and flags the admin to set holidays.

## 5. Business rules

1. The clock counts firm business hours (firm hours, time zone, holidays).
2. Firm-configurable targets: `in_hours_target_minutes` (default 15), `after_hours_target_minutes_after_open` (default 60).
3. AI messages never stop the clock.
4. Only contacts by a named user with role `attorney` or `intake_staff` (or `firm_admin`) stop the clock.
5. Attempt rule firm-configurable: attempts needed (default 2), minimum spacing (default 1 business hour).
6. Overdue flags are internal only; the client is never told the firm is late.
7. Escalation: intake manager first, owner/admin after grace (default 30 business minutes).
8. Contacts respect contact preferences, quiet hours and consents (c72, c66).
9. Response times (to first human contact, to attempt) feed c33 and c74 as aggregates by channel, practice area and staff member.
10. Every clock start, stop, attempt, bypass and flag is logged in c6.

## 6. Data model touchpoints

- **Reuse** `intake_sessions` (`started_at`, `channel`), `intake_events` (`first_human_contact`, `contact_attempt`), `scheduled_tasks` (due-soon and overdue timers, `task_type = 'speed_to_lead'`), `users.role`.
- **Proposed** `intake_sessions.first_human_contact_at`, `first_human_contact_by`, `response_target_at` (denormalised for reporting), or computed from events.
- **Proposed** `tasks` (c45) for the "First human response" task.
- **Proposed** `firm_calendars` (business hours, time zone, holidays), shared by all business-hours clocks.

## 7. Notifications and visibility

- Client: immediate AI acknowledgement only. Never any overdue status.
- Intake staff: queue with countdown, due-soon warning.
- Intake manager, then owner/admin: overdue flags in-app and email (c51 internal).
- Owner: response-time metrics on c33 / c74.

## 8. Dependencies

- Needs: c65 (channels), c45 (tasks and overdue), c51 (email), c66 (bypass), c72 (consents), business-hours calendar, c34 (named users).
- Feeds: c33, c74, c53, c70 (leads with no contact after attempts).

## 9. Compliance and review flags

- **Attorney review:** the acknowledgement wording, and whether advertising a response time ("we respond within 15 minutes") is a claim the firm must be able to substantiate under the Texas advertising rules (Part VII) and the consumer-protection concern c1 §6 raises.
- **Attorney review:** that an acknowledgement does not imply representation.
- No trust money; no CPA review.

## 10. Acceptance criteria

1. Given a web chat inquiry at 10:00 on a business day with a 15-minute target, when no staff contact happens by 10:15, then an overdue flag goes to the intake manager in-app and by email.
2. Given an inquiry at 21:00 Friday and business hours Mon-Fri 9-5, when the due time is computed, then it is 10:00 Monday (60 business minutes after opening).
3. Given the AI has sent an acknowledgement, when the queue is viewed, then the clock is still running.
4. Given staff log two unanswered calls 1 business hour apart, when the second is logged, then the task completes as `attempted` and no overdue flag fires.
5. Given an emergency is detected, when the item is routed to c66, then it leaves the speed-to-lead queue and is marked `bypassed_emergency`.
6. Given an overdue speed-to-lead task, when the client views the portal or receives any message, then nothing mentions the delay.
7. Given staff mark an inquiry as spam with a reason, when metrics are computed, then it is excluded.

## 11. Open questions for Clayton

1. Does a voicemail count as a contact attempt, and do two attempts stop the clock (proposed), or must a real conversation happen?
2. Who is the "intake manager" in data terms, given `user_role` has no such value?
3. Should the AI acknowledgement state the target time to the person (default proposed: no)?
