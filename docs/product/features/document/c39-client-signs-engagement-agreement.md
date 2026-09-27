# c39 · Client signs engagement agreement

**Card:** `c39` Document engine · Client signs engagement agreement (Product, P1)
**Builds on:** c4 (the e-signature and engagement-letter build) and the c68 spec on `work/product-specs-intake` (the gate panel that opens a matter). Where the c39 card note and c68 differ, this spec follows c68 and raises the difference as open question 1.

## 1. Summary

The moment a prospective client becomes a client. The engagement agreement is drafted from the matter and firm configuration, approved by the lawyer, signed by the client, countersigned by the firm, and stored against the matter. A completed agreement meets the "engagement agreement signed" gate in c68 and triggers the retainer request (c52/c50, trust parts gated on c75).

## 2. Users and problem

- **Prospective client:** arrives from a paid consult or scheduled outcome (Intake engine) and needs a clear, signable agreement without an office visit.
- **Responsible lawyer:** must be sure the agreement matches the fee arrangement, the conflict decision and the firm's approved wording before anyone signs.
- **Firm:** must not start work, take a trust deposit or tell the client they are represented before the agreement is signed and countersigned.

## 3. Scope

**In scope**
- The workflow from "lawyer decides to take the matter" to "agreement fully signed and stored".
- Fee arrangement capture into the agreement (c52: fixed fee with pay schedule, or retainer with floor).
- Firm AI-disclosure clause from c10 §4.6 included in the template.
- Hand-offs: c68 gate, c52 pay schedule, c50/c76 retainer request (gated), c40 onboarding documents.

**Out of scope**
- The e-signature mechanism (c4) and template mechanics (c85).
- Opening the matter and changing its stage (c68).
- Taking payment (c80) and trust ledger entries (c76).
- Changing a fee arrangement mid-matter (c52 needs a new signed agreement; it reuses this flow with purpose `fee_change`).

## 4. Behaviour

1. **Start.** On a prospective matter whose conflict status allows it (c59), the lawyer clicks "Prepare engagement". The lawyer chooses the fee arrangement (c52). For a retainer, the floor defaults to $4,500 (c50), editable per matter by the lawyer.
2. **Draft.** c4 fills the firm's approved engagement template for the practice area and matter type. The Family Law pack (c103) supplies the default template set once reviewed.
3. **Lawyer review.** The lawyer edits if needed and approves. Only an `attorney` can approve.
4. **Send.** c4 sends an envelope: client signs first, then the lawyer countersigns (firm setting). Before the first signature the client confirms consent to sign electronically. A client task "Review and sign your engagement agreement" appears in the portal (c11) and follows c46 reminders.
5. **Client questions.** Questions go to the lawyer as client messages (c43 24h clock; c44 if about a deadline). The AI does not explain terms or advise whether to sign.
6. **Client signs.** The lawyer gets a countersign task (firm task, c45 rules, default due 1 business day).
7. **Countersign.** The lawyer countersigns. The fully signed PDF and completion certificate are stored on the matter as a document of type `engagement_agreement`.
8. **Hand-offs on completion:**
   - c68 gate "Engagement agreement signed" becomes met, with the envelope id as evidence.
   - c52 activates the fee arrangement and pay schedule as signed.
   - Retainer request: if the firm's trust features are enabled after c75 sign-off, a retainer payment request is created (c80/c76). Before that, staff record the deposit made outside the product (c68 rule 6).
   - c40 starts: the onboarding document set for this matter is created and delivery tracking begins.
   - The client gets a portal update "Your agreement is signed" (c54). The client is not told the matter is open until c68 opens it.
9. **Matter stage.** Stage stays prospective until the lawyer opens it through c68. The intake session closes when c68 opens the matter (open question 1).

**Edge cases and failures**
- Client declines to sign: firm task to the lawyer with the reason; the lawyer decides next steps (revise, or decline via c62 non-engagement letter). Nothing automatic.
- Client wants changes: lawyer edits, a new version is approved, the old envelope is voided, a new one is sent.
- Envelope expires: lawyer is flagged; re-send or close out.
- New party appears before signing (e.g. a new partner named): c58 re-check runs; if the result is not clear, the envelope is voided automatically and the lawyer is told "conflict re-check required" (client sees only "your agreement is being updated").
- Two clients on one matter (e.g. joint matter): each is a signer; the agreement completes only when all have signed. Joint representation in Family Law raises conflict issues; see §9.
- DV matter: all contact to the safe address and safe phone; no reminders by SMS unless consent is recorded (TCPA).

## 5. Business rules

