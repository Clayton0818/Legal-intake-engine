# c42 — Client non-response is logged, flagged to lawyer and firm admin, and triggers a client reminder

**Card:** c42 · Calendar & deadline engine · P1 · Product
**Status:** Draft spec.

## 1. Summary

Every message the firm or the AI sends to a client gets a response window. If the client does not reply in time, the non-response is logged, flagged to the responsible lawyer and firm admin, and the client gets a neutral reminder, following a firm-configured ladder that ends with the lawyer deciding what to do. The system never takes a legal step (such as a withdrawal or non-engagement letter) on its own.

## 2. Users and problem

- **Lawyers** send questions and requests that clients ignore; chasing is manual and easy to forget.
- **Firm admin** needs to see where clients have gone quiet across the firm.
- **Clients** need a polite, safe nudge, not a threat.

## 3. Scope

**In scope**
- All outbound client correspondence: portal messages, emails sent from the platform, AI-sent messages, sign-off requests from c41, SMS once approved.
- Response windows (firm default, per-message override), the reminder ladder, lawyer decision step, audit logging, contact preferences, quiet hours, opt-outs.
- Escalation from c41 when a pre-filing sign-off is missing near a deadline.

**Out of scope**
- Unfinished client tasks (uploads, questionnaires, payments): c46 (same ladder rules).
- Missing documents content (c49), payment reminders content (c50/c52).
- Any automatic legal step; withdrawal or non-engagement letters.
- SMS until the TCPA consent flow is reviewed.

## 4. Behaviour

1. A firm user or the AI sends an outbound message to the client. Unless the sender marks it "no reply needed", it gets the firm's default response window (**default 2 business days**), or the sender's override.
2. The system creates a client-owned task `client_reply_due` (c45 mechanism, visibility client for the reminder, with a firm-side internal copy) due at sent time + window, and a `scheduled_tasks` row.
3. The client replies on any channel on the same matter: all open `client_reply_due` tasks on that matter older than the reply complete (reason "client replied"), timers cancel, and the reply starts the firm's c43/c44 clock. A lawyer can reopen a completed task if the reply did not answer the question (reason logged).
4. Window lapses with no reply → **rung 1**:
   a. Log the non-response in the audit trail.
   b. Flag the responsible lawyer (matter view, task list) and the firm admin (ops queue c37). Internal.
   c. Send the client reminder #1 (neutral template) via portal + c51 email, respecting contact preferences and quiet hours.
5. **Rung 2** after the next interval (**default 2 business days**): reminder #2 to the client, flag level 2.
6. **Final rung:** create a `lawyer_decides_next_step` task for the lawyer (**due 1 business day**). Options the lawyer can pick: send a personal message, log a phone call, extend the window, mark "no reply needed", or close the loop with a note. No further automatic reminders go out.
7. Any rung is skipped if the lawyer paused the ladder for this message (reason logged).

**Linked to a deadline (c41 hand-off)**
8. If the message is linked to a confirmed deadline (e.g. c41 sign-off before a filing), lapse alerts the lawyer immediately at level 3, and a real-clock check alerts the lawyer if the deadline will arrive before the next rung.

**Edge cases and failures**
- Client opted out of email → reminder in portal only; lawyer sees "email off".
- Client has no reachable channel (no portal login, no safe email) → no reminder; lawyer flagged "client unreachable by platform".
- Quiet hours → client reminder deferred to end of quiet hours; the internal flag is not deferred.
- Out-of-office or auto-reply from the client's email (auto-submitted headers) → does not count as a reply.
- Matter closed or lawyer withdraws → all open timers cancel with logged reason.
- Reply lands on a different matter of the same client → does not clear this matter's task; the lawyer can link it manually.
- Worker restart → rungs idempotent per (message, rung).

## 5. Business rules

