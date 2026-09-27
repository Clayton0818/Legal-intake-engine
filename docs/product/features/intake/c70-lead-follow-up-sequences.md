# c70 · Follow-up on unfinished chats and prospects who never booked

**Card:** `c70` Intake engine · Follow-up on unfinished chats and prospects who never booked (Product, P1)

## 1. Summary

Recovers leads that drop off: someone who stopped halfway through the chat, or finished intake but never booked or never signed. It sends a short, capped follow-up sequence (firm-set, e.g. 3 messages over 10 days) and then stops, and one reply of "stop" ends it on every channel. It only contacts people who reached out first and gave the needed consent, and never pressures or mentions the merits of their case.

**Scope flag:** `docs/product/scope-and-problem-statement.md` (c17) §5 says the product is inbound only and that follow-up sequences need their own barratry review before they are built, and c1 §8 leaves open whether automated follow-ups to inbound leads are solicitation. This card is therefore a scope change against c17 and should not be built until that attorney review is done (see open question 1).

## 2. Users and problem

- **Prospective client:** got interrupted, lost the link, or is undecided; a short reminder helps.
- **Firm:** loses leads that already chose to contact it.
- **Risk:** badly designed follow-ups can be harassing, solicitation, or unsafe for DV survivors.

## 3. Scope

**In scope**
- Three triggers: `abandoned_chat` (stopped mid-intake with contact details), `not_booked` (intake done, conflict clear, no booking), `not_signed` (consult held, agreement sent, not signed).
- Firm-set sequence per trigger, with product hard caps.
- Universal stop across channels.
- Suppression rules.
- Attorney-approved, versioned templates.

**Out of scope**
- Any contact to people who did not contact the firm (cold outreach, lists, retargeting ads).
- Personal-injury follow-ups (disabled by default, see rules).
- Client-task reminders on open matters (c46) and consult reminders (c67).

## 4. Behaviour

1. A lead enters a trigger state; the system checks eligibility (rules 1-6). If eligible, it schedules the sequence in `scheduled_tasks`.
2. Before each send, eligibility is checked again (anything could have changed: booked, replied, opted out, conflict result, safety flag).
3. Each message uses the approved template for that trigger, step, language and channel: a reminder that they contacted the firm, a link to continue or book, and how to stop. No case facts, no statements about their legal position, deadlines or chances, no urgency or pressure language.
4. Sent in firm business hours in the recipient's time zone and outside quiet hours (c42 preferences).
5. The sequence ends when: the last step is sent, the person books/signs/continues, a human replies to them, they say stop, or any suppression applies.
6. After the last step with no response, the lead is closed as `did_not_schedule` (existing terminal) or `abandoned`; `not_signed` leads go to the lawyer to decide whether to send a non-engagement letter (c62).

**Stop handling**
1. Keywords STOP, UNSUBSCRIBE, CANCEL, END, QUIT and Spanish equivalents (firm list, attorney-reviewed) on any channel end all follow-up on all channels immediately.
2. The AI also detects natural-language opt-outs ("please don't contact me") and treats them as stop; staff can see and cannot override without a new written request from the person.
3. A single confirmation of the stop is sent on that channel only if the firm's attorney approves it; default: none for email, one for SMS.

**Edge cases**
- Person gave only a phone number and no SMS opt-in: no texts; no calls from this sequence (calls are human follow-up under c69).
- Person switches language mid-way: next message uses the new language.
- Duplicate records (c71 not yet confirmed): suppression checks run across suggested duplicates too, so a stop on one blocks all.

## 5. Business rules

