# c4 · E-signature & engagement letter generation

**Card:** `c4` E-signature & engagement letter generation (Product, P1, Document engine)
**Requirement (board note):** Auto-draft and route engagement letters once a matter is marked Retained, with e-signature built in.
**Relationship to c39:** c4 is the build (the e-signature capability and the engagement-letter drafting); c39 is the workflow step that uses it. Other cards reuse the same e-signature capability: conflict waivers (c59), pre-filing sign-off (c41), changed fee arrangements (c52).

## 1. Summary

Two reusable pieces. First, an engagement-letter drafter that fills a firm-approved template (c85) from the matter and its fee arrangement (c52) and hands the draft to the lawyer. Second, a general e-signature capability: send a specific document version to named signers in a set order, verify who they are, collect signatures, and store a tamper-evident signed copy with a completion record on the matter.

## 2. Users and problem

- **Responsible lawyer:** today writes each engagement letter by hand from a Word file and chases signatures by email; mistakes in fees or names slip in.
- **Client:** needs to sign from a phone without printing or scanning, at an address that is safe for them (Family Law, DV risk).
- **Firm admin:** needs proof of what was signed, by whom and when, if a fee dispute or grievance comes up.
- **Other engines:** waivers, fee changes and pre-filing approvals all need the same signing mechanism; building it once avoids three different half-solutions.

## 3. Scope

**In scope**
- Engagement-letter draft generation from c85 templates and matter data.
- A signing "envelope": one document version, one or more signers, signing order, expiry, reminders, cancel/void.
- Signer identity check before signing.
- Signed PDF plus completion certificate stored as a new document version (c84), with a content hash.
- Status events (sent, viewed, signed, declined, expired, voided) feeding c6 and the waiting workflow.
- Vendor integration if "buy" is chosen (recommended), behind an internal interface so the vendor can be replaced.

**Out of scope**
- The engagement workflow itself, gates and matter-stage change (c39, c68).
- Notarization or remote online notarization.
- Court e-filing (c86).
- Payment collection (c80).

## 4. Behaviour

