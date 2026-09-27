# c41 · AI asks the client to review and sign off documents before final filing

**Card:** `c41` Document engine · AI asks the client to review and sign off documents before final filing (Product, P1)

## 1. Summary

Before the firm files a document, the client reviews the attorney-approved final version and either approves it or sends comments. The order is fixed: lawyer approves, client reviews, lawyer files. Approval is tied to that exact version; any edit makes a new version and restarts sign-off. If the client has not responded and a filing deadline is close, the lawyer is alerted on the real clock.

## 2. Users and problem

- **Client:** should see and agree to what is filed in their name (e.g. a petition, an inventory, a proposed parenting plan) without printing or visiting the office.
- **Responsible lawyer:** needs proof the client saw and approved the final wording and a warning when silence threatens a deadline.
- **Firm:** filing something the client did not see, or a version other than the one the client approved, creates disputes and grievance risk.

## 3. Scope

**In scope**
- Marking a document "client sign-off required" (firm defaults by document type; lawyer can change per document).
- Sending the attorney-approved version to the client through the portal.
- Capturing approval (e-signature via c4, or recorded approval) or comments.
- Versioning and restart on edit.
- Client reminders (c46) and deadline alert to the lawyer (c44-style real clock).
- A "ready to file" state consumed by c86.

**Out of scope**
- Court e-filing and service (c86).
- Calculating any deadline (c92, lawyer-confirmed).
- Explaining the document to the client.

## 4. Behaviour

1. **Lawyer approves final draft.** On a document with sign-off required, only an `attorney` can mark a version "Approved for client review". The version's hash is recorded.
2. **Send to client.** The system creates a client task "Please review and approve [document name]" in the portal (c11) with a minimal c51 email to the safe address. The document itself is only in the portal (never an email attachment). Privileged or sealed tags (c88) do not block sending to the client but redactions made for other audiences do not apply here unless the lawyer chooses.
3. **Client reviews.** The client can:
   - **Approve:** e-signature through c4 (purpose `pre_filing`) when the client signs as a party, or a recorded approval ("I have reviewed version 3 and approve it for filing") after an identity re-check, per the document type setting. Stored with version hash and time.
   - **Send comments:** free text and optional marked-up pages go to the lawyer as a client message (c43 reply clock; c44 24h clock because it concerns a filing).
   - **Ask a question:** the AI does not answer legal questions ("should I sign", "what does this mean", "is this fair"). It says the lawyer will reply and routes it to the lawyer. It may answer purely practical ones (how to open the file, how to approve).
4. **Lawyer handles comments.** Any edit saves a new version. The old approval request is withdrawn (client sees "replaced by a newer version") and sign-off restarts from step 1.
5. **Approved.** Status becomes `client_approved`, then `ready_to_file` for that version. c86 may only file the version whose hash matches the approved one.
6. **Reminders.** The client task follows c46: firm response window in business hours, neutral reminders, overdue shown to the client in the portal and flagged to the lawyer and firm admin.
7. **Deadline alert.** If the document is linked to a lawyer-confirmed filing deadline (c91/c92) and sign-off is still outstanding when the deadline is within the alert window (default 72 real-clock hours), the lawyer and supervising lawyer are alerted immediately, in-app and by email, on the real clock (same safety net as c44/c45 severity rule). The client gets no message about legal consequences unless the lawyer approved that wording.
8. **Filing without sign-off (proposed, open question 1).** The lawyer can mark "file without client sign-off" with a required reason (e.g. client unreachable before an emergency hearing). The supervising lawyer is notified and the override is logged.

**Edge cases**
- Client approves, then the lawyer spots a typo: any change, however small, is a new version and needs a new approval.
- Two clients (joint matter): each must approve; `client_approved` only when all have.
- Client approves an old version after a new one was sent: refused, "a newer version is waiting".
- Client revokes approval before filing: allowed until filed; status returns to `awaiting_client`, lawyer flagged.
- Client has no portal access (no login yet): cannot send; the lawyer is prompted to send the portal invite (c11) first.
- DV matter: reminders only to safe contacts; no SMS without recorded consent.

## 5. Business rules

