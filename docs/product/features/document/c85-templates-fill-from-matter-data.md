# c85 · Templates that fill themselves from matter data

**Card:** `c85` Document engine · Templates that fill themselves from matter data (Product, P1)

## 1. Summary

A firm-managed library of letters, pleadings, forms and agreements with fields (client name, cause number, court, dates, fees) that fill automatically from the matter. Templates are versioned and must be approved by a firm lawyer before use. The output is always a draft a lawyer reviews; the AI never writes or chooses legal content.

## 2. Users and problem

- **Lawyers and paralegals:** retype the same names, cause numbers and fee terms into Word files, which causes errors.
- **Firm owner:** wants every document to start from approved wording, not an old client's file.
- **Other engines:** engagement agreements (c39), conflict waivers (c59), non-engagement letters (c62), refund letters (c82), closing letters (c90) and Family Law starter documents (c103) all need the same mechanism.

## 3. Scope

**In scope**
- Template library: create, upload (DOCX), categorize (letter, pleading, form, agreement), practice area and matter type tags, language (English, Spanish per c36).
- A defined field catalogue that maps field names to matter data.
- Deterministic conditional sections (e.g. show pay schedule block only if fee type is fixed fee).
- Versioning, lawyer approval, retirement.
- Generating a draft document version into the matter (c84) in DOCX and PDF.
- Missing-field handling.

**Out of scope**
- AI-written clauses or AI choice of legal wording.
- Court-specific form libraries maintained by the vendor (would need their own review; see open question 1).
- E-signature (c4) and sending (c89).

## 4. Behaviour

**Manage templates**
1. A firm user with template rights uploads a DOCX or edits in the built-in editor, inserting fields from the catalogue (e.g. `{{client.legal_name}}`, `{{matter.cause_number}}`, `{{court.name}}`, `{{fee.retainer_amount}}`, `{{today}}`).
2. On save, the system validates: every field exists in the catalogue, conditional blocks are well formed. Unknown fields block saving.
3. The template version is `draft` until a lawyer approves it. Approval records who and when. Only `approved` versions can be used to generate documents.
4. Editing an approved template creates a new draft version; the old approved version stays in use until the new one is approved.
5. Retiring a template stops new use; existing documents keep their link to the version they came from.

**Generate a document**
1. From a matter, a user picks a template (filtered by the matter's practice area and type), or another engine calls generation (c39, c59, c62, c82, c90).
2. Fields fill from the matter. Dates use the firm's time zone. Money uses the matter's fee data.
3. Missing values show as highlighted placeholders ("[MISSING: cause number]"). The draft can be saved but cannot be approved, sent or signed while placeholders remain, unless a lawyer explicitly clears one with a reason.
4. The output is saved as a new document version with status `draft`, source `template`, and links to the template version and a snapshot of the field values used.
5. The lawyer reviews and edits; edits are new versions. Downstream actions (send, sign, file) need an approved version.

**AI role (limited)**
- May flag inconsistencies for a person to check (e.g. the client's name spelled differently in intake and on an uploaded order).
- May suggest which approved template fits the requested document type from its tags.
- Does not write, rewrite or choose clauses.

**Edge cases**
- Field value changes after generation (e.g. cause number added later): existing drafts are not changed silently; the user can "refresh fields", which creates a new version and shows what changed.
- Multiple parties with the same role (two children): list fields render as repeating blocks.
- Protected data in DV matters (client's address): fields marked sensitive are not filled into documents going to other parties unless the lawyer confirms; c88 redaction applies before sharing.
- Spanish template missing for an English one: generation offers only languages with an approved version.

## 5. Business rules

1. Only `approved` template versions generate documents.
2. Only a user with the attorney role (or a firm-designated template approver, open question 2) approves a template version.
3. Every generated document is a `draft` until a lawyer approves it for its downstream use.
4. Placeholders block approval, sending and signing unless a lawyer clears them with a logged reason.
5. Conditional sections use only deterministic rules on matter data; no AI decides inclusion.
6. The field catalogue is maintained by the product; firms cannot define free-form fields that run code.
7. Generated documents record template id, template version and a snapshot of values used.
8. Template create, approve, retire and every generation are logged in c6.
9. Starter templates shipped by the product (if any) arrive as `draft` in the firm's library and must be approved by a firm lawyer before use.

## 6. Data model touchpoints

- **Reuse:** `matters` (`practice_area`, `assigned_user_id`), `parties`, `matter_parties`, `users`, `firms`, `documents`/`document_versions` (c84), `firm_config_versions` (firm details used in letterhead), audit trail (c6).
- **Missing today:** `matters` has no cause number, court or matter type columns. **Proposed** (data model extension): `matters.matter_type`, `matters.cause_number`, `matters.court_id` or a `matter_court_cases` table; fee values come from c52's proposed `fee_arrangements`.
- **Proposed** `document_templates` (id, tenant_id, name, category, practice_area, matter_type, language, status [active, retired]).
- **Proposed** `document_template_versions` (id, template_id, tenant_id, version_no, storage_key, sha256, status [draft, approved, superseded], approved_by, approved_at, created_by).
- **Proposed** `generated_document_sources` (document_version_id, template_version_id, field_values jsonb).

## 7. Notifications and visibility

- Internal only. Template approval requests go to approvers as firm tasks (c45 rules, default due 2 business days).
- Clients never see templates or drafts; they see a document only when a lawyer sends it (c89, c4, c41).

## 8. Dependencies

- **Needs:** c84 (store and versions), data model extension (matter type, cause number, court), c52 (fee fields), c99 (template rights), c6, c36 (Spanish versions).
- **Feeds:** c4, c39, c59, c62, c82, c90, c49 (checklist templates can share the approval/versioning approach), c103 (Family Law starter documents).

## 9. Compliance and review flags

- **Attorney review:** any starter templates the product ships, especially Family Law petitions, engagement agreements and letters (c103 says content needs Texas family-law attorney review). Also who owns and may licence them.
- **UPL (Rule 5.05):** the output is a lawyer's draft, never a client self-help document; confirm with the reviewer that this keeps the feature on the right side of the line.
- **Confidentiality (Rule 1.05):** field snapshots contain client data and follow the matter's retention (c2, c90).

## 10. Acceptance criteria

1. Given a template version in `draft`, when a user tries to generate from it, then it is not offered.
2. Given a template containing `{{matter.cause_number}}` and a matter without one, when a document is generated, then the placeholder "[MISSING: cause number]" appears and sending is blocked.
3. Given a lawyer clears a placeholder with a reason, when they approve the draft, then approval succeeds and the reason is in the audit trail.
4. Given a template contains an unknown field `{{client.favorite_color}}`, when saved, then saving fails with the field named.
5. Given version 2 of a template is approved, when a document generated earlier from version 1 is opened, then it still shows version 1 as its source.
6. Given a fixed-fee matter, when the engagement template is generated, then the pay schedule block is included and the retainer block is not.
7. Given a non-attorney without approver rights, when they try to approve a template, then the action is refused.

## 11. Open questions for Clayton

1. Ship starter Family Law templates (needs attorney review and an ownership/licence decision) or only an empty library the firm fills?
2. Template approval: any attorney, or only a firm-designated template approver?
3. Built-in editor in v1, or DOCX upload only (simpler)?
