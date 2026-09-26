# c43 — Firm must reply to a client within 24h (flagged if not); client is promised 48h

**Card:** c43 · Calendar & deadline engine · P1 · Product
**Status:** Draft spec. c44 is a stricter tier layered on this.

## 1. Summary

Every inbound client message starts two business-hour clocks: an internal 24h target that flags the lawyer and firm admin if missed, and a 48h promise that the auto-acknowledgement makes to the client. Only a real reply from a lawyer or staff member stops the clocks; the AI's acknowledgement never does, and the AI never answers the client's legal question.

## 2. Users and problem

- **Clients** want to know they were heard and when to expect an answer.
- **Lawyers and staff** need a nudge before a slow reply becomes a broken promise.
- **Firm admin / managing attorney** need to know when the promise to a client has actually been missed.
- Rationale on the card: prompt communication is a professional duty. TDRPC 1.03(a) requires a lawyer to keep a client reasonably informed about the status of a matter and promptly comply with reasonable requests for information (Texas Center for Legal Ethics, Rule 1.03). Slow replies are a common complaint source. The 24/48 numbers are the firm's service standard, not a number the rule sets.

## 3. Scope

**In scope**
- Inbound client messages on any tracked channel: portal (c11), email filed to the matter (c87), SMS if enabled, and phone calls/voicemails that staff log as messages.
- Auto-acknowledgement with the client promise.
- Internal 24h flag, 48h escalation, urgent bypass.
- What stops the clock and what does not.

**Out of scope**
- Deadline-related messages' stricter clocks (c44) — c43 hands off to c44 when the tag applies.
- New prospective-client inquiries (c69 owns speed-to-lead).
- Messages from the opposing party, opposing counsel or courts (c64 handles court email).
- The AI answering the question (never).

## 4. Behaviour

1. An inbound message from a client party is recorded on the matter (`messages`, direction inbound, sender_type client).
2. The classifier checks for: safety flag (c35/c66), deadline-related (c44), and whether a confirmed deadline on the matter falls inside the 48-business-hour window (real-clock comparison).
   - Safety flag → c66 emergency path plus immediate lawyer alert (level 3). Reply clocks still run.
   - Deadline-related → c44 clocks apply instead of c43's.
   - Filing/court deadline inside the window → immediate lawyer alert (level 3), then normal clocks.
3. If there is already an open reply task on this matter's conversation, **no new clock starts**; the existing clock (started by the earliest unanswered message) keeps running. The new message is attached to that task.
4. Otherwise create a `firm_reply_due` task (c45) owned by the responsible lawyer, due at received time + 24 business hours, and a second checkpoint `client_promise_due` at + 48 business hours. A message received outside firm hours starts counting at the next opening.
5. Send the auto-acknowledgement immediately (it is a direct response to the client). It states the promise in the firm's chosen form (recommended: a concrete day, e.g. "You'll hear from us by end of day Tuesday"), contains no legal information, and does not answer the question. It is delivered in the portal and by email per c51 (to the client's safe address, even if the client wrote from another address).
6. At + 24 business hours with no real reply: the c45 task goes overdue → flag the responsible lawyer and the firm admin (ops queue c37), log, email per c51.
7. At + 48 business hours with no real reply: escalate to firm admin and managing attorney: "client promise missed". Log. Email.
8. A real reply arrives (outbound message by a lawyer or staff user, not `is_auto_ack`, sent to the client on this matter): complete the task with reason "replied", cancel the pending checkpoints, clear flags. Log.
9. Staff can close the task without replying only with reason "no reply needed" (e.g. the client wrote "thanks!"); logged.

**What does not stop the clock**
- The AI's auto-acknowledgement or any AI-generated message not sent by a human.
- An AI-drafted reply sitting unapproved.
- Internal notes, reading the message, or reassigning it.

**Edge cases and failures**
- Responsible lawyer unassigned → task owned by the firm pool (c45 rule 7).
- Client sends a follow-up after the firm replied → new clock from that follow-up.
- Reply goes to the wrong matter → the original clock keeps running; staff can move the reply (logged) to stop it.
- The auto-ack fails to send (email bounce) → portal copy still exists; c51 bounce flag to lawyer.
- Firm changes 24/48 settings → applies to new messages; open clocks keep their original settings (logged config version).
- Holiday added after a message arrived → unfired checkpoints are recomputed (README).