1. Default response window: **firm setting, default 2 business days**, per-message override (including "no reply needed").
2. Ladder: **firm setting, default [reminder at lapse, reminder after 2 business days, lawyer decides]**; max 3 automated client reminders per message.
3. Client reminders use firm-approved neutral templates and never mention legal consequences (e.g. dismissal, withdrawal) unless the lawyer approved that specific wording for that message; the approval is logged.
4. Contact preferences, opt-outs and quiet hours (c51) always apply to client reminders.
5. SMS reminders require documented TCPA-compliant consent on file; SMS is off until reviewed.
6. The system never sends a withdrawal, non-engagement or similar letter automatically.
7. Response windows count business hours; deadline-linked checks count real time.
8. The firm-side flag is internal; the client sees only the reminder.
9. Every lapse, reminder, flag, pause and lawyer decision is logged.

## 6. Data model touchpoints

- **Reuse:** `scheduled_tasks` (`client_reply_lapse`, `client_reply_rung`), `matters.assigned_user_id`, `firm_config_versions.config` (`client_reply.window`, `client_reply.ladder`, reminder template ids).
- **Proposed:** `messages.expects_reply`, `messages.reply_window_override`; `tasks` (`kind = 'client_reply_due'`, `owner_type = 'client'`); `flags`; `contact_preferences`; reminder templates with `approved_by_user_id` for consequence wording.

## 7. Notifications and visibility

| Rung | Client | Firm |
|---|---|---|
| Lapse | Reminder #1 (portal + email) | L1 flag to lawyer + admin (ops queue), email |
| Rung 2 | Reminder #2 | L2 flag, email |
| Final | Nothing automatic | Lawyer decision task |
| Deadline-linked lapse | Reminder | L3 immediate alert |

c51 classes c42 as client-facing: the client gets the reminder email; the firm-side flag emails only firm users.

## 8. Dependencies

- **Needs first:** c45, c51, c37, c6, c11 + c34 (portal and client login), `messages` table, contact preferences.
- **Fed by:** c41 (missed sign-off near a deadline), c54 (updates that expect replies), c40-style requests.
- **Feeds:** c53 (client engagement signal), c46 (shares ladder settings).

## 9. Compliance and review flags (licensed Texas attorney)

- Approve neutral reminder templates (English and Spanish) and the rule that consequence wording needs per-message lawyer approval.
- Confirm that reminders to existing clients raise no solicitation/barratry concern (c1 §4 flagged outbound contact generally), and whether the answer differs for prospective clients before engagement.
- TCPA: SMS consent capture and evidence (c1-style review before SMS ships).
- DV-safe contact handling for family-law clients (c103).
- Confirm the lawyer-decision step does not need prompts about withdrawal obligations (recommended: no automated legal guidance, just options).
- No trust money: no CPA review.

## 10. Acceptance criteria

1. **Given** an outbound message with a 2-business-day window, **when** no reply arrives, **then** at lapse the non-response is logged, lawyer and admin are flagged internally, and reminder #1 reaches the client portal and safe email.
2. **Given** the client replies before the window ends, **then** no reminder is sent and the firm's c43 clock starts.
3. **Given** quiet hours 20:00–08:00 and a lapse at 21:00, **then** the internal flag is immediate and the client reminder is sent at 08:00.
4. **Given** the ladder completes, **then** a lawyer decision task exists and no further automatic client reminders are sent.
5. **Given** a reminder template containing consequence wording without lawyer approval, **then** it cannot be sent.
6. **Given** a c41 sign-off request tied to a filing in 2 days lapses, **then** the lawyer gets an immediate L3 alert.
7. **Given** an auto-reply from the client's mailbox, **then** the task remains open.

## 11. Open questions for Clayton

1. Does every outbound message expect a reply by default, or only messages the sender marks as needing one? (Spec default: every message, with "no reply needed" option; c54 updates default to no reply.)
2. Confirm default window (2 business days) and ladder (2 reminders, then lawyer decides).
3. Does c42 apply to prospective clients before engagement, or only after c39?
4. SMS in v1, or email + portal only?
