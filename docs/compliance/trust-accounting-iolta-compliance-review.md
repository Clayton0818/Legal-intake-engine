# Trust Accounting / IOLTA Compliance Review — Texas

**Status:** Research draft and a recommended approach — not a legal or accounting opinion. Requires sign-off by **both** a licensed Texas attorney and a CPA competent in trust accounting before any of it is relied on operationally or built into the trust ledger (card `c76`) or any other trust/billing feature. This is a stricter review bar than the other compliance documents on this board: a trust-accounting failure is a fiduciary breach that can end an individual attorney's license to practice, not just a civil or regulatory exposure to the business.

**Scope note:** Texas only, consistent with `c1`'s and `c2`'s Texas-first scoping and `c28` (target launch states, not yet decided). When additional states are selected, this document should be extended with the same depth, not assumed to generalize — trust-accounting rules, while broadly similar in structure across states (nearly every state runs an IOLTA program and requires reconciliation), differ in specifics: reconciliation cadence, retention periods, and overdraft-notification rules are all state-specific.

**Prepared for:** Case-management expansion, trust accounting track item 1 (`docs/product/case-management-expansion-scope.md` §6). Gates board card `c76` (trust ledger & three-way reconciliation engine) and the trust-touching portions of `c50` (retainer floor), `c52` (fixed-fee payment schedules), `c79` (invoices), `c80` (online payments), `c81` (unpaid-invoice tracking), and `c82` (refunds).
**Date:** 2026-10-01
**Author:** Automated research pass (Claude, scheduled session) — see Sources section for citations.

## 1. Why this is a different kind of risk than `c1`, `c2`, or `c9`

Every other compliance document on this board treats its worst-case failure as a civil or regulatory action against the business: a UPL injunction, an AG privacy-enforcement action, a data breach notification obligation. Trust accounting is categorically different. A Texas lawyer who commingles, misapplies, or simply loses track of client funds held in trust is exposed to attorney-discipline proceedings — reprimand, suspension, or disbarment — run through the Office of Chief Disciplinary Counsel, on top of whatever civil or criminal exposure the same conduct might separately create. The product would become the system of record for money that it is professionally disqualifying for an individual attorney to mishandle, which is a materially higher bar than "this is a serious bug."

