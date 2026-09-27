# Document engine: feature specs

**Status:** Product specs, docs only. Nothing here is built. Compliance-sensitive parts are research plus a recommended approach and are flagged for review by a licensed Texas attorney (and a CPA wherever trust money is touched) before build.
**Date:** 2026-09-26
**Author:** Claude (workflow run requested by Clayton: treat every board tile labelled "Product")
**Pilot practice area:** Family Law, Texas (c103).

These specs cover the Document engine cards in the case-management track. They build on the scope memo (`docs/product/case-management-expansion-scope.md`), the product scope (`docs/product/scope-and-problem-statement.md`, c17), the existing schema (`migrations/0000_material_thanos.sql`, `src/db/schema.ts`) and the retention policy draft (`docs/compliance/data-privacy-retention-policy.md`, c2). No earlier spec existed on `main` for any of these cards; c39's hand-off rules were aligned with the c68 spec on the open `work/product-specs-intake` branch.

## Cards

| Card | Title | Priority | One-line summary | Depends on |
|---|---|---|---|---|
| [c4](c4-e-signature-and-engagement-letter-generation.md) | E-signature & engagement letter generation | P1 | The build: an e-signature capability (envelopes, signers, signing order, tamper-evident signed PDF) plus engagement-letter drafting from c85 templates. | c85, c84, storage ADR addendum, c34, c51, c6, e-signature vendor decision + DPA |
| [c39](c39-client-signs-engagement-agreement.md) | Client signs engagement agreement | P1 | The workflow step: draft from matter + fee arrangement, lawyer approves, client signs, lawyer countersigns, stored on the matter; meets the c68 "agreement signed" gate. | c4, c85, c52, c59, c68, c10, c46, c51 |
| [c40](c40-ask-firm-whether-documents-were-sent.md) | AI asks the firm/lawyer whether documents were sent to the client | P1 | After signing, the AI asks the responsible lawyer/staff whether each onboarding document went out by a route outside the platform, records sent / not yet / not needed, and re-asks until resolved. | c39, c4, c45, c37, c51, c6, tasks table |
| [c41](c41-client-review-and-sign-off-before-filing.md) | AI asks the client to review and sign off documents before final filing | P1 | Lawyer approves the final draft, client approves that exact version or comments, lawyer files. Any edit restarts sign-off; deadline-near silence alerts the lawyer on the real clock. | c84, c4, c46, c44, c11, c54, c86, c6 |
| [c49](c49-missing-documents-flagged-both-sides.md) | Missing documents are flagged on the client side and on the lawyer/firm side | P1 | A required-documents checklist per matter, with who provides each item and status; the client sees only their own missing items, the firm sees everything. | c85-style templates, c84, c89, c11, c45, c46, c44, c51, c6, storage ADR addendum |
| [c85](c85-templates-fill-from-matter-data.md) | Templates that fill themselves from matter data | P1 | Firm-managed, lawyer-approved, versioned templates filled from matter fields; output is always a draft a lawyer reviews. | c84, c19 data model extension, c99 |
| [c87](c87-file-all-matter-email.md) | File all matter email, not just court email | P1 | Emails to and from clients, opposing counsel and others filed to the right matter automatically when the match is certain, suggested when not, or with one click from Outlook/Gmail. | c64, c84, c88, c60, c56, c34 |
| [c90](c90-closing-a-file.md) | Closing a file: final letter, return of papers, retention clock | P2 | A closing checklist (final invoice, trust at zero, closing letter, originals returned), then a retention clock after which a lawyer approves any destruction. | c95, c82, c79, c76, c85, c84, c2, c56, c6 |

Suggested build order inside this group: c85 (templates) and c84 (store, not in this group) first; then c4 (e-signature) and c49 (checklists); then c39, c40, c41; then c87; c90 last (P2, and depends on billing/trust closing rules).

## Shared conventions used by every spec in this folder

