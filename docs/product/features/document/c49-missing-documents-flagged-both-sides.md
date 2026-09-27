# c49 · Missing documents are flagged on the client side and on the lawyer/firm side

**Card:** `c49` Document engine · Missing documents are flagged on the client side and on the lawyer/firm side (Product, P1)

## 1. Summary

Every matter gets a required-documents checklist generated from firm templates for its practice area and matter type. Each item records who provides it and its status (missing, requested, received, accepted, not applicable). The client sees and is reminded about only the items they owe; the firm sees the whole checklist; the AI checks uploads for basic problems, but only the lawyer accepts a document.

## 2. Users and problem

- **Client:** does not know what to send, loses the list, and sends the wrong file.
- **Responsible lawyer / paralegal:** chases documents by email and cannot see at a glance what is still missing, especially items owed by third parties.
- **Firm admin:** has no view of missing-document backlog across matters.

## 3. Scope

**In scope**
- Firm-configured checklist templates per practice area and matter type (versioned).
- Per-matter checklist created at matter open (c68 hand-off), editable by the lawyer.
- Item provider (client, firm, third party) and status lifecycle.
- Client portal list with plain-language descriptions and upload links; client reminders.
- Firm checklist view, admin counts across matters.
- AI upload checks (readable, file type, pages present, looks like the requested type), advisory only.
- Timing through c46 (client), c45 (firm/third party), real-clock escalation for filing-linked items (c44).