This review is explicitly a gate, not a formality. Per the card note on `c75`, nothing downstream (`c76`'s trust ledger, or any billing feature that touches trust funds) should be built against this document until it has real attorney-and-CPA-reviewed content behind it — a draft is enough to unblock architecture work that assumes the rule *shapes* described below, consistent with how `c19`'s data model was allowed to proceed against `c1`'s draft before `c26`'s sign-off landed, but nothing should go live against client money on the strength of a draft alone.

## 2. What counts as trust money, and the core rule

**Texas Disciplinary Rules of Professional Conduct Rule 1.15 ("Safekeeping Property")** is the governing rule. It requires a lawyer to hold, in a separate account, "funds and other property belonging in whole or in part to clients or third persons" that are in the lawyer's possession in connection with a representation.

**Must be held in trust:**
- Unearned fees and advance payments for legal services not yet performed, including flat fees — labeling a fee "nonrefundable" does not make it earned (Texas Ethics Opinion 611; see §5).
- Settlement proceeds and other third-party funds awaiting distribution.
- Any funds in which the client or a third person has an interest, even if the lawyer also has a claim to part of them.

**Must not be held in trust (must stay in the firm's own operating account):**
- Fees that are genuinely, fully earned.
- Funds belonging wholly to the lawyer or firm.
- Reimbursement of costs the lawyer has already advanced on the client's behalf.

**A rule-numbering flag, consistent with how `c10` handled the same issue for Rule 5.04/5.05:** Texas's Disciplinary Rules were renumbered as part of the March 2025 rule amendments the product's other compliance documents have already had to account for. The State Bar of Texas's own current trust-account guide (most recently revised November 2025) cites the safekeeping-property rule as **Rule 1.15**. Some secondary sources not yet updated for the renumbering still cite the pre-2025 number, **Rule 1.14**. This document uses 1.15 as the current number, sourced from the Bar's own most-recently-revised guide, but — exactly as `c10` flagged for the 5.04/5.05 renumbering — this should be confirmed by the attorney reviewer rather than taken on this research pass's authority alone.

## 3. IOLTA: the mandatory account itself

**Texas State Bar Rules, Article XI, § 5** requires that nominal or short-term client funds — amounts too small or held too briefly to generate meaningful interest for the individual client once bank fees are netted out — be deposited into an Interest on Lawyers' Trust Account (IOLTA), rather than a non-interest-bearing trust account or, worse, not segregated at all. This is not optional once a firm holds any client funds; every Texas attorney certifies IOLTA compliance annually as part of State Bar dues, including attorneys who hold no client funds and must affirmatively state that no IOLTA is associated with their bar card. Attorneys not in private practice, or who never handle client funds, are exempt from maintaining the account itself but not from the annual certification step.

**Setup and reporting requirements relevant to anything this product would automate or track:**
- The account must be opened using the Texas Access to Justice Foundation's tax ID and titled as an IOLTA or client trust account, at an IOLTA-eligible financial institution.
- The financial institution must be given written notice within 30 days of opening the account.
- The firm must notify the Foundation within 30 days of closing an account or changing firm affiliation.
- Interest earned on IOLTA funds is remitted to the Texas Access to Justice Foundation, not retained by the firm or the client — a detail worth surfacing in the product's trust-ledger design so the ledger doesn't accidentally attribute pooled interest to an individual client's sub-ledger.

**Enforcement:** failure to comply with IOLTA certification can result in suspension. This runs alongside, not instead of, the broader Rule 1.15 disciplinary exposure in §1.

## 4. Three-way reconciliation — the mechanical control that actually gets checked

This is the control a bar examiner or auditor actually looks at, and it is the specific mechanism the scope memo (§3) already flagged as the reason this document should come before any trust-ledger code is written.

**The three figures that must agree, every reconciliation cycle:**
1. The bank's statement balance for the trust account.
2. The firm's own trust-account check register / ledger balance (the pooled total).
3. The sum of every individual client's sub-ledger balance.

All three must reconcile to the same dollar figure. **Monthly reconciliation is the standard the State Bar's own guide recommends** ("reconcile, reconcile, reconcile"), and a discrepancy across any of the three requires immediate investigation — not a note-and-move-on. A pattern this product's design should actively resist: allowing a "small" unexplained variance to persist across reconciliation cycles. Three-way reconciliation is a control specifically because small, unexplained variances are how misappropriation is discovered — tolerating them defeats the control's purpose.

**What each component ledger must contain**, which maps fairly directly onto `c76`'s eventual schema:
- **Check register / pooled ledger:** every deposit and disbursement, in date order, with a running balance, source or payee, and a brief explanation.
- **Per-client sub-ledger:** every deposit and disbursement attributable to that specific client or matter, with its own running balance — this is the table that must never be allowed to go negative for an individual client even while the pooled account as a whole has a positive balance (see §6 on disputed funds and §7 on advance fees for why this matters operationally).

## 5. Record-keeping and retention — a longer, different clock than `c2`

**Texas Rules of Disciplinary Procedure § 17.10** requires a lawyer to maintain complete trust-account records — checkbooks, canceled checks, check stubs, check registers, bank statements, vouchers, deposit slips, the pooled ledger, every client's sub-ledger, and any closing statements or accountings — with each record clearly reflecting the date, amount, source, and explanation for every receipt, withdrawal, delivery, and disbursement.

**Retention period: five years after termination of the representation.** This is materially different from, and longer than, the retention clock `c2`'s policy sets for the underlying intake and matter data, because it is not about the privacy interest in the underlying facts — it is about proving, potentially years after a matter closes, exactly what happened to a specific client's money. The product's design should issue (or prompt staff to issue) a clear closing event for each matter specifically so there is an unambiguous date from which this five-year clock starts running, the same "closing letter tolls the clock" practice the State Bar's own guide recommends.

**This retention requirement should not be merged into, or governed by, the same per-firm retention setting `c6`'s audit-log document ties to matter retention.** `c6` recommended tying audit-trail retention to the matter's own (firm-configurable) retention setting because the two serve the same purpose. Trust records are different: § 17.10's five-year floor is a fixed regulatory minimum, not a professional-judgment call the way `c6`'s malpractice-driven retention period is under Texas Ethics Opinion 627. The trust ledger's retention floor should be hard-coded to "five years post-closure, non-configurable downward," with firms free to set it longer but not shorter.

## 6. Disputed funds

**Rule 1.15(c)** governs what happens when there is a genuine dispute over who owns funds the lawyer is holding — most commonly a dispute between the lawyer and the client over a fee, or between the client and a third party (a medical lienholder, for example) over settlement proceeds:

- The portion in dispute must be kept segregated in trust until the dispute is resolved.
- The undisputed portion must be distributed promptly — a lawyer may not hold an entire fund hostage to leverage resolution of a dispute over part of it.
- The lawyer may not unilaterally decide a disputed ownership question; if the parties can't resolve it themselves, it goes to a court.

**Design implication for `c76`:** the trust ledger needs a first-class "disputed / held pending resolution" state at the line-item level within a client's sub-ledger, distinct from an ordinary pending disbursement — a disputed amount needs to be excluded from what the ledger considers "available to disburse" for that matter until the dispute-resolution event clears it, and that state change needs its own audit trail entry (consistent with `c6`'s completeness requirement for gated decisions).

## 7. Advance and flat fees — the rule this product's billing engine most needs to get right

**Texas Ethics Opinion 611** is the controlling guidance on when a fee counts as "earned" for trust-accounting purposes, and it is directly relevant to `c52`'s planned fixed-fee payment schedules:

- A payment for services **not yet performed** must stay in trust, regardless of how the engagement letter labels it. Calling a flat fee "nonrefundable" or "earned upon receipt" does not make it so under Rule 1.15 — it is still the client's money until the corresponding work is actually done.
- A **true nonrefundable retainer** — a fee paid solely to secure the lawyer's availability and compensate for the lawyer turning away other work, not tied to future services — can be treated as earned on receipt and deposited to the operating account, but the lawyer must be able to substantiate that characterization (the lost-opportunity rationale), not simply assert it. This is a narrow category and the product should not default fee structures into it.
- The practical consequence for `c52`: a fixed-fee matter with a payment schedule should, by default, treat each scheduled payment as trust funds until the firm's own fee agreement defines specific, objective earning benchmarks (e.g., "25% earned on filing, 25% on discovery close") — and the ledger should move funds from trust to operating only as each benchmark is met, not on receipt. This is also the mechanism the card `c50` retainer floor ($4,500 minimum, per the board) should hook into: the floor is a trust-balance check, not an operating-revenue check.

## 8. Credit card and payment processing fees — cannot be deducted from the trust account

This is a narrow but concrete rule directly relevant to `c80` (online card and bank payments):

- **No funds belonging to the lawyer or firm — other than a small amount reasonably sufficient to avoid the account being closed for low balance or to cover bank fees that cannot otherwise be avoided — may be deposited into the trust account.** A payment processor's merchant fee, deducted automatically from a client's card payment before it lands in the account, is exactly the kind of firm-side cost this rule is written to keep out of trust: netting the fee out of the deposit effectively uses the client's trust funds to pay the firm's cost of doing business, and topping the account back up afterward to compensate doesn't cure the problem — it is itself a form of commingling across the time the funds were short.
- **The safest architecture, and the one this document recommends for `c80`:** route the trust-bound portion of a card payment to the trust account at the full, pre-fee amount, and have the processing fee charged separately against the firm's operating account. Several processors resist this by default (their standard flow nets the fee out before settlement), so vendor selection for `c80` should treat "can route the full payment amount to a trust account separately from the fee" as a hard requirement, not a nice-to-have, and this should be confirmed in writing with the chosen processor before `c80` is built — not discovered after the first real client payment.

## 9. Refunds of unearned fees on termination

**Rule 1.15(d)** requires that, upon termination of representation — regardless of whether the client fired the firm, the firm withdrew, or the matter simply ended — the lawyer take reasonably practicable steps to protect the client's interests, which explicitly includes refunding any advance payment of a fee that has not been earned. There is no carve-out for a contractually "nonrefundable" label (see §7); if the benchmark work wasn't done, the corresponding portion of the fee was never earned and must come back.

**Design implication for `c82`:** a matter-closing workflow should compute the unearned balance directly from the same benchmark/earned-amount logic §7 recommends for `c52`, not as a separate manual calculation — and the refund should be flagged for lawyer review before it is sent, the same gating pattern already in use elsewhere on this board (e.g., the conflict-check engine's gated referral letters) rather than an automatic wire.

## 10. Unclaimed trust funds — flagged, not resolved

Texas, like every state, has an escheat regime for unclaimed property (Property Code Title 6, administered by the Comptroller), and trust-account funds a firm cannot locate the rightful owner for after reasonable diligence are not exempt from it. This research pass did not reach a confident, sourced answer on the specific dormancy period and reporting mechanics as applied to attorney trust accounts specifically (as opposed to unclaimed property generally), and the product does not yet have a feature in this area — there is no board card for it today. **This is flagged as a gap to close before `c76` ships a "funds we can't locate the client for" state**, not resolved here; it should be a specific question put to the attorney reviewer rather than something this document guesses at, given how easy it would be to get a dormancy period or reporting deadline wrong in a way nobody notices until an audit.

## 11. Output: the rule list the trust ledger (`c76`) must enforce

Translating the above into the concrete rule set `c75`'s card note asks for, as a checklist for whoever builds `c76`:

1. **Account structure:** one pooled IOLTA trust account per firm (or per firm's chosen banking setup), with a per-client sub-ledger for every client/matter holding trust funds. The pooled balance must always equal the sum of all sub-ledger balances (§4).
2. **No sub-ledger may go negative.** A disbursement that would take a specific client's sub-ledger below zero must be blocked at the application layer, even if the pooled account has sufficient funds overall — a negative sub-ledger is definitionally spending another client's money.
3. **Three-way reconciliation is a required, recurring, non-skippable workflow** — bank statement vs. pooled ledger vs. sum of sub-ledgers — surfaced the same way `c37`'s ops SLA queue surfaces other overdue firm obligations, with any discrepancy raised as a blocking flag rather than a soft warning (§4).
4. **Default classification of incoming funds is "trust" unless specifically exempted.** Settlement proceeds, advance fees, and flat-fee payments default to trust; only a substantiated, specifically-flagged "true nonrefundable retainer" or a fully-earned invoice payment may post directly to operating (§2, §7).
5. **Earned-vs-unearned tracking per matter, driven by firm-defined objective benchmarks**, not by elapsed time or invoice issuance alone — funds move from trust to operating only as benchmarks are met (§7).
6. **A first-class "disputed" state** at the sub-ledger line-item level, excluded from "available to disburse" until resolved, with its own audit entry (§6).
7. **Payment-processing fees are never netted out of a trust deposit.** The full payment amount posts to trust; any processing fee is charged separately against operating (§8).
8. **Matter closure computes and flags any unearned balance for refund**, gated for lawyer review before disbursement (§9).
9. **Records retained five years post-matter-closure, non-configurable downward**, independent of `c2`'s or `c6`'s retention settings (§5).
10. **Write-path integrity at least as strict as `c6`'s audit-log recommendation, and arguably stricter:** no `UPDATE`/`DELETE` grants on the application's database role for trust-ledger tables (append-only, corrections via offsetting entries rather than edits — standard accounting practice independent of any bar rule), a required CI tripwire mirroring `c6`'s, and — where `c6` treated hash-chaining as a should-have — this document recommends treating it as a **should-have graduating to a hard requirement before the first real (non-synthetic) trust transaction**, not before launch in the abstract. Three-way reconciliation is the exact mechanism an auditor checks, and tamper-evidence matters most exactly where the stakes are license-ending.
11. **An unresolved/unclaimed-funds state is explicitly out of scope for `c76`'s first version**, pending §10's escheat research.

## 12. Why a CPA reviewer, specifically, and not just an attorney

`c1` and `c26` already established the attorney-sign-off pattern for this board's compliance documents. Trust accounting is as much an accounting-competence question as a legal one: three-way reconciliation, earned-vs-unearned revenue recognition, and the mechanics of ledger corrections (offsetting entries vs. edits) are standard accounting practice, not legal doctrine, even though the consequence of getting them wrong is a legal-discipline outcome. The attorney reviewer's competence is in the Rule 1.15 / § 17.10 framework and professional-responsibility consequences; a CPA's competence is in whether the actual reconciliation and ledger mechanics in §4 and §11 are sound bookkeeping practice. Neither reviewer should be assumed to cover the other's ground — this document recommends both sign off, independently, before `c76` is built.

## 13. Open questions for attorney and CPA review

1. **Rule number confirmation:** is Rule 1.15 (current, per the Bar's November-2025-revised guide) correct, or does the 2025 renumbering leave some ambiguity this research pass didn't resolve? (§2)
2. **Unclaimed/escheated trust funds:** what is the actual Texas dormancy period and reporting process for trust funds a firm can't locate the client for, and does `c76` need a feature for this at launch or can it be deferred? (§10)
3. **True nonrefundable retainers:** how should the product's fee-agreement templates (feeding `c85`'s document-template work) be worded so a "true" nonrefundable retainer is actually substantiable under Ethics Opinion 611, versus accidentally drafting language that looks nonrefundable but isn't? (§7)
4. **Reconciliation cadence enforcement:** is a hard monthly requirement (blocking some other firm action if reconciliation is overdue) appropriate, or should it be a strong flag that doesn't block operations? The State Bar's guide recommends monthly but this document did not find a hard rule mandating a specific enforcement mechanism for a *software product* specifically. (§4, §11)
5. **Hash-chaining timing:** should trust-ledger tamper-evidence (§11, item 10) be a hard launch requirement rather than "before the first real transaction," given that trust accounting's stakes are categorically higher than the general audit log's? This document recommends the latter but flags it as a judgment call, not a settled answer.
6. **Payment-processor vendor selection for `c80`:** does the CPA reviewer want to validate the specific processor's fee-routing mechanics before `c80` is built, given §8's finding that many processors resist routing full payment amounts to trust by default?

## Sources

- [A Lawyer's Guide to Client Trust Accounts — State Bar of Texas (updated through November 2025)](https://www.texasbarpractice.com/wp-content/uploads/2026/04/1-2024-Revised-Trust-Account-Guide-Final-v2-Rev-Nov-2025-1.pdf) — Rule 1.15 text and structure, three-way reconciliation mechanics, § 17.10 record-keeping and five-year retention, true-nonrefundable-retainer distinction, disputed-funds handling. Primary source for most of this document.
- [TAJF — IOLTA Compliance](https://www.teajf.org/attorneys/compliance.aspx) — annual certification requirement, exemptions, 30-day notice obligations, suspension as the enforcement consequence.
- [Texas IOLTA Trust Account Management — Law Firm Velocity](https://www.lawfirmvelocity.com/resources/iolta/texas) — IOLTA trigger conditions and account-setup requirements, cross-checked against the Bar's own guide.
- [Can You Pay Credit Card and PayPal Fees From Trust Accounts? — Texas Lawyers' Insurance Exchange](https://www.tlie.org/resource/can-you-pay-credit-card-and-paypal-fees-from-trust-accounts) — the rule against netting processing fees out of trust deposits, and the operating-account workaround; note this source cites the pre-2025 rule number (1.14) for the safekeeping rule, which this document treats as superseded per the Bar's own current guide (see §2's flag).
- [Texas Property Code, Title 6 — Unclaimed Property (Justia)](https://law.justia.com/codes/texas/2015/property-code/title-6/) — general escheat framework; this document did not confirm the specific attorney-trust-account application and flags it as an open question (§10).
- `docs/architecture/audit-log-compliance-trail.md` (`c6`) — the immutability and hash-chaining pattern this document adapts (and tightens) for the trust ledger (§11).
- `docs/compliance/data-privacy-retention-policy.md` (`c2`) and `docs/compliance/upl-compliance-review.md` (`c1`) — the existing attorney-review and "research, not opinion" framing this document follows, plus the precedent (`c1`/`c10`) for flagging a rule-renumbering discrepancy for attorney confirmation rather than silently picking one number.
- `docs/product/case-management-expansion-scope.md` §3, §6 — the scope and sequencing this document fulfills.

---

*This document is research and a recommended approach, not legal or accounting advice. It creates no attorney-client or accountant-client relationship. Both a licensed Texas attorney and a CPA competent in trust accounting must review it before any of it is relied on operationally or built into the product.*
