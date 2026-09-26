# c87 · File all matter email, not just court email

**Card:** `c87` Document engine · File all matter email, not just court email (Product, P1)

## 1. Summary

Emails to and from clients, opposing counsel and others are filed to the right matter automatically when the match is certain (addresses, cause number, party names), suggested when it is not, or filed with one click from Outlook or Gmail. Attachments are saved to the matter's document store. It extends c64's mailbox connection with the same least-privilege and privacy rules.

## 2. Users and problem

- **Lawyers and staff:** matter correspondence lives in personal inboxes; the file is incomplete when someone is out or leaves.
- **Firm:** cannot show a complete record of communications for a matter (malpractice defense, grievance response, file transfer).
- **Client:** benefits indirectly: everyone at the firm sees the same history.

## 3. Scope

**In scope**
- Reuse c64's firm-authorized mailbox connections (Microsoft 365, Gmail).
- Inbound and outbound messages.
- Matching rules, confidence levels, auto-file vs suggest.
- Suggestion queue per user.
- One-click filing add-in for Outlook and Gmail.
- Attachments into c84 with virus scan and de-duplication.
- Thread continuity.
- Exclusions (personal mail, private senders, folders).

**Out of scope**
- Court email alerts (c64 keeps that job; a court email is also filed by c64).
- Sending email from the product (c51, c54).
- Reading or summarizing email content for legal meaning.

## 4. Behaviour

**Automatic filing**
1. The worker reads new message metadata from connected mailboxes (sender, recipients, subject, date, thread id).
2. Matching signals, in order: (a) a thread already filed to a matter; (b) an address belonging to a party or contact on exactly one open matter; (c) a cause number in subject or body that matches one matter; (d) party names matching one matter.
3. **Auto-file** only when: signal (a), or signal (b) with exactly one matching open matter, or signal (c) plus one other signal agreeing. The whole message and attachments are stored on the matter.
4. **Suggest** when signals point to more than one matter (e.g. opposing counsel on several cases), to a closed matter, or only name signals match. The suggestion goes to the mailbox owner's queue with the reason. Nothing is stored on any matter until a person confirms.
5. **No match:** the message is not stored. Only the minimum metadata needed for matching is kept transiently and discarded after the firm-set window (default 7 days).

**One-click filing**
1. From the Outlook or Gmail add-in, the user picks "File to matter", sees suggested matters, and confirms. The server fetches the message by id through the existing connection.
2. The user can file a whole thread and choose "file future replies automatically".

**Attachments**
- Saved as documents in the matter's email folder (c84), virus-scanned, de-duplicated by hash, linked to the message.

**Privilege and confidentiality**
- Emails between the firm and the client are suggested as privileged/confidential (c88); a person confirms the tag. Tagged items follow c88 sharing rules.

**Edge cases**
- Screened user (c60): an email in a screened user's mailbox that matches a matter they are screened from is not auto-filed; it goes to the firm admin's queue with no content preview.
- Email mentions two matters: the person may file it to both; each filing is logged.
- Wrongly filed: a user with matter access can move it; the move is logged.
- Personal email of a lawyer: private senders and excluded folders are never read beyond metadata needed to apply the exclusion.
- Connection revoked or expired: flagged to the mailbox owner and admin (c51); no messages missed silently: on reconnect, the worker back-fills from the last processed time.
- Look-alike or unverified sender claiming to be the court: handled by c64 phishing rules, not auto-filed as court mail.
- DV matter: messages from the opposing party are filed normally; nothing in this feature contacts anyone.

## 5. Business rules

1. Auto-file only on the certain-match rules in §4 step 3; everything else is a suggestion.
2. Unmatched messages are never stored; transient metadata is discarded after the firm-set window (default 7 days).
3. Mailbox access is read-only and least-privilege, with the same scopes and firm authorization as c64.
4. Closed matters are never auto-filed to; always suggested.
5. c60 screens are enforced before filing.
6. Each lawyer can exclude senders, domains and folders; the firm can add firm-wide exclusions.
7. Starting the reply clock: an auto-filed inbound client email starts the c43 reply clock (c44 if about a deadline): firm setting, default on (open question 1).
8. Attachments are virus-scanned before storage and never opened by the AI before the scan passes.
9. The AI does not interpret the legal meaning of an email; it only matches and suggests.
10. Every filing, suggestion decision, move and exclusion change is logged in c6.