1. Only people who contacted the firm first (an inbound `intake_sessions` row exists that they started).
2. Texts only with the SMS opt-in from c72; email only to an address they gave for contact and did not mark unsafe.
3. Never to: conflicted-out or declined prospects (c62), people with a `possible` conflict until decided (then only if cleared), safety-flagged people without safe-contact confirmation (c66), people known to be represented by another lawyer, anyone who said stop.
4. Personal-injury matter types are excluded by default and cannot be enabled until attorney review (c1 §4 notes Penal Code § 38.12's 31-day rule around injury incidents; research pending review).
5. Firm-configurable sequence per trigger: number of messages (default 3), spacing (default days 1, 4, 10), channels. **Product hard caps** a firm cannot exceed: 4 messages and 14 days per trigger, one active sequence per person.
6. Templates must be marked "approved by attorney" (name, date, version) in the firm's template library before a sequence can be switched on.
7. Stop on any channel ends every channel, permanently for this inquiry.
8. Every send, skip (with reason) and stop is logged in c6 with the template version.
9. Follow-ups are not flags; they do not trigger c51 emails.

## 6. Data model touchpoints

- **Reuse** `intake_sessions` (`terminal_state`, `current_node`, `language`), `scheduled_tasks` (`task_type = 'lead_follow_up'`, payload: trigger, step), `intake_events`, `outbox` (sends), `conflict_check_results`, `firm_config_versions.config`.
- The existing `cadence_by_practice_area` config ([1, 2, 7, 7, 7], last = non-engagement message) comes from the reference SOP; this card proposes a new `follow_up.sequences` key and needs a decision on which default wins (open question 2).
- **Proposed** `contact_preferences` / `consents` (shared with c72, c66): SMS opt-in, stop status, represented-by-counsel flag.
- **Proposed** `message_templates` (shared with c85): id, purpose, language, channel, body, version, approved_by, approved_at.
- **Proposed** `follow_up_runs` (intake_session_id, trigger, step, status, stopped_reason).

## 7. Notifications and visibility

- Prospective client: only the approved follow-up messages.
- Staff: each lead shows follow-up status (step, next send, stopped reason).
- No internal flags from this card, except: a send failure after retries goes to the firm admin as an internal flag.

## 8. Dependencies

- Needs: attorney barratry review (c1 §8 open question), c72 (consents), c62 (declined list), c66 (safety suppression), c65 (channels), c71 (duplicates), c85 template library, c36 (Spanish).
- Feeds: c74 (recovered leads, lost-lead reasons), c67 (bookings).

## 9. Compliance and review flags

- **Attorney review (blocking):** whether automated follow-ups to someone who contacted the firm first are solicitation under Penal Code § 38.12 or the Texas advertising rules (Part VII), and whether any filing or labelling requirements apply to the templates.
- **Attorney review (blocking):** every template in English and Spanish, the stop keyword list and the stop confirmation.
- **Attorney review:** TCPA consent language for texts and whether the c72 opt-in covers follow-ups.
- **Attorney review:** email follow-up requirements (this spec does not assert any specific email law applies; counsel to confirm).
- No trust money; no CPA review.

## 10. Acceptance criteria

1. Given a chat abandoned after contact details with email but no SMS opt-in, when the sequence runs, then only emails are sent, at most 3 over 10 days by default.
2. Given a person replies STOP to the second text, when the next step is due, then nothing is sent on any channel and the stop is logged.
3. Given a declined or conflicted-out prospect, when they would enter `not_booked`, then no sequence is scheduled.
4. Given a firm tries to configure 6 messages, when it saves, then the save is refused citing the product cap of 4.
5. Given a template without attorney approval metadata, when the firm tries to switch on the sequence, then it is refused.
6. Given the person books after message 1, when message 2 is due, then it is skipped with reason `booked`.
7. Given a personal-injury inquiry, when it becomes `not_booked`, then no sequence is scheduled.
8. Given a safety-flagged person without safe-contact confirmation, when any step is due, then it is skipped with reason `safety`.

## 11. Open questions for Clayton

1. Block c70 on the attorney barratry review (recommended), or build it behind an off switch until the review lands?
2. Default cadence: the card's 3 messages over 10 days, or the reference SOP's five-step `cadence_by_practice_area`?
3. Should `not_signed` follow-ups be automated at all, or always a personal message from the lawyer?