## 5. Business rules

1. Internal reply target: **firm setting, default 24 business hours**.
2. Client promise: **firm setting, default 48 business hours**. Must be greater than the internal target (settings screen refuses otherwise).
3. Both count business hours using the firm's hours, time zone and holidays; a Friday-evening message is not flagged on Saturday.
4. One open reply clock per matter conversation; it starts at the earliest unanswered client message.
5. Only an outbound message sent by a human user to the client stops the clock (or a logged "no reply needed" close).
6. The auto-ack is sent for every inbound client message that starts a new clock, and states the promise the firm has configured, computed as a concrete time.
7. The AI never answers the client's legal question in the acknowledgement or elsewhere.
8. Urgent messages (safety flag, or a confirmed filing/court deadline within the window) alert the lawyer immediately at level 3 without waiting 24h.
9. All flags are internal; the client never sees that the firm missed its target.
10. Every clock start, flag, escalation, reply and close is logged in the audit trail.

## 6. Data model touchpoints

- **Reuse:** `scheduled_tasks` (`task_type` `reply_checkpoint`), `matters.assigned_user_id`, `firm_config_versions.config` (`reply.internal_target`, `reply.client_promise`, `reply.ack_wording_mode`), `intake_sessions.classifier_output` pattern for classifier results.
- **Proposed:** `messages` (with `is_auto_ack`, `deadline_related`, `urgent`), `tasks` (`kind = 'firm_reply_due'`, `source_type = 'message'`), `flags`.
- **Proposed dependency:** calendar entries (c91) for the "deadline inside window" check.

## 7. Notifications and visibility

| Moment | Client | Firm |
|---|---|---|
| Message received | Auto-ack with concrete promise (portal + c51 email) | Message in matter inbox |
| +24 BH, no reply | Nothing | Lawyer + admin flag, ops queue, email |
| +48 BH, no reply | Nothing | Admin + managing attorney escalation, email |
| Urgent | Nothing extra (c66 handles safety messaging) | Immediate L3 alert to lawyer, email |
| Reply sent | The reply | Flags cleared |

## 8. Dependencies

- **Needs first:** c45 (task/flag mechanism), c51 (email), c37 (ops queue), c6 (audit), c11 + c34 (client portal and login), the `messages` table, c35 real classifier (safety/deadline tags), c66 (emergency path), c91 (calendar entries).
- **Feeds:** c44 (stricter tier), c53 (firm responsiveness signal), c54 (client replies to updates start this clock), c48 (workload).

## 9. Compliance and review flags (licensed Texas attorney)

- Approve the auto-acknowledgement template(s) in English and Spanish (c36): no legal information, no promise the firm cannot keep, clear routing for emergencies.
- Confirm that stating a concrete reply time is appropriate and that the promise wording does not create an unintended undertaking.
- Confirm the TDRPC 1.03 framing is used as rationale only.
- Confirm how phone calls and voicemails must be logged to count as inbound messages.
- No trust money: no CPA review.

## 10. Acceptance criteria

1. **Given** firm hours Mon–Fri 08:00–17:00 (US/Central) and a client message at Friday 18:30, **when** no reply is sent, **then** no flag is raised over the weekend and the 24-business-hour flag fires at the correct business time computed from Monday 08:00.
2. **Given** an inbound client message, **when** it is received, **then** an auto-ack stating a concrete reply-by time is delivered to the portal and the client's safe email, and the reply task stays open.
3. **Given** an open reply task, **when** the AI or auto-ack sends anything, **then** the task remains open; **when** a staff user sends a reply, **then** the task completes and its flags clear.
4. **Given** 48 business hours pass with no human reply, **then** the firm admin and managing attorney are flagged and the client sees no flag.
5. **Given** a client sends three messages before any reply, **then** exactly one clock runs, starting at the first message.
6. **Given** a message whose matter has a confirmed hearing within the 48-business-hour window, **then** the lawyer gets an L3 alert immediately.
7. **Given** the classifier's safety flag is set, **then** the c66 path runs and the lawyer is alerted immediately.

## 11. Open questions for Clayton

1. "24 business hours": literal working hours (~3 business days for a 9-hour day) or one business day? (See README question 1.)
2. Promise wording: concrete date/time (recommended) or "within 48 hours"?
3. Does a staff holding reply stop the clock?
4. Who is the managing attorney for the 48h escalation: a named user in firm settings?