**Draft an engagement letter**
1. Trigger: the lawyer records the decision to take the matter (consult outcome "hire" on a prospective matter; see open question 2 on the card's "once Retained" wording). Conflict status must be cleared or decided under c59; otherwise the Draft button is disabled with the reason "Conflict decision pending".
2. The system picks the firm's approved engagement template for the matter's practice area and matter type (c85) and the fee arrangement set by the lawyer (c52: fixed fee with pay schedule, or retainer with the $4,500 floor from c50 or the per-matter amount).
3. Fields fill from the matter (client legal name, matter description, fee terms, responsible lawyer). Missing fields are highlighted and block sending.
4. The draft opens for the lawyer to edit. Edits create a new draft version.
5. The lawyer clicks Approve for sending. Only an `attorney` can approve.

**Send for signature (generic envelope, used by c39, c41, c59, c52)**
1. The sender picks the approved document version and signers. Signer defaults come from the calling workflow (for engagement: client, then responsible lawyer).
2. The envelope is locked to that version's hash. If the document changes, the envelope must be voided and a new one sent.
3. Client signers are reached only through the portal (c11) and the client's DV-safe email (c51). The email holds no document content, only "a document from [firm] is ready for you to review" and a portal link.
4. Identity check before the document is shown: portal login (c34) or one-time link plus a one-time code to the client's safe phone or email (firm setting).
5. The signer reviews, signs, or declines with an optional reason. A decline goes to the sender as a firm task.
6. When all signers finish, the system produces the signed PDF and completion certificate (signers, times, IP/device summary, document hash), stores them as a new version, and emits `envelope_completed`.
7. Reminders to an unsigned client follow the client-task rules (c46): business hours, firm cadence, neutral wording.
8. Expiry: an unsigned envelope expires after the firm-set period; the sender is told and can re-send.

**Edge cases and failures**
- Signer email bounces: flagged to the sender (c51 bounce rule); envelope stays open.
- Vendor outage: sending queues through `outbox` and retries; after 3 failures the sender gets an internal flag and can send later. Nothing is lost.
- Client asks the AI what a clause means: the AI says a lawyer will answer and routes the question to the responsible lawyer as a client message (c43 reply clock). The AI never explains the agreement.
- Client signs on a shared device: out of product control; the portal shows a DV-safety tip on logout (c103 settings).
- Signed document later found wrong: never edited. Lawyer voids it with a reason and a new envelope is sent; both remain in history.
- Two lawyers countersign at once: first completion wins; the second sees "already signed".

## 5. Business rules

1. Only an approved document version can be put in an envelope; the envelope is bound to that version's SHA-256 hash.
2. A completed envelope's signed PDF is never overwritten or deleted by application code; corrections are new envelopes.
3. Engagement letters can only be drafted when the conflict status is `clear` or has a c59 decision allowing the matter to proceed, and all required waivers are signed.
4. Only an `attorney` role approves an engagement letter for sending and countersigns for the firm.
5. Client-facing emails about signing contain no document content, no fee amounts and no case facts (c51).
6. Envelope expiry: firm setting, default 10 business days.
7. Reminder cadence: firm setting, default after 2 and 5 business days, then the task goes overdue under c46.
8. Identity check level: firm setting, default portal login or one-time code to the safe phone.
9. Every envelope event (created, sent, viewed, signed, declined, expired, voided, completed) is logged in c6 with actor and time.
10. The e-signature vendor, if used, is a subprocessor: on the subprocessor list with a signed DPA before any real client data flows (same gate as c51).

## 6. Data model touchpoints

- **Reuse:** `matters`, `parties` (signer identity), `users` (firm signers), `documents` plus c84's proposed `document_versions`, `outbox` (vendor calls), `scheduled_tasks` (expiry and reminders), `firm_config_versions` (defaults), audit trail (c6).
- **Proposed** `signature_envelopes` (id, tenant_id, matter_id, document_version_id, document_sha256, purpose [engagement, waiver, pre_filing, fee_change, other], status [draft, sent, completed, declined, expired, voided], vendor, vendor_envelope_id, expires_at, created_by, created_at, completed_at, void_reason).
- **Proposed** `signature_signers` (envelope_id, tenant_id, order_no, signer_type [client, firm_user, other], party_id or user_id, delivery_address_ref, identity_method, status, signed_at, declined_reason).
- Signed output: a new `document_versions` row with source `signature`, plus the completion certificate as a linked document.
- All new tables are tenant-scoped with `tenant_id` and the standard RLS policy, accessed through `withTenant()`.

## 7. Notifications and visibility

- **Client:** portal task "Review and sign" (c46 client task) and a minimal email to the safe address (c51). Sees only envelopes where they are a signer. Never sees internal notes, decline reasons of other signers, or firm flags.
- **Lawyer/sender:** envelope status on the matter; internal flags for decline, bounce, vendor failure, expiry (c45/c51 internal email).
- **Firm admin:** vendor failure flags; overdue unsigned envelopes on the ops queue (c37).

## 8. Dependencies

- **Needs:** c85 (templates), c84 and the storage ADR addendum (where signed files live), c52 (fee arrangement to fill), c59 (conflict gate), c34 (real client and staff login), c51 (email), c46/c45 (reminders and overdue), c6, e-signature vendor decision and DPA.
- **Feeds:** c39 (engagement), c41 (client sign-off), c59 (waivers), c52 (changed fee arrangement), c40 (documents sent through the platform are marked sent automatically), c90 (closing letters can reuse delivery).

## 9. Compliance and review flags

- **Electronic signatures in Texas (research, attorney to confirm):** Texas's Uniform Electronic Transactions Act says a signature may not be denied legal effect solely because it is electronic, and where a law requires a signature an electronic signature satisfies it (Tex. Bus. & Com. Code §322.007). The Act applies only where the parties have agreed to transact electronically, judged from context and conduct (§322.005(b)). Recommended: the client ticks an explicit "I agree to sign electronically" consent before the first envelope, and can ask for a paper copy instead. Attorney to confirm this is enough and list any document types that must not be e-signed.
- **Engagement letter content:** fee terms, scope, AI disclosure (c10 §4.6) and termination terms are legal content; the template needs Texas attorney review (c85). Contingent fees must be in writing (Rule 1.04(d)); Family Law pilot matters are usually retainer or fixed fee, but the template set must support a written agreement for every fee type.
- **Confidentiality (Rule 1.05):** vendor access to agreements and client identity; DPA and subprocessor listing required.
- **Retainer and advance fees:** the fee terms describe money that belongs in trust until earned (State Bar of Texas trust guide; *Cluck v. Comm'n for Lawyer Discipline*, 214 S.W.3d 736; Opinion 611). Attorney and CPA review of the template's fee wording, via c75.

## 10. Acceptance criteria

1. Given a prospective matter with a conflict result `possible` and no c59 decision, when the lawyer opens the matter, then "Draft engagement letter" is disabled with the reason shown.
2. Given an approved engagement draft with a missing fee field, when the lawyer tries to send it, then sending is blocked and the missing field is highlighted.
3. Given an envelope sent for version 2 of a document, when someone saves version 3, then the envelope cannot complete against version 3 and the sender is told to void and re-send.
4. Given a client signer, when the envelope is sent, then the client email contains no fee amounts or document text and goes only to the client's safe address.
5. Given both signers have signed, when the envelope completes, then a signed PDF and completion certificate with the document hash are stored as a new version and `envelope_completed` is in the audit trail.
6. Given an unsigned envelope, when the firm-set expiry passes in business hours, then it is marked expired and the sender gets an internal flag and a c51 email.
7. Given the vendor API fails three times, when the sender views the envelope, then it shows "Not sent, retry" and nothing was sent twice after retry.
8. Given a client asks the assistant "should I sign this?", when the assistant answers, then it says the lawyer will answer and a client message is created for the lawyer; no advice is given.

## 11. Open questions for Clayton

1. Buy a vendor (recommended for v1: faster, proven audit trail, but adds a subprocessor and per-envelope cost) or build native click-to-sign?
2. The card says "once a matter is marked Retained"; c39/c68 make the signed agreement a condition of retained. Confirm the trigger is "lawyer records the decision to take the matter".
3. Default identity check: portal login or one-time code to the safe phone (recommended), or email link only?