**Out of scope**
- Document storage internals (c84) and secure exchange links (c89).
- Legal sufficiency review (always the lawyer's).
- Requesting records from third parties automatically (e.g. subpoenas, records requests).

## 4. Behaviour

1. **Create.** When c68 opens the matter, the checklist is created from the template matching practice area and matter type. Example Family Law divorce items (illustrative, needs attorney and pilot-firm input): marriage certificate, recent pay stubs, tax returns, bank and retirement statements, list of debts, existing court orders. Each item has a plain-language client description, provider, and optional due date.
2. **Lawyer edits.** The lawyer can add items, remove items, or mark not applicable with a required reason (logged).
3. **Request.** Items provided by the client move from `missing` to `requested` when the lawyer (or an auto-request setting) sends the request. A client task per item (or one grouped task) appears in the portal with an upload link and due date. Firm and third-party items become firm tasks for the assigned person.
4. **Upload.** The client uploads through the portal (c11/c89). The file is virus-scanned and encrypted at rest. If infected or unreadable, it is quarantined and never attached to the matter; the client sees "We couldn't accept this file, please upload it again" and the firm is flagged.
5. **AI checks.** On a clean upload, the AI checks: file opens, file type allowed, page count sensible (no blank pages, all pages of a multi-page statement present where detectable), looks like the requested document type. Result: `check_ok` or `check_issue` with a reason shown to the firm. Status becomes `received` either way.
6. **Lawyer review.** Only the lawyer (or a user the firm allows, see rule 6) marks `accepted`. If rejected, the item returns to `requested` with an optional plain-language message to the client written or approved by the lawyer.
7. **Overdue.** A client item past due goes overdue under c46 (shown in the portal and flagged to lawyer and admin). A firm or third-party item goes overdue under c45 (internal only). If the item is linked to a lawyer-confirmed filing deadline, it escalates on the real clock as in c44.
8. **Admin view.** Firm admin sees counts of missing, requested and overdue items per matter and per lawyer.

**Edge cases**
- Client uploads to the wrong item: the firm can move the file to the right item; logged.
- Client uploads several files for one item (e.g. 12 bank statements): allowed; the item is one unit for status.
- Client says they do not have the document: a "I don't have this" option sends a message to the lawyer (c43 clock); item stays `requested` until the lawyer decides.
- Matter type changes (e.g. uncontested to contested): the lawyer is offered a checklist update; existing statuses are kept.
- Template updated after matters exist: existing checklists are not changed silently; lawyers are offered the new items.
- DV matter: reminders only through safe contacts; no SMS without consent. Item descriptions never mention the other party by name.

## 5. Business rules

1. Statuses: `missing`, `requested`, `received`, `accepted`, `not_applicable`. `received` never implies `accepted`.
2. Only a lawyer marks `accepted` or `not_applicable`; `not_applicable` requires a logged reason.
3. The client sees only items where provider = client, and never sees firm notes, AI check reasons, internal or third-party items, or firm overdue flags.
4. AI checks are advisory and never change an item to `accepted` or rejected.
5. The AI never states whether a document is legally sufficient.
6. Who may accept: firm setting, default attorneys only; firm can add paralegals.
7. Auto-request on matter open: firm setting, default off (lawyer reviews the checklist first).
8. Client due date default: firm setting, default 5 business days after request. Reminder ladder follows c46/c42 defaults.
9. Allowed file types and size: firm setting, default PDF, JPG, PNG, HEIC, DOCX; 50 MB per file.
10. Every status change and upload is logged in c6.
11. Uploads are encrypted and virus-scanned before any person or the AI opens them (depends on the storage ADR addendum).

## 6. Data model touchpoints

- **Reuse:** `matters` (`practice_area`), `documents`/`document_versions` (c84), `parties`, `users`, `scheduled_tasks`, `firm_config_versions` or a versioned template table, audit trail (c6).
- **Proposed** `checklist_templates` (id, tenant_id, practice_area, matter_type, version, items jsonb, approved_by, approved_at). Could live inside firm config; a table is recommended because templates change independently.
- **Proposed** `checklist_items` (id, tenant_id, matter_id, template_item_key nullable, title, client_description, provider [client, firm, third_party], third_party_label, status, due_at, linked_deadline_id nullable, na_reason, accepted_by, accepted_at, ai_check_result jsonb).
- **Proposed** `checklist_item_documents` (item_id, document_id) for multi-file items.
- **Proposed** `tasks` (c45) for requests.
- RLS: client portal accounts can read only `checklist_items` where provider = client on their own matters; enforced in the access layer (c99), not only in the UI.

## 7. Notifications and visibility

- **Client:** portal list of their missing/requested items, upload links, overdue marking and reminders (c46); minimal c51 email: "There is an update on your matter" with a portal link, no document names that reveal case facts.
- **Lawyer:** full checklist, AI check results, overdue flags for client items (c46) and firm/third-party items (c45), c51 internal email.
- **Firm admin:** cross-matter counts, overdue on the ops queue (c37).

## 8. Dependencies

- **Needs:** c68 (creation trigger), c84 (store), c89 (upload), c11 + c34 (client portal), storage ADR addendum (encryption, virus scan), c45, c46, c44, c51, c6, c99, c85-style template management (shared approach), c103 (Family Law template content).
- **Feeds:** c41 (documents needed for a filing), c53 (health meter), c54 ("documents received" update), c86, c90 (closing).

## 9. Compliance and review flags

- **Attorney review:** Family Law checklist templates and client-facing descriptions (they must describe what to send, never what it means legally).
- **Attorney review:** the rule that the AI never judges legal sufficiency and that only a lawyer accepts.
- **Confidentiality (Rule 1.05):** financial records and minors' data; encryption, virus scanning, access logging; the malware-scanning vendor is a subprocessor needing a DPA if external.
- **Privacy:** uploads of third parties' data (e.g. the spouse's financial records) follow c2.

## 10. Acceptance criteria

1. Given a Family Law divorce matter is opened, when the checklist is created, then it contains the items from the firm's approved divorce template with providers set.
2. Given a checklist with client, firm and third-party items, when the client opens the portal, then only client items are listed, and a direct API request for other items is denied.
3. Given a client uploads a password-protected PDF, when the AI checks it, then the item is `received` with `check_issue` "file can't be opened" shown to the firm only.
4. Given an upload fails the virus scan, when processing finishes, then the file is quarantined, not attached, the client sees a neutral re-upload message and the firm is flagged.
5. Given a client item is 5 business days past request with no upload, when the window lapses, then it shows overdue in the portal and is flagged to the lawyer and admin, with a c51 email to the client's safe address.
6. Given a firm-owned item is overdue, when the flag fires, then it goes only to firm users.
7. Given a lawyer marks an item not applicable, when they save, then a reason is required and logged.
8. Given an item is linked to a confirmed filing deadline 48 real hours away and still missing, when the worker runs on a Saturday, then the lawyer is alerted immediately.

## 11. Open questions for Clayton

1. When the lawyer rejects an upload, should the client see a lawyer-written reason (proposed, optional) or only "please upload a new copy"?
2. Third-party items (court, bank, medical provider): always a firm task, or can the lawyer assign some to the client to chase?
3. Should paralegals be allowed to mark items accepted by default?
