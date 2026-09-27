# c44 — Client questions about a deadline must get a reply within 24h

**Card:** c44 · Calendar & deadline engine · **P0** · Product
**Status:** Draft spec. Stricter tier on top of c43.

## 1. Summary

When a client's message is about a deadline (court date, filing, hearing, response due date, any "when do I have to..."), the client is promised a reply within 24 business hours, the lawyer is flagged at 12, and lawyer plus firm admin at 24. If the deadline itself falls before that reply would be due, the lawyer is alerted immediately on the real clock, weekend or not. The AI never answers the deadline question; it acknowledges and hands the lawyer the matter's relevant calendar entries.

## 2. Users and problem

- **Clients** asking about a deadline are often anxious and time-bound.
- **Lawyers** need to answer these first and need the dates in front of them to answer fast.
- Risk: a deadline question that sits unanswered over a weekend can mean a missed filing or hearing. Equally, an AI stating "your deadline is X" is applying law to the client's facts (UPL, TDRPC 5.05; scope memo §5) and a liability if wrong.

## 3. Scope

**In scope**
- Detecting deadline-related messages (AI tag, calendar proximity, staff re-tag).
- 12h/24h business-hour clocks and the 24h client promise.
- Real-clock safety net when the deadline precedes the reply due time.
- Attaching relevant calendar entries to the lawyer's view.
- The AI's refusal to answer and neutral acknowledgement.

**Out of scope**
- Computing deadlines (c92) or SOL (c93).
- Court-originated notices (c64).
- Emergencies (c66), though both can apply to one message.

## 4. Behaviour

1. Inbound client message arrives (c43 step 1).
2. **Tagging.** The message is tagged `deadline_related` if any of:
   a. the AI classifier judges the content deadline-related;
   b. the matter has a confirmed calendar entry of a deadline type within the lookahead (**firm setting, default 14 calendar days**);
   c. the client states a date or relative time for a court/filing event ("my hearing is tomorrow").
   If the classifier is unsure, it tags deadline-related (stricter clock). Tag source is recorded.
3. **Clocks.** Instead of c43's 24/48, create `firm_reply_due` with a **12-business-hour** lawyer flag and a **24-business-hour** escalation + client promise.
4. **Safety net (real clock).** Find the earliest relevant deadline: confirmed calendar entries on the matter within the lookahead, plus any client-stated date from 2c (marked "client-stated, not verified"). If that deadline is earlier than the 24-business-hour reply due time, alert the lawyer **immediately** (level 3, in-app + email, regardless of time of day or quiet hours).
5. **Auto-ack.** The AI acknowledges: it tells the client the question has gone to their lawyer and when to expect a reply (the 24h promise as a concrete time). It never states, confirms or corrects any date, even one the calendar holds, and never says what happens if the deadline is missed. If the client says the event is imminent, the ack includes the firm's approved "if this is urgent, call [firm number]" line.
6. **Lawyer view.** The flagged message shows the matter's confirmed calendar entries in the lookahead, the SOL entry if any (c93), and any unconfirmed calculator proposals (c92) visibly marked "unconfirmed".
7. At 12 BH with no human reply: flag the lawyer (level 1). At 24 BH: flag lawyer + firm admin (level 2); the client promise is now missed.
8. A human reply stops all clocks (c43 rule 5).
9. **Re-tag.** Staff can remove the tag with a reason (logged); clocks are recomputed from the original received time under c43 rules. Staff can add the tag; stricter clocks apply from the original received time, which may flag immediately.