- **Timers.** Response and overdue timers count firm business hours (firm hours, time zone, holidays). Deadline safety nets (anything tied to a lawyer-confirmed court date or filing deadline) run on the real clock. All timers are rows in `scheduled_tasks` run by the ADR-0001 D6 worker.
- **Tasks and flags.** Every "someone must do X by Y" is a task in the proposed `tasks` table from the scope memo §4. Firm-side overdue flags follow c45 (internal only). Client-side overdue flags follow c46. Every flag also sends a minimal-content email to the affected party through c51, to the client's DV-safe address where a client is the recipient.
- **Audit.** Every status change is written to the audit trail (c6). Note for the data-model extension: today's append-only audit table, `intake_events`, requires a non-null `intake_session_id`, so matter-level events after intake (or on matters imported via c98 without an intake session) need either a proposed matter-level append-only table (working name `matter_events`, same INSERT/SELECT-only grants) or a relaxed column. The specs below say "logged in c6" and leave that choice to the data-model card.
- **Documents.** The existing `documents` table is a stub (`document_type`, `storage_key`, `sensitivity_tier`, `uploaded_by_user_id`). The specs assume c84 extends it and adds a proposed `document_versions` table (document_id, version_no, storage_key, sha256, source, created_by, created_at). Every document produced here is a version in that store.
- **The AI's role.** The AI drafts, delivers, asks, records and checks formats. It never gives legal advice, never decides a legal deadline, never judges legal sufficiency, never clears a conflict. A lawyer approves anything with legal content.

## Combined open questions for Clayton

Numbered by card so answers can be traced back.

**c4 E-signature**
1. Buy (integrate a vendor such as DocuSign, Dropbox Sign or Adobe Acrobat Sign) or build a native click-to-sign? The spec recommends buy for v1.
2. Trigger wording: the card says "once a matter is marked Retained", but c39/c68 make the signed agreement a condition of becoming retained. The spec reads the trigger as "once the lawyer records the decision to take the matter". Confirm.
3. Signer identity check level: email link only, or email link plus a one-time code to the client's safe phone (recommended default)?

**c39 Engagement agreement**
4. c39 says "on signature: matter stage becomes retained and the intake session closes"; c68 says retained happens only when a lawyer clicks Open with every gate met (including first payment). The spec follows c68: signature meets the agreement gate, retained comes from c68. Confirm.
5. Signing order: client first then lawyer countersigns (recommended), or lawyer signs first?
6. How long an unsigned agreement stays valid before it must be re-issued (proposed default 10 business days)?

**c40 Documents sent**
7. When staff (not a lawyer) answers "sent" or "not needed", does the responsible lawyer have to confirm it? Proposed default: "sent" by staff stands; "not needed" needs a lawyer.
8. Re-ask cadence and cap: proposed every 2 business days, up to 3 asks, then an overdue task.

**c41 Client sign-off**
9. May a lawyer file without client sign-off (client unreachable, emergency hearing) with a logged reason? The spec proposes yes, with a reason and a notice to the supervising lawyer.
10. How close to a filing deadline counts as "close" for the alert? Proposed 72 real-clock hours, firm-configurable.
11. Is a recorded click approval enough, or should every sign-off be an e-signature? Proposed: e-signature for anything the client signs as a party; click approval for review-only sign-off.

**c49 Missing documents**
12. Should the client see a document the lawyer rejected with the lawyer's reason, or only a neutral "please upload a new copy"? Proposed: lawyer-written plain reason, optional.
13. Who chases third-party items (court, bank, medical provider): always a firm task, or can the client be asked to chase some?

**c85 Templates**
14. Will the product ship starter Family Law templates (needs Texas family-law attorney review and a licence/ownership decision), or only an empty library the firm fills?
15. Who may approve a template version: any attorney, or only a firm-designated "template approver"?

**c87 Matter email**
16. Should an auto-filed inbound client email start the firm's reply clock (c43/c44)? Proposed: yes, firm setting default on.
17. Does c87 ship in the pilot, given it widens mailbox access from court-only (c64) to all matter mail and may add Google/Microsoft app-review work?

**c90 Closing a file**
18. Default retention period: ship no default (firm must choose at setup, recommended) or a suggested value?
19. Should files with a minor child's orders (custody, support) get a longer suggested retention in the Family Law pack?
20. Physical originals: does the product only track them, or also generate a signed receipt for returned originals?

## Needs attorney review (group summary)

- Engagement agreement template content, fee terms, AI-disclosure language (c10 §4.6) and whether e-signature is acceptable for every document type used (c4, c39, c41).
- Pre-filing client sign-off: whether a click approval or e-signature is enough for documents the client must verify or swear to (c41).
- Checklist templates for Family Law and the rule that the AI never judges legal sufficiency (c49).
- Starter templates and the "draft only" rule (c85).
- Mailbox access scope, privilege tagging and screens for all-matter email (c87).
- Retention periods, destruction approval and handling of client originals and client file requests (c90; Texas Ethics Opinion 627; Rule 1.16(d)).

## Needs CPA review

- c39: the retainer request that goes to trust (IOLTA) at engagement, gated on c75.
- c90: the "trust balance at zero" closing condition and keeping trust records apart from the destroyable client file (five years after representation ends under Texas Rules of Disciplinary Procedure 17.10, as summarized in the scope memo §3).