1. Order is enforced: `draft` then `attorney_approved` then `awaiting_client` then `client_approved` then `ready_to_file`. No skipping, except the logged lawyer override in rule 9.
2. An approval is valid only for the version hash it was given on.
3. Any edit to the content creates a new version and cancels outstanding approvals.
4. Which document types require sign-off: firm setting per type, default on for documents the firm files on the client's behalf in the Family Law pack; lawyer can switch it off per document with a reason.
5. Approval method per document type: firm setting, default e-signature where the client signs as a party, recorded approval otherwise.
6. Client response window: firm setting, default 3 business days, then c46 overdue.
7. Deadline alert window: firm setting, default 72 hours on the real clock before the lawyer-confirmed filing deadline.
8. The AI never explains legal meaning, recommends signing, or predicts outcomes; such questions go to the lawyer.
9. Filing without sign-off requires an `attorney`, a reason, and notice to the supervising lawyer (proposed; firm setting to disable overrides entirely).
10. Sign-off, version, hash, method and timestamps are logged in c6.

## 6. Data model touchpoints

- **Reuse:** `documents`/`document_versions` (c84) with hash, `matters`, `parties`, `scheduled_tasks`, `outbox`, audit trail (c6).
- **Reuse from c4:** `signature_envelopes` (purpose `pre_filing`).
- **Proposed** `document_signoffs` (id, tenant_id, matter_id, document_id, document_version_id, version_sha256, status [attorney_approved, awaiting_client, client_approved, client_commented, withdrawn, overridden], attorney_approved_by, attorney_approved_at, client_party_id, method [e_signature, recorded_approval], envelope_id, responded_at, override_reason, override_by).
- **Proposed** link from the sign-off to a deadline (calendar table from the scope memo §4, owned by c91).
- **Proposed** `tasks` (c45) for client and lawyer tasks.

## 7. Notifications and visibility

- **Client:** portal task and document, c51 minimal email, reminders and overdue status (c46). Sees only their own sign-off tasks.
- **Lawyer:** comments and questions as client messages; sign-off status; deadline alert (urgent, emails immediately, c51); override notices.
- **Firm admin:** client-overdue sign-offs on the ops queue (c37).
- Client never sees: internal notes, firm overdue flags, the override reason, deadline alert text.

## 8. Dependencies

- **Needs:** c84 (versions), c4 (e-signature), c11 + c34 (client portal login), c46 (client tasks), c44/c45 (deadline safety net), c91/c92 (lawyer-confirmed filing deadline), c43 (reply clock for comments), c51, c54, c88, c6.
- **Feeds:** c86 (only files a `ready_to_file` version), c42 (non-response on the request), c53 (health meter).

## 9. Compliance and review flags

- **UPL (Rule 5.05) and client-facing AI:** attorney review of every client-facing message template in this flow and of the rule that the AI routes all meaning/advice questions to the lawyer.
- **Attorney review:** whether a recorded click approval or an e-signature is sufficient for documents the client must verify, swear to or sign as a party in Texas family courts, and which of those need a separate verification or notarization step outside this feature. Not researched here; left as a review item.
- **Attorney review:** the filing-without-sign-off override and whether it should exist.
- **Confidentiality (Rule 1.05):** documents only in the portal, never as email attachments; safe address in DV matters.

## 10. Acceptance criteria

1. Given a draft that no attorney has approved, when staff try to send it for client review, then sending is refused.
2. Given version 3 was sent and the client approves it, when the lawyer saves version 4, then the approval is cancelled, the client sees "replaced by a newer version" and a new request is needed.
3. Given the client approved version 3, when c86 tries to file version 4, then filing is blocked.
4. Given a sign-off linked to a confirmed filing deadline 60 real hours away and no client response, when the worker runs, then the lawyer and supervising lawyer get an immediate alert in-app and by email, including on a weekend.
5. Given the client writes "Should I agree to this custody schedule?", when the assistant replies, then it gives no opinion, says the lawyer will reply, and a client message with the c44 clock is created.
6. Given the client does not respond within 3 business days, when the window lapses, then the task shows overdue in the client portal and is flagged to the lawyer and firm admin.
7. Given the lawyer files without sign-off, when they confirm, then a reason is required, the supervising lawyer is notified and the override is in the audit trail.
8. Given a joint matter with two clients, when only one approves, then the status remains `awaiting_client`.

## 11. Open questions for Clayton

1. Allow a logged lawyer override to file without client sign-off (proposed), or never?
2. Deadline alert window: 72 real-clock hours (proposed)?
3. Recorded click approval for review-only sign-off and e-signature where the client signs as a party (proposed), or e-signature always?
