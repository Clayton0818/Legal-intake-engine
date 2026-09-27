# c68 · Turn a prospect into an open matter when retained, and hand off to every other engine

**Card:** `c68` Intake engine · Turn a prospect into an open matter when retained, and hand off to every other engine (Product, P0)

## 1. Summary

The bridge from intake to case management. A matter opens only when all gates are met: conflict cleared (c59), engagement agreement signed (c39), and the retainer or first payment received where the fee type needs one (c52). A lawyer confirms the open; the system then carries over every intake answer, party and document without re-entry and starts each other engine.

## 2. Users and problem

- **Responsible lawyer:** needs a single, safe "Open matter" action that cannot happen early.
- **Staff:** today would re-key intake data into case management.
- **Client:** gets their portal and first update without delay.
- **Firm:** opening before a conflict is cleared, before a signed agreement, or before trust funds arrive creates ethical and trust-accounting risk.

## 3. Scope

**In scope**
- Gate checklist with owner per missing item.
- Lawyer confirmation.
- Carry-over of answers, parties, documents.
- Hand-offs: party index (c56), document checklist (c49), trust ledger and floor (c50, where applicable), fee and pay schedule (c52), client update rhythm (c54), health meter (c53), portal account (c11), team assignment (c48).
- Idempotent, retryable hand-offs and a clear failure state.

**Out of scope**
- Building any of the downstream engines.
- The engagement agreement itself (c39) and trust ledger itself (c76).

## 4. Behaviour

**Gate panel (always visible on a prospective matter)**
1. Shows each gate as met / missing / not applicable, with owner:
   - Conflict cleared: latest c58 result `clear`, or c59 decision recorded; any required waivers signed; any screens in place (c60). Owner: conflicts attorney.
   - Engagement agreement signed by client and countersigned by firm (c39). Owner: responsible lawyer / client.
   - Fee arrangement set (c52: fixed fee or retainer). Owner: responsible lawyer.
   - First payment received where required: retainer deposit (retainer matters) or upfront amount (fixed-fee matters with an upfront payment). Owner: client / billing admin.
2. The panel says exactly what is outstanding and who owns it, e.g. "Waiting for client signature, sent Sep 20".

