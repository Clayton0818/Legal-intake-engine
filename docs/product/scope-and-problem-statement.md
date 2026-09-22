# Product Scope & Problem Statement

**Status:** Draft — synthesizes decisions already made elsewhere on this board into one canonical statement. Nothing here is a new decision; where it restates a founder call (pricing segment, Texas-only launch, UPL posture), the source document is cited and remains authoritative if this document and that one ever drift.
**Board card:** `c17`
**Date:** 2026-09-22
**Author:** Automated synthesis pass (Claude, scheduled session)
**Depends on / synthesizes:** ADR-0001 (`docs/architecture/adr/0001-initial-technology-stack.md`), the UPL compliance review (`docs/compliance/upl-compliance-review.md`, `c1`), the pricing hypothesis (`docs/go-to-market/pricing-hypothesis.md`, `c29`), the intake flow specification (`docs/product/spec/`, `c12`), and the data privacy & retention policy (`docs/compliance/data-privacy-retention-policy.md`, `c2`).

## 1. Why this document exists

Seventeen cards into this board, the pieces that answer "what is this product, generically, and who is it for" were scattered across a compliance review, a pricing brief, and a YAML spec's README — each correct, none of them the single place a new reader (or a new board card) can point to. This document is that place. It makes no new product decisions; it states the ones already made, together, so scope drift is a visible deviation from a written statement rather than an accumulation of small unstated assumptions across a dozen cards.

## 2. The problem

A prospective client's first contact with a law firm — a phone call, a web form, a walk-in — has to accomplish several things before anyone can decide whether the firm should take the matter: confirm who's calling and that they aren't already a client, an opposing party, or otherwise out of scope; capture enough facts to classify what kind of matter this is; run a conflict check against the firm's existing clients, matters, and *former* consultations (a prior consult can bar representation even where no engagement resulted); decide whether the situation calls for a free initial meeting or a paid consultation; and, only after all of that, get something on the calendar or into a queue for staff review.

Firms handle this today with some combination of a receptionist, a paralegal doing manual intake, a generic CRM's web form, or an answering service — each of which either costs staff time on calls that will never become matters, or loses the specific facts and branching logic (jurisdiction requirements, disqualifying answers, conflict-sensitive routing) that a firm's own intake SOP actually encodes. The reference material this product's flow specification was derived from (`docs/product/reference/`, itself anonymized from a working Texas family-law firm's intake SOP) is evidence that this logic is real, non-trivial, and already being executed by hand today — the opportunity is to encode it faithfully, not to invent a simplified version of it.

**The problem this product solves:** give a law firm a conversational intake system that captures the same facts, applies the same branching logic, and reaches the same ten-way disposition (see §3) that a well-run manual intake process would — consistently, for every inquiry, without a human having to be available the moment someone calls.

## 3. What "generic legal intake" means across practice areas

"Generic" does not mean *simplified* — it means the process **shape** is the same across practice areas while the process **content** differs, and the product is built to keep that split explicit rather than papering over it. This is the single idea from `c12`'s specification (`docs/product/spec/README.md`) that this scope document promotes to a first-class product principle, because it is the answer to "how can one product serve family law, personal injury, expunction, and mediation without becoming five different products":