**Edge cases and failures**
- Friday 17:00 question about a Monday 09:00 filing: the 24-BH due time is past Monday 09:00, so the safety net alerts the lawyer on Friday at 17:00.
- Deadline already passed (client asks about yesterday's hearing): immediate L3 alert.
- Responsible lawyer out of office: the safety-net alert also goes to the backup (open question 3); with no backup configured, to firm admin.
- The lawyer has not opened the safety-net alert within **1 real hour** (proposed firm setting): re-alert to firm admin (proposed; open question 2).
- Classifier unavailable: every inbound message on a matter that has any deadline in the lookahead is tagged deadline-related by rule 2b; others fall back to c43 and a "classifier down" notice goes to admin.
- Message tagged both emergency (c66) and deadline: both paths run.

## 5. Business rules

1. Lawyer flag: **firm setting, default 12 business hours**. Escalation + client promise: **firm setting, default 24 business hours**. The flag must be earlier than the promise.
2. Both count business hours; the safety net counts real time.
3. Uncertain classification applies the stricter clock.
4. Lookahead for calendar proximity: **firm setting, default 14 calendar days**.
5. The AI never states, confirms, or corrects a deadline date or its consequence to the client. Testable: client-facing AI output for tagged messages passes a check that rejects dates and deadline-consequence phrases.
6. The safety-net alert ignores quiet hours and digests.
7. Client-stated dates are shown to the lawyer as "client-stated, not verified" and are never written to the calendar automatically.
8. Only confirmed calendar entries are presented as the matter's deadlines.
9. Every tag, re-tag (with reason), clock, alert and reply is logged in the audit trail.

## 6. Data model touchpoints

- **Reuse:** `scheduled_tasks` (`reply_checkpoint`, `deadline_safety_net`), `firm_config_versions.config` (`deadline_reply.*`, lookahead), `matters.assigned_user_id`.
- **Proposed:** `messages.deadline_related`, `messages.deadline_tag_source`, `messages.client_stated_event_at` (nullable), `tasks`, `flags`; calendar entries from c91 with `confirmed_at`, `entry_type`.

## 7. Notifications and visibility

- Client: neutral ack with the 24h promise; nothing else. Never any flag.
- Lawyer: L3 immediate (safety net), L1 at 12 BH; lawyer + admin at 24 BH. All emailed immediately (urgent, never digested) per c51.
- Logged in audit trail (c6).

## 8. Dependencies

- **Needs first:** c43 (reply clock), c45 (tasks/flags), c51 (urgent email), c91 (confirmed calendar entries), c35 (real classifier; ADR-0001 D9 AI-vendor gate before real client messages), c34 + c11.
- **Related:** c92, c93 (shown to the lawyer, not used by the AI), c64, c66.
- **Feeds:** c45 (deadline-linked tasks), c53 (urgency multiplier, reply-time signal).

## 9. Compliance and review flags (licensed Texas attorney)

- UPL: approve the rule that the AI never states or confirms a deadline, and the exact acknowledgement wording (TDRPC 5.05; scope memo §5).
- Approve the "if urgent, call us" line and whether after-hours contact must be offered for imminent deadlines.
- Confirm that surfacing client-stated dates to the lawyer (without calendaring them) is the right handling.
- Confirm the 14-day default lookahead suits Texas family-law practice.
- No trust money: no CPA review.

## 10. Acceptance criteria

1. **Given** a client message "when is my answer due?", **when** received, **then** it is tagged deadline-related, the ack promises a reply within 24 business hours, and the ack contains no date.
2. **Given** a Friday 17:00 message about a confirmed Monday 09:00 filing, **then** the lawyer receives an L3 in-app alert and email on Friday within one worker tick, regardless of quiet hours.
3. **Given** a deadline-tagged message with no reply, **then** the lawyer is flagged at 12 business hours and lawyer + admin at 24 business hours.
4. **Given** the classifier returns low confidence, **then** the stricter clock applies.
5. **Given** staff remove the tag with a reason, **then** clocks revert to c43 values measured from the original received time and the change is logged.
6. **Given** a client says "my hearing is tomorrow" and no calendar entry exists, **then** the lawyer is alerted immediately with "client-stated, not verified" and no calendar entry is created.
7. **Given** the lawyer opens the alert, **then** the matter's confirmed calendar entries in the lookahead are displayed with it.

## 11. Open questions for Clayton

1. Same as c43: literal business hours or business days? With a 9-hour day, 12 business hours is about 1.3 business days.
2. Should an unopened safety-net alert re-escalate to the admin after 1 real hour?
3. Backup lawyer for out-of-office: per-lawyer backup or firm admin?
4. Lookahead window: 14 calendar days OK?