## 6. Data model touchpoints

- **Reuse:** `matters`, `parties`, `matter_parties`, `users`, `documents`/`document_versions` (c84), `scheduled_tasks` (polling, back-fill), `outbox`, audit trail (c6).
- **Reuse from c64 (proposed there):** mailbox connection records.
- **Missing today:** `parties.email` exists; other contacts (opposing counsel, experts) need a **proposed** `contacts` table or the c56 party index extended with firm contacts and aliases.
- **Proposed** `matter_emails` (id, tenant_id, matter_id, mailbox_connection_id, provider_message_id, thread_id, direction, from, to, cc, subject, sent_at, body_storage_key, filed_by [auto, user_id], match_reason jsonb, privilege_tag).
- **Proposed** `email_filing_suggestions` (id, tenant_id, mailbox_connection_id, provider_message_id, candidate_matter_ids, reasons jsonb, status [open, filed, dismissed], expires_at). Holds metadata only.
- **Proposed** `email_exclusions` (tenant_id, user_id nullable, type [sender, domain, folder], value).

## 7. Notifications and visibility

- **Internal only.** Clients never see filed email lists in the portal by default (the lawyer may share specific items through c89).
- Suggestion queue per user; daily digest of open suggestions (c51 internal, optional).
- Connection failures flagged to owner and admin (c45 + c51).
- Screened-user items go only to the firm admin.

## 8. Dependencies

- **Needs:** c64 (mailbox connections and least-privilege rules), c84 (store), c88 (privilege tags), c60 (screens), c56 (party index and aliases), c34 (staff auth), c99 (permissions), c6, storage ADR addendum (virus scan).
- **Feeds:** c43/c44 (reply clocks), c53 (health meter: last contact), c90 (complete file at closing), c98 (migrated matters).

## 9. Compliance and review flags

- **Confidentiality and privilege (Rule 1.05):** reading every lawyer's mailbox is a larger privacy surface than c64's court-only scope. Attorney review of the scope, the "store only matched mail" rule and exclusions for personal mail.
- **Screens (Rules 1.09, 1.10, 1.18):** filing must never let a screened lawyer's mail reach, or reveal, a matter they are screened from.
- **Vendor terms:** Microsoft and Google API terms and any app-review or security assessment they require for mail access need checking before build (not researched here).
- **Privacy (c2):** retention of filed email follows the matter; unmatched metadata window default 7 days.
- **Employees' personal data:** attorney review of whether firm staff need notice that their mailboxes are processed.

## 10. Acceptance criteria

1. Given an inbound email from an address that belongs to the client on exactly one open matter, when the worker runs, then it is filed to that matter with its attachments.
2. Given an email from opposing counsel who appears on three open matters and no cause number, when the worker runs, then a suggestion listing the three matters is created and nothing is stored on any matter.
3. Given an email matching no matter, when 7 days pass, then no trace of it remains except the processing counter.
4. Given a reply in a thread already filed to matter M, when it arrives, then it is filed to M.
5. Given a screened lawyer's mailbox receives an email matching the screened matter, when the worker runs, then it is not filed and the admin queue shows an item without a content preview.
6. Given a user files a message with one click from Outlook, when they confirm, then the message and attachments appear on the matter and the action is logged.
7. Given an attachment fails the virus scan, when filing runs, then the attachment is quarantined and the message is filed with a note.
8. Given the mailbox connection expires, when the worker next runs, then the owner and admin are flagged, and after reconnect messages from the gap are processed.

## 11. Open questions for Clayton

1. Should an auto-filed inbound client email start the firm's reply clock (c43/c44)? Proposed yes, firm setting default on.
2. Include c87 in the pilot, given it widens mailbox access beyond court mail and may need Google/Microsoft app review?
3. Should clients be able to see filed email history in the portal, or only updates the lawyer chooses to share (proposed)?