- **The shape is universal.** Every intake — regardless of practice area — passes through the same stages: confirm caller relationship to the firm, capture identity and contact information, classify the matter, run jurisdiction and disqualification gates, run the conflict check, select a meeting type, and reach one of ten terminal dispositions (scheduled free meeting, scheduled paid consult, pending payment, pending internal review, referred out, declined for conflict, not eligible, out of scope, did not schedule, or abandoned — never a collapsed "booked or didn't book," per the spec README's second core idea). This shape lives in `intake-flow.yaml` and does not change per firm or per practice area.
- **The content is per-practice-area and per-firm.** Which fields get asked (a divorce intake asks about marriage year and residency; an expunction intake asks about arrest location and case disposition; a personal injury intake asks about incident date and insurer contact — see `question-bank.yaml`'s field catalogue), which counties are in scope, which matter subtypes a given firm even accepts, what qualifies as a disqualifying answer, and what the fee thresholds are — all of that is firm configuration (`firm-config.example.yaml`), not flow logic.
- **The current spec's practice-area coverage** is family law (divorce, custody, modification, enforcement, and an "other" catch-all), expunction, personal injury, and mediation — the set the reference SOP actually covered. Extending to a new practice area means adding fields and firm-config entries, not modifying the flow graph; that extensibility claim is itself part of what "generic" is promising, and it should be treated as a testable property (add a new practice area without touching `intake-flow.yaml`) rather than an assertion.
- **What "generic" explicitly does not mean:** a single script that reads the same to every caller regardless of practice area, or a product that only works for the reference firm's specific practice mix. Wording is deliberately excluded from the spec (a firm-authored, attorney-reviewed layer binds to field ids — see spec README, "Wording is not in this spec") for exactly this reason: the logic generalizes, the voice and the legal-advice line do not, and conflating them would mean re-reviewing legal language every time the underlying logic changes.

## 4. Who the first buyer is

**Solo practitioners and small firms, roughly 1–10 attorneys — not mid-size or enterprise firms — for the initial go-to-market.** This is a founder decision already made in `docs/go-to-market/pricing-hypothesis.md` (`c29`); this document restates it here because it constrains product scope, not just pricing:

- The intake-flow spec is built around a single firm's own practice areas and staff roles — the shape of a solo/small firm's actual process, not a large firm's, which typically already has dedicated intake staff and its own bespoke workflows that a generic tool would need heavy customization to match.
- The three-way competitive gap the pricing hypothesis identified (Clio Grow bundled into a higher tier, Lawmatics and Intaker both sales-conversation-only pricing) is specifically a gap in *how this segment gets sold to*, not a product-capability gap — which means the product needs to be adoptable without a procurement cycle, consistent with ADR-0001's "weeks not months, one founder" build posture.
- Consequently: **this product sits alongside a firm's existing CRM or lightweight tools, it does not replace one** (ADR-0001 constraint 7). A solo/small firm with no CRM at all, or a lightweight one, can adopt this without ripping anything out. Integration with practice-management tools (`c5`) is a later expansion, not a v1 requirement — v1 firms may have nothing to integrate with yet.
- Moving upmarket to mid-size or enterprise firms is an explicit later stage, gated on `c5`'s integration layer and a real security/compliance track record — not a ceiling on the product's design, but not this version's target either.

## 5. Scope boundaries for the current build

Stated here so they are checkable against any given card, not just implied by omission:

- **One firm's own intake, not a multi-firm referral or matching service.** This is not a stylistic choice — Texas Occupations Code Chapter 952 restricts lawyer-referral-service certification to nonprofit or governmental entities (`c1`, §5), which forecloses a for-profit cross-firm routing model in Texas outright. The product is scoped as a tool a specific, already-engaged firm licenses for its own intake. If a future business model wants to route across unrelated firms, that is a separate corporate and legal undertaking, not an incremental feature.
- **Texas-only for the initial launch.** `c1`'s compliance review is scoped to Texas per founder direction; additional launch states are deferred to `c28` and each will need its own review at the same depth before the product operates there — Texas's specific statutory carve-outs (the software/forms exception, the barratry statute, the referral-service licensing regime) are not assumed to generalize.
- **Collects facts and routes; does not give legal advice or draft legal conclusions.** The triage classifier's output is a queue-sorting signal for firm staff, never a legal conclusion surfaced to the prospective client (`c1`, §7). No feature in this product's current scope tells a caller what their facts mean for their legal position, whether they have a claim, or whether they need a lawyer.
- **Inbound only.** The current scope assumes a prospective client initiates contact; any future outbound-contact feature (follow-up sequences, retargeting) needs its own barratry review before it's built, per `c1`, §4 and §8 — it is explicitly not in scope now.
- **Human-in-the-loop, not autonomous decisioning.** Conflict-check "possible" matches, and anything the classifier can't confidently resolve, pause the flow for a human — the product's job in those cases is to hold the promise made to the caller and track it, not to decide (spec README, third core idea; ADR-0001 D6).
- **Synthetic data only until the compliance gates clear.** Per ADR-0001 D9's control, production tenant creation stays behind a flag and real client data does not flow through the system until `c1`, `c2`, `c26`, and the model-vendor DPA are all signed off — this applies regardless of how complete the UI (`c23`, `c24`) looks.

## 6. What is explicitly out of scope (v1)

Carried forward from the spec's own "Known gaps" section (`docs/product/spec/README.md`) and the UPL review, because a scope document should name its edges as clearly as its center:

- Payment processing/integration for paid consultations (`payment_state` is modeled; no payment integration is specified or built).
- Post-signature client onboarding — portal activation, engagement agreement execution, billing setup.
- The conflict engine's actual matching implementation (`c3`) — the interface is tri-state and role-sensitive; a boolean implementation would be a scope regression, not a v1 simplification.
- Existing- and former-client handling beyond a routing stub (`existing_caller_handoff`) — those callers are not new intake and need their own design, not a shortcut through this flow.
- E-signature and engagement-letter generation (`c4`) — pending a vendor decision.
- Multi-firm referral/routing of any kind, per §5 above.
- Any outbound solicitation feature, per §5 above.
- Practice-management tool integrations (`c5`) — the product sits alongside a firm's tools in v1; it does not yet write to them.

## 7. How this document should be used

Any card that would change the flow shape for a specific practice area (rather than adding fields/config), that would make the product route across firms, that would have it give a legal conclusion, or that would let it initiate contact, is a scope change against this document — not a natural extension of it — and should be flagged as such rather than built quietly. Conversely, adding a new practice area's fields, a new firm's configuration, or a new supported jurisdiction within Texas are all *in* scope by design and should not require re-litigating this document.

This document should be revisited when: a pilot firm conversation (`c30`) surfaces a buyer segment or workflow assumption that doesn't match §4; `c28` selects additional launch states, which extends §5's Texas-only boundary; or the "sits alongside, doesn't replace the CRM" premise in §4 and ADR-0001 constraint 7 changes — ADR-0001 itself flags that as the single change most likely to invalidate its own decisions, and it would invalidate parts of this one too.
