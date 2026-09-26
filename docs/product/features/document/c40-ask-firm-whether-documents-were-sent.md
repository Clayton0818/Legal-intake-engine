# c40 · AI asks the firm/lawyer whether documents were sent to the client

**Card:** `c40` Document engine · AI asks the firm/lawyer whether documents were sent to the client (Product, P1)

## 1. Summary

After the engagement agreement is signed (c39), each onboarding and matter document that should reach the client gets a delivery status. Documents delivered through the platform (c4 signing, c89 portal sharing) are marked sent automatically. For anything sent another way (email, mail, hand delivery), the AI asks the responsible lawyer or staff member, records the answer, and keeps asking on a firm cadence until it is resolved.

## 2. Users and problem

- **Responsible lawyer / assistant:** sends welcome packets, copies of orders and signed agreements in many ways and loses track of what went out.
- **Firm admin:** cannot see which new clients never received their onboarding papers.
- **Client:** is affected if nothing arrives, but is never asked by this feature and never sees its flags.

## 3. Scope

**In scope**
- A delivery status per document per matter: `sent`, `not_yet`, `not_needed`, plus the internal starting state `unknown`.
- The onboarding document set per practice area and matter type (firm-configured), created when c39 completes.
- Automatic `sent` for platform deliveries.
- The staff-facing question, the answer, the re-ask cadence and escalation.
- Manual "track delivery" for any other document the lawyer adds later.

**Out of scope**
- Actually sending documents (c89, c4, the firm's email).
- Asking the client whether they received anything.
- Court service of documents (c86).

## 4. Behaviour

1. **Start.** When c39 completes, the system creates delivery-tracking rows for the matter's onboarding set (e.g. copy of signed agreement, welcome letter, portal instructions; the Family Law set needs firm and attorney input). Each row starts `unknown`, or `sent` if the document was delivered through c4/c89.
2. **Ask.** After a firm-set wait (default 1 business day, so staff have time to send), the AI creates one task for the responsible person (default the matter's `assigned_user_id`; firm can route to an assistant) listing every `unknown` document: "Has [document] gone to [client]? Sent / Not yet / Not needed".
3. **Answer.**
   - **Sent:** the person picks the method (email, mail, hand delivery, other) and date. Status `sent`.
   - **Not yet:** status `not_yet`; a re-ask is scheduled.
   - **Not needed:** a reason is required. If a non-attorney answered, a lawyer confirmation task is created (firm setting, see rule 4).
4. **Re-ask.** For `not_yet` rows, the AI asks again on the firm cadence (default every 2 business days). After the cap (default 3 asks) the task is overdue and follows c45: flag to the assignee, then after the grace period to the supervising lawyer and firm admin, and onto the ops queue (c37).
5. **Platform delivery later.** If a `not_yet` document is later shared through c89 or signed via c4, the row becomes `sent` automatically and pending asks are cancelled.
6. **Answering in bulk.** One click "all sent today by email" is allowed; each row is still recorded separately.

**Edge cases**
- Assigned lawyer changes (c48): open asks move to the new assignee with a logged note.
- Matter closed or client withdraws before resolution: open asks are cancelled with a logged reason.
- A person answers "sent" but the document never existed in the store: allowed (paper-only documents), recorded as method-only with no linked version.
- Staff answer "sent" by mistake: correction creates a new status entry with a reason; the history keeps both.
- DV matter: the question includes a reminder "sent only to the safe address?" and "sent" by email asks the person to confirm the address used matched the safe address on file.

## 5. Business rules

1. Only firm users are asked; the client is never asked and never sees these statuses or flags.
2. Platform deliveries (c4 completed envelope, c89 share opened or delivered) set `sent` automatically with method `platform`.
3. Every status change records who, when, method, date sent and reason where needed, and is logged in c6.
4. "Not needed" answered by a non-attorney needs attorney confirmation: firm setting, default on. "Sent" answered by staff stands without confirmation: firm setting, default off.
5. First ask delay: firm setting, default 1 business day after c39 completes.
6. Re-ask cadence: firm setting, default every 2 business days; cap default 3 asks, then c45 overdue.
7. All timers count firm business hours.
8. The asks are tasks in the shared task mechanism (c45), not a separate timer system; they run on `scheduled_tasks`.
9. The onboarding set is firm-configured per practice area and matter type, versioned in firm config.

## 6. Data model touchpoints

- **Reuse:** `matters`, `users`, `documents`/`document_versions` (c84), `scheduled_tasks`, `firm_config_versions` (onboarding sets, cadence), audit trail (c6).
- **Reuse from c4/c89:** envelope completion and share delivery events.
- **Proposed** `document_deliveries` (id, tenant_id, matter_id, document_id nullable, label, recipient_party_id, status [unknown, sent, not_yet, not_needed], method [platform, email, mail, hand, other], sent_on, reason, answered_by, confirmed_by, updated_at). Status history in c6, not overwritten silently.
- **Proposed** `tasks` table (scope memo §4, owned by c45) for the ask and confirmation tasks.

## 7. Notifications and visibility

- **Internal only.** The asking task appears on the responsible person's task list and the matter. Overdue flags follow c45 and send internal c51 emails (firm may use the daily digest for these non-urgent flags).
- **Firm admin:** matters with unresolved deliveries on the ops queue (c37).
- **Client:** sees nothing from this feature. Documents shared through the portal appear to the client through c89, not through c40.

## 8. Dependencies

- **Needs:** c39 (trigger), c4 and c89 (automatic sent), c45 (tasks, overdue), c37 (ops queue), c51 (email), c6, c84, c48 (assignee changes).
- **Feeds:** c53 (health meter: onboarding not sent), c90 (closing checklist can reuse delivery tracking for the closing letter and returned originals).

## 9. Compliance and review flags

- Staff-facing only: no UPL exposure. The AI asks and records; a person answers.
- **Attorney review (light):** the default Family Law onboarding set and whether any item there is something the firm is obliged to give the client (so that "not needed" should be blocked for it).
- **Confidentiality (Rule 1.05):** recording the email address used for delivery in DV matters; the audit trail must not expose the safe address to anyone without matter access.

## 10. Acceptance criteria

1. Given c39 completes and the welcome letter was shared via c89, when delivery rows are created, then the welcome letter is `sent` (method platform) and no question is asked about it.
2. Given a row is `unknown`, when 1 business day has passed, then one task lists every unknown document for the responsible person.
3. Given an assistant answers "Not needed" with a reason, when the firm setting requires confirmation, then a confirmation task goes to the responsible lawyer and the status shows "not needed (awaiting lawyer)".
4. Given a row stays `not_yet` after 3 asks, when the next ask would fire, then the task is overdue under c45 and appears on the ops queue.
5. Given a `not_yet` document is later shared through the portal, when the share is delivered, then the row becomes `sent` and pending asks are cancelled.
6. Given any client account, when it queries delivery rows or their flags, then access is denied by the access layer, not just hidden in the UI.
7. Given a status is corrected, when the audit trail is viewed, then both the original and the correction with reason are present.

## 11. Open questions for Clayton

1. When staff answer "sent" or "not needed", must the lawyer confirm? Proposed: "not needed" yes, "sent" no.
2. Re-ask cadence and cap: every 2 business days, 3 asks (proposed)?
3. Which documents make up the Family Law onboarding set for the pilot? (Needs input from a pilot firm.)