**Open**
1. All gates met: the lawyer sees "Open matter". Only an `attorney` (the responsible lawyer or a supervising attorney) can click it.
2. The system re-runs a conflict check (c58) if any party was added since the last clear result. If not clear, opening stops.
3. On confirm, in one transaction: `matters.stage` becomes `retained`, proposed `matters.retained_at` set, `intake_events` row `matter_opened` with the gate evidence (ids of the conflict result, signed agreement, payment).
4. Hand-off jobs are queued (one per engine) through `outbox` / `scheduled_tasks`:
   - c56: all intake parties (caller, opposing, co-parties, children's other parent etc. per c103) added to the party index.
   - c49: document checklist created from practice area and matter type.
   - c50 (retainer matters, only when the trust review gate is lifted): trust ledger opened for this client/matter, floor set to the firm default ($4,500) or the per-matter amount in the signed agreement.
   - c52: fee arrangement and pay schedule activated from the signed agreement.
   - c54: client update rhythm started; first update "Your matter is open" to the portal and email.
   - c53: health meter started.
   - c11: portal account invite to the client's safe email address.
   - c48: team confirmed (current assignee kept unless the firm rules say otherwise).
5. Intake data (`intake_sessions.collected_answers`), documents and message history are linked to the matter; the intake session is closed.

**Failure paths**
- A hand-off job fails: the matter is open (the legal step happened), the failed item shows on the matter as "Setup incomplete: portal invite failed" with retry; after 3 failed retries an internal flag goes to the firm admin (c47). Hand-offs are idempotent (re-running creates no duplicates).
- Payment later reverses (chargeback, returned ACH): not an automatic close; a flag goes to the lawyer and billing admin, and c50/c52 rules apply.
- Gate evidence changes after opening (e.g. a waiver revoked): flag to the lawyer; no automatic change.
- Gates sit unmet: c47 stall rule applies to the prospective matter.

## 5. Business rules

1. A matter reaches `retained` only through this action; no other path (c14 rule 5).
2. All applicable gates must be met; there is no override. A lawyer who needs to act before a gate is met does so outside this product's open action (open question 1).
3. Only an `attorney` role can open a matter.
4. A conflict re-check runs at open if parties changed since the last clear result.
5. "Payment received" means the payment processor reports it as settled (default; see open question 2). Pending payments do not meet the gate.
6. Trust-related hand-offs (c50 ledger, trust deposits under c52) run only when the firm's trust features are enabled after the c75 attorney + CPA sign-off. Before that, the gate for a retainer matter is met by a staff attestation that funds were deposited to the firm's trust account outside the product, recorded with who and when.
7. No re-entry: every field captured at intake maps to the matter; nothing the client already answered is asked again.
8. Each hand-off is logged in c6 with success/failure.
9. The client is told the matter is open only after the lawyer's confirmation, never before.

## 6. Data model touchpoints

- **Reuse** `matters` (`stage`, `assigned_user_id`, `practice_area`, `primary_party_id`), `matter_parties`, `parties`, `intake_sessions` (`matter_id`, `collected_answers`, `terminal_state`, `completed_at`), `conflict_check_results`, `documents`, `intake_events`, `outbox`, `scheduled_tasks`.
- Note: `matters.opened_at` defaults to `now()` at row creation, which today is when the prospect record is created. **Proposed** `matters.retained_at timestamptz` to mean "opened as a client matter", so reports (c74 time-to-retain) are correct without redefining `opened_at`.
- **Proposed** `matter_open_gates` (matter_id, gate, status, evidence_ref, owner_user_id, updated_at) or computed view.
- **Proposed** `matter_handoffs` (matter_id, engine, status, attempts, last_error, completed_at).
- Downstream proposed tables owned by other cards: `engagement_agreements` (c39), `fee_arrangements`, `pay_schedules` (c52), `trust_ledgers` (c76), `document_checklists` (c49), portal users (c11).

## 7. Notifications and visibility

- Client: portal invite and "Your matter is open" update (c54), email per c51 to the safe address. No gate status is shown to the client beyond their own outstanding actions (sign, pay), which are client tasks under c46.
- Lawyer: gate panel, in-app notice when all gates are met, flag on hand-off failure.
- Firm admin/billing: hand-off failure flags, payment reversal flags (internal, c51 email).

## 8. Dependencies

- Needs: c59, c58, c60, c39, c52, c75 + c76 + c50 (trust parts), c56, c49, c53, c54, c11, c48, c6, c34.
- Feeds: every engine; c74 (retained, fee value); c33.

## 9. Compliance and review flags

- **Attorney review:** that these gates match when the firm is willing to begin representation, and that nothing in the product or client messages implies representation earlier.
- **Attorney review:** the pre-c75 staff attestation path for retainer deposits.
- **CPA and attorney review:** creating the trust ledger at open, the $4,500 floor, whether the initial deposit must be at or above the floor, and what counts as funds "received" (settled vs pending) before the firm may treat a retainer as in place. Advance fees belong in trust until earned (State Bar of Texas trust guide; *Cluck*, 214 S.W.3d 736; Opinion 611).
- Rule 1.04: if the fee is contingent it must be in writing (Rule 1.04(d)); Family Law matters are usually retainer or fixed fee, but the gate should require a signed writing for every fee type.

## 10. Acceptance criteria

1. Given a signed agreement and settled retainer but a conflict result `possible` with no c59 decision, when the lawyer views the matter, then "Open matter" is disabled and the panel shows "Conflict decision pending - owner: conflicts attorney".
2. Given all gates met, when an `intake_staff` user tries to open, then the action is refused.
3. Given all gates met and a new party added after the last conflict check, when the lawyer clicks Open, then c58 re-runs and the open waits for its result.
4. Given a successful open, when the matter is viewed, then all intake answers and parties are present and no intake question is asked again.
5. Given the portal invite hand-off fails, when the matter is viewed, then it is open, shows "Setup incomplete: portal invite", and retry succeeds without duplicate invites.
6. Given a retainer matter in a firm whose trust features are not yet enabled, when staff record the deposit attestation, then the payment gate is met and the attestation is in the audit trail.
7. Given a fixed-fee matter with no upfront payment in its schedule, when the other gates are met, then the payment gate shows "not applicable" and the matter can open.

## 11. Open questions for Clayton

1. Should there ever be an emergency "open now" override (e.g. a protective-order hearing tomorrow) with a supervising attorney's reason, or is no override the rule?
2. "Payment received": processor-settled (proposed) or bank-cleared? Needs CPA input.
3. Must the first retainer deposit be at least the $4,500 floor before opening, or whatever the agreement says?
