# c46 — Client's overdue tasks are flagged to the client (client-side) and to the firm and lawyer

**Card:** c46 · Calendar & deadline engine · P1 · Product
**Status:** Draft spec.

## 1. Summary

Tasks assigned to the client (upload documents, complete a questionnaire, sign or approve something, pay a retainer) use the same task mechanism as c45, but when they go overdue they are shown on both sides: to the client in the portal with a plain-language description and a direct link, and to the lawyer and firm admin internally. The client only ever sees their own tasks.

## 2. Users and problem

- **Clients** lose track of what the firm needs from them.
- **Lawyers** can't move the matter without the client's input and need to know early.
- **Firm admin** needs a firm-wide view of stuck client work.

## 3. Scope

**In scope**
- Client-owned tasks' overdue behaviour: client-side display, reminders, firm-side flags, court-deadline safety net.
- Shared ladder and reminder rules with c42.
- A "I need help with this" action for the client.

**Out of scope**
- What the tasks are and their content: created by c41 (sign-off), c49 (missing documents), c50/c52 (payments), c94 (templates), or manually by staff.
- Unanswered messages (c42).
- Firm-owned tasks (c45).

## 4. Behaviour

1. A client task is created with: matter, client party, plain-language title and description (from an approved template), action link (upload / form / sign / pay), due time (creator sets; per-type firm default, e.g. uploads 5 business days), and optional link to a confirmed calendar entry.
2. The client sees it in the portal (c11) task list as "to do" with its due date.
3. Due-soon: reminder to the client at the firm's lead time (default 1 business day) via portal + c51 email.
4. Overdue: task shows as past due in the portal (neutral wording, e.g. "Past due — please upload your pay stubs") with the action link; reminder #1 sent; internal flag to responsible lawyer and firm admin (ops queue c37); logged.
5. Further reminders follow the c42 ladder settings; the final rung is a lawyer decision task.
6. **Court-deadline-linked task**: when overdue, or when the real-clock check shows the deadline will arrive before the next reminder, the lawyer is alerted immediately (L3).
7. The client can tap "I need help with this"; that creates an inbound message (starts c43/c44 clock) and pauses further client reminders on the task until a firm user replies.
8. The task completes when the action completes (upload received, form submitted, signature captured, payment confirmed by the source engine). Flags clear on both sides; logged. Staff can also complete, cancel or change the due date with a reason.

**Edge cases and failures**
- Client has not activated the portal (c34) → email reminder contains the activation link; lawyer sees "portal not activated".
- Upload received but rejected by the lawyer (c49 status not accepted) → task reopens with a new due date and reason, visible to the client in neutral terms.
- Payment tasks: c50/c52 own the payment-specific wording and amounts; c46 does not create a second, separate notice for the same event (one flag, displayed once).
- Task assigned to a party who is not a client on the matter → refused.
- Matter has two clients → each task belongs to one client; the other client does not see it.

## 5. Business rules

1. A client task is assigned to exactly one client party on the matter; never to an opposing or other party.
2. The client sees only their own tasks; firm tasks and internal flags (c45) are never in the client's view or API responses.
3. Client-facing wording is neutral and uses approved templates; no legal-consequence language unless the lawyer approved it for that task.
4. Reminder ladder, quiet hours, opt-outs and SMS consent follow c42 and c51.
5. Default due times per task type: **firm settings** (proposed defaults: upload 5 business days, questionnaire 5 business days, sign-off per c41, payment per c50/c52 schedule).
6. Court-deadline-linked client tasks trigger an immediate lawyer alert on the real clock.
7. No automatic legal step (e.g. withdrawal) ever results from an overdue client task.
8. Every creation, reminder, flag, help request and completion is logged.

## 6. Data model touchpoints

- **Reuse:** `scheduled_tasks`, `documents` (existing stub; c49 will extend it), `matters.assigned_user_id`, `firm_config_versions.config` (per-type due defaults).
- **Proposed:** `tasks` with `owner_type = 'client'`, `owner_party_id`, `visibility = 'client'`, `action_type`, `action_ref`; `flags` (client-visible flag plus an internal firm-side flag); `matter_parties.role` extended with a client role; `contact_preferences`.

## 7. Notifications and visibility

| Event | Client | Firm |
|---|---|---|
| Created | Task in portal (+ email notice per c51) | Task visible on matter |
| Due soon | Reminder | — |
| Overdue | Past-due in portal + reminder email | Lawyer + admin flag, ops queue, email |
| Deadline-linked | Reminder | L3 immediate lawyer alert |
| Help requested | Confirmation | Inbound message, c43 clock |

c51 classifies c46 as client-facing: the client gets email about their own task; the firm copy emails firm users only.

## 8. Dependencies

- **Needs first:** c45 (mechanism), c42 (ladder settings), c11 (portal), c34 (client login), c51 (email), c37, c6.
- **Fed by:** c41, c49, c50, c52, c94.
- **Feeds:** c53 (client engagement signal), c48 (not directly).

## 9. Compliance and review flags (licensed Texas attorney)

- Approve client task description templates and overdue wording (English/Spanish).
- Confirm the payment-task display does not duplicate or contradict c50/c52 notices (c50 carries its own attorney + CPA review; this card only displays).
- DV safety for reminders (c103).
- No trust money is moved or computed here: no CPA review for c46 itself.

## 10. Acceptance criteria

1. **Given** a client upload task due Monday, **when** Monday passes, **then** the portal shows it as past due with an upload link, the client gets a reminder, and the lawyer and admin get an internal flag.
2. **Given** a signed-in client, **when** they open the task list, **then** only their own tasks appear and no firm task or flag appears in the page or API response.
3. **Given** a client task linked to a confirmed hearing, **when** it goes overdue, **then** the lawyer gets an immediate L3 alert.
4. **Given** the client clicks "I need help", **then** an inbound message is created, the c43 clock starts, and reminders pause.
5. **Given** the client uploads the document, **then** the task completes and flags clear on both sides.
6. **Given** a staff user tries to assign a task to the opposing party, **then** it is refused.

## 11. Open questions for Clayton

1. Default due times per client task type: are the proposed defaults right?
2. Should the client portal use the word "overdue" or softer wording like "past due" / "still needed"?
3. For payment tasks, is the c50/c52 notice the only client notice (recommended), with c46 only showing the task?