1. No agreement is drafted or sent while a conflict decision is pending, a waiver is unsigned or a required screen is not in place (c59, c60).
2. The agreement always states the fee arrangement type (fixed fee or retainer) and its terms as set in c52; the pay schedule and total for a fixed fee, the retainer amount and floor for a retainer.
3. The agreement always includes the firm's current approved AI-disclosure clause (c10 §4.6).
4. Only an `attorney` approves and countersigns.
5. Signing order: firm setting, default client first then lawyer.
6. Envelope expiry: firm setting, default 10 business days (c4 rule 6).
7. Countersign task due: firm setting, default 1 business day after the client signs.
8. A signed agreement is never edited; changes need a new agreement.
9. The client is never told they are represented until c68 opens the matter.
10. Trust-related hand-offs run only when the firm's trust features are enabled after c75 sign-off.
11. Each step (drafted, approved, sent, viewed, signed, countersigned, voided) is logged in c6.

## 6. Data model touchpoints

- **Reuse:** `matters` (`stage`, `practice_area`, `assigned_user_id`), `parties`, `matter_parties`, `conflict_check_results`, `documents`/`document_versions` (c84), `intake_sessions` (closed by c68), `scheduled_tasks`, `outbox`, `firm_config_versions`.
- **Reuse from c4:** `signature_envelopes` (purpose `engagement`), `signature_signers`.
- **Proposed** `engagement_agreements` (id, tenant_id, matter_id, envelope_id, fee_arrangement_id, template_version_id, status [drafting, approved, sent, client_signed, completed, declined, voided, expired], approved_by, completed_at). Named in the c68 spec as owned by c39.
- **Reuse from c52 (proposed there):** `fee_arrangements`, `pay_schedules`.

## 7. Notifications and visibility

- **Client:** portal task and minimal email (c51) to sign; confirmation update when fully signed (c54). Sees the agreement they signed at any time in the portal.
- **Lawyer:** countersign task; decline/expiry/bounce flags (internal, c45 + c51 email).
- **Firm admin:** overdue unsigned or uncountersigned agreements on the ops queue (c37).
- Client never sees: conflict details, internal notes, other signers' decline reasons, overdue firm flags.

## 8. Dependencies

- **Needs:** c4, c85, c52, c59 (and c58, c60), c10 (AI disclosure wording), c11 + c34 (client login), c46, c45, c51, c6.
- **Feeds:** c68 (gate), c52 (activate schedule), c50/c76/c80 (retainer request, gated on c75), c40 (onboarding documents), c54 (update), c103 (Family Law default templates).

## 9. Compliance and review flags

- **Attorney review:** the engagement template wording (scope, fees, termination, file retention, AI disclosure) for Texas Family Law.
- **Attorney review:** joint or multiple-client agreements in Family Law and whether the product should block them by default (Rule 1.06 current-client conflicts).
- **Attorney review:** the electronic-signature consent step and whether any engagement types need wet ink (see c4 §9, Tex. Bus. & Com. Code §§322.005, 322.007).
- **Attorney and CPA review:** retainer and advance-fee wording and the retainer request into IOLTA. Advance flat fees belong in trust until earned (State Bar of Texas trust guide; *Cluck*, 214 S.W.3d 736; Opinion 611). Gated on c75.
- **Attorney review:** that no product message implies representation before the matter is opened (Rule 1.18 prospective-client duties still apply until then).

## 10. Acceptance criteria

1. Given a matter whose c59 decision requires a waiver that is unsigned, when the lawyer clicks "Prepare engagement", then the action is blocked with "Waiver signatures pending".
2. Given a retainer arrangement with no per-matter override, when the draft is generated, then the floor shown is $4,500.
3. Given the client has signed, when the lawyer has not countersigned within 1 business day, then an internal overdue flag goes to the lawyer and a c51 email is sent, and nothing is shown to the client.
4. Given both signatures, when the envelope completes, then the c68 gate shows "Engagement agreement signed" with the envelope as evidence and the matter stage is still `prospective`.
5. Given a new party is added before the client signs and c58 returns `possible`, when the check completes, then the envelope is voided and the client sees only a neutral "being updated" message.
6. Given a firm without c75 sign-off, when the agreement completes, then no in-product trust deposit is created and the c68 attestation path is offered instead.
7. Given the client asks the assistant what the termination clause means, when it replies, then it routes the question to the lawyer and gives no explanation.

## 11. Open questions for Clayton

1. The card says signature moves the matter to retained and closes the intake session; c68 says retained happens only through the lawyer's Open action with every gate met (including first payment). This spec follows c68. Confirm, or should signature alone open the matter?
2. Signing order: client first then lawyer (recommended), or lawyer first?
3. Unsigned agreement validity: 10 business days (proposed), or another period?
