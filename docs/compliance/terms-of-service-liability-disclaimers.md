# Terms of Service & Liability Disclaimers — Research Draft and Recommended Approach

**Board card:** `c10` — Terms of service & liability disclaimers
**Status:** Research and a recommended approach. **Not a legal opinion and not a finished contract.** This document must be reviewed, revised, and approved by a licensed attorney — ideally the same Texas UPL/ethics reviewer already tracked on `c26`, working alongside counsel competent in SaaS/commercial contracting — before any of the language recommended here is published, shown to a prospective firm, or relied on operationally.
**Depends on / synthesizes:** `docs/compliance/upl-compliance-review.md` (`c1`), `docs/compliance/data-privacy-retention-policy.md` (`c2`), `docs/architecture/adr/0001-initial-technology-stack.md` (`c18`, specifically D9's model-vendor gate), `docs/security/encryption-access-control-review.md` (`c9`), `docs/architecture/audit-log-compliance-trail.md` (`c6`), `docs/product/scope-and-problem-statement.md` (`c17`), `docs/go-to-market/pricing-hypothesis.md` (`c29`).
**Consumed by:** the firm-facing subscription agreement (a Founder task to actually execute), the client-facing intake UI's disclosure copy (`c23`, currently un-reviewed placeholder text per that PR's own flag), and the data processing addendum `c2` §8 already called for.
**Scope note:** Unlike `c1`, this document is not Texas-scoped by its subject matter — a terms-of-service and liability framework has to work for whichever firm signs up, in whichever state, because the vendor's own contract governs the vendor/firm relationship regardless of where the firm's clients live. Where a specific citation is useful, Texas is used as the concrete worked example, consistent with `c2`'s approach, because Texas is the only jurisdiction with real work behind it on this board (`c1`, `c28` still open). Every citation below should be re-checked against the firm's actual practice jurisdiction(s) once `c28` resolves.
**Date:** 2026-09-25
**Author:** Automated research pass (Claude, scheduled session) — see Sources for citations.

---

## 1. Two documents, not one, and why that distinction is load-bearing

"Terms of service" undersells what `c10` actually needs to produce. This product has two structurally different audiences, and conflating them is the single most common mistake in how legal-tech vendors write their terms:

1. **The firm-facing agreement** — the contract between the company and the subscribing law firm. This is an ordinary (if compliance-heavy) B2B SaaS contract: a Master Subscription Agreement or Terms of Service that a firm's managing partner or office manager clicks through or signs, governing the license, the fee, data handling, warranties, liability, and termination.
2. **The end-user–facing disclosures** — the language a *prospective client* sees inside the chat widget (`c23`) before or while they talk to it. This person has never agreed to anything with the vendor; they are often not yet even a client of the firm. `c1` §7 already established the legal content this layer has to carry (the § 81.101(c) disclosure, the "route, don't decide" framing); this document adds the liability and relationship-disclaimer language that belongs alongside it, and treats the two as one coherent disclosure block rather than two separately-drafted pieces of copy.

These two documents have different counterparties, different legal theories protecting them (contract law for the firm agreement; a mix of consumer-protection, professional-responsibility, and evidentiary doctrine for the end-user disclosures), and different consequences if they are wrong. A liability cap that means nothing to a prospective client (they never read or agreed to the firm agreement) is not a substitute for a clear, conspicuous disclosure in the chat window, and a chat-window disclosure is not a substitute for the firm agreement's actual allocation of legal and financial risk between the vendor and the firm. `c10`'s deliverable is both, kept consistent with each other.

## 2. Why this card was next

Every other item ahead of it in the board's dependency order (UPL review, data privacy, multi-tenant architecture, encryption/access review, intake flow design, triage classifier, the stack ADR) has real merged work behind it. This one didn't — no document existed in `docs/compliance/` for it despite the card sitting in the board's Review & QA column, a gap the `c19` PR's own review notes flagged explicitly ("`c10` appears to have no actual work behind it despite its board position"). That gap matters beyond just tidiness: three separate upstream documents already name `c10` as the place their own open threads resolve —

- `c2` §4 hands off "model consent/disclosure language for firms to give their own clients about AI processing" as "a joint deliverable with `c10`."
- `c2` §8 says the data processing addendum "is very likely a required contractual artifact... [r]ecommend this be drafted alongside the terms of service (`c10`), not treated as a separate later task, since the two documents need to be internally consistent."
- `c1` §7 and §8 point to `c10` for the firm's own indemnification/acknowledgment of its supervisory responsibility, and for Texas Disciplinary Rule 5.05(b)'s implications for firm onboarding.

Until this document existed, those were three open loops with nowhere to land. It is also, per the board's guardrails, a precondition for `c3` (the conflict-check engine, the highest-priority remaining Engineering card) — implementation code should not resume until the compliance/architecture groundwork behind it is real, and this was the one piece of that groundwork with nothing behind it.

## 3. The firm-facing agreement: recommended structure and provisions

The recommended vehicle is a **Master Subscription Agreement (MSA)**, referenced by an online Terms of Service page and accepted at signup, rather than a heavier negotiated contract — consistent with `docs/product/scope-and-problem-statement.md` §4's framing of the target buyer (solo/small firms, 1–10 attorneys) as needing to adopt "without a procurement cycle." A click-through MSA is standard for this buyer segment and is what every competitor named in `c15`'s scan effectively uses. Below is section-by-section content, not final contract language — actual drafting is counsel's job, informed by this structure.

### 3.1 Relationship of the parties — the vendor is not a law firm

This is the single most important sentence in the whole agreement, and it should appear early, not buried in boilerplate: **the company is a software vendor. It does not practice law, does not give legal advice, and is not a law firm.** Nothing the product outputs — a classifier label, a conflict-check result, a scheduling recommendation — is a legal conclusion, and the firm's own attorneys remain solely responsible for every judgment about a prospective client's matter. This restates `c1` §7's "route, don't decide" design principle as a contractual commitment, not just a product behavior, which matters because a design principle can silently drift as features get added; a contract term is the backstop when it does.

The agreement should also state plainly that using the product does not create an attorney-client relationship between the company and anyone — not the firm, and certainly not the firm's prospective clients — and that the company is not a party to, and has no visibility into, the substance of the firm's attorney-client relationships beyond the intake data the product structurally needs to operate.

### 3.2 The firm's supervisory and ethical-compliance responsibilities

Every compliance document behind this one converges on the same point: the vendor can build guardrails, but the deploying firm's own attorneys carry independent, non-delegable ethical obligations that the contract should make explicit rather than assume:

- **Texas Disciplinary Rule 5.05(b)** (the Texas analog to ABA Model Rule 5.5(b), corrected here from the "5.5(b)" citation in `c1`'s original PR — Texas's rule numbering is 5.05, not 5.5, per the Texas Center for Legal Ethics' rule index; this correction itself should be attorney-confirmed) prohibits a lawyer from assisting a non-lawyer — which includes a software tool — in the unauthorized practice of law. The practical contract implication: the firm, not the vendor, is responsible for reviewing and approving any scripted client-facing language, any conflict-check escalation workflow, and any classifier output before those are relied on operationally with real prospective clients, and the agreement should say so rather than leave it implied.
- **Texas Disciplinary Rule 1.01** (competence) and **ABA Formal Opinion 512** (2024, on generative AI) both impose an ongoing duty on the firm's attorneys to understand, at a functional level, what the tool does and doesn't do — the agreement should commit the company to providing plain-language documentation of the classifier's behavior and known limitations (satisfying `c2` §4's framing that this should be "easy to satisfy rather than something firms have to independently research"), while making clear that reading it and acting on it is the firm's obligation, not a box the vendor can check on the firm's behalf.
- **Opinion 512's informed-consent point** (also flagged in `c2` §4) — that standard engagement-letter boilerplate is not sufficient informed consent for using client confidences in a GAI tool — means the firm needs client-specific, AI-aware consent language of its own. Section 4.6 below is where this document proposes the model language the firm agreement should commit the company to supplying.
- The agreement should require the firm to designate a supervising attorney responsible for reviewing the intake flow's scripted language and any firm-specific configuration (`firm-config.yaml`) before it goes live for that firm — an operational hook the product doesn't currently enforce technically (there is no "config approved by" field in the `c19` data model), which is worth flagging back to that card as a possible follow-up rather than solved here.

None of this should be read as the vendor disclaiming its own responsibilities (Sections 3.5–3.9 cover those) — it is establishing that ethical/regulatory compliance in how the *firm* uses the tool with *its* clients is the firm's obligation, layered on top of, not instead of, the vendor's own security and product commitments.

### 3.3 Scope of the subscription

Per `c29`'s pricing hypothesis: a **per-firm** (not per-seat) subscription, at a tier sized to a band of monthly intake volume, with metered overage beyond the included volume, sold with a time-boxed full-featured trial rather than a permanent free tier. The agreement should define "intake" precisely (a started `intake_sessions` row, per the `c19` data model, not merely a widget page-load) since that's the billing unit, and should state that the firm's authorized users are its own attorneys and staff, not a fixed headcount — consistent with the per-firm model's whole rationale in `c29` §4 of not penalizing a firm for growing its team.

The license should be explicitly non-exclusive and non-transferable, scoped to the firm's own intake for its own clients — tying directly back to `c17` §5's scope boundary that this is "one firm's own intake, not a multi-firm referral or matching service." A firm attempting to use the product to route inquiries to other, unaffiliated firms would not just be misusing the product commercially; per `c1` §5, it would risk pulling the *firm* into Texas's lawyer-referral-service licensing regime (Occupations Code Chapter 952) without the nonprofit/governmental certification that regime requires. The agreement's permitted-use clause should say this plainly, both to protect the vendor contractually and because a firm considering that use case needs to know it's a legal problem, not just a contract violation.

### 3.4 Fee structure, and a fee-splitting caution specific to this product

`c29`'s recommended pricing shape — a per-firm base fee plus metered per-intake overage — was chosen partly *because* it avoids the lead-generation/revenue-share models that `c1` §5 already ruled out for Texas (those models risk being read as unlicensed lawyer-referral-service activity). This section flags a second, independent reason the same pricing shape matters, one none of the upstream documents examined yet: **ABA Model Rule 5.4 and its Texas analog, Rule 5.04(a), prohibit a lawyer from sharing legal fees with a non-lawyer**, subject to narrow exceptions (estate payments to a deceased lawyer's estate, buyouts of a deceased/disabled lawyer's practice, and retirement-plan payments to non-lawyer employees — none of which apply here).

A flat or tiered software subscription, and a per-intake metered fee tied to *usage of the software* (volume of intakes processed), is a conventional software-licensing fee, not a share of the firm's legal fees, and sits comfortably outside Rule 5.04(a)'s prohibition — this is the same reasoning that lets practice-management and legal-CRM vendors (Clio, Lawmatics, and the rest of `c15`'s comparison set) charge law firms at all. The risk would arise from a *different* pricing structure this product is not currently planning to use: **any fee that scales with the legal fee the firm ultimately earns from a matter** (a percentage of the fee collected, a bonus tied to a matter converting to a paying engagement) would look much more like the kind of arrangement Rule 5.04(a) exists to prevent, because it ties the vendor's compensation to the outcome and value of the legal representation itself rather than to the vendor's own service. **Recommendation: the agreement's fee clause should affirmatively state that all fees are compensation for software-as-a-service usage, calculated solely by intake volume and subscription tier, and are in no way calculated as a percentage of, or contingent upon, any legal fee earned by the firm on any matter.** This is a contract-drafting recommendation, not a settled legal conclusion — flagged in §8 for attorney confirmation, since the line between "usage-based SaaS pricing" and "fee splitting" has not been tested against a product shaped exactly like this one in the research performed for this document.

### 3.5 Data processing, confidentiality, and the DPA hand-off

This section of the agreement should not attempt to fully restate `c2`'s data privacy and retention policy inline — it should incorporate it by reference and commit to executing the **data processing addendum (DPA)** that `c2` §8 already flagged as "very likely a required contractual artifact." Specifically, the MSA should:

- State the company's role (processor/service provider, acting on the firm's instructions as controller/business) consistent with `c2` §3's recommended framing, while flagging — as `c2` §3 itself does — that this allocation is an open question for attorney review, not a settled fact this document can assert on its own.
- Commit contractually to the encryption, access-control, and break-glass-access practices `c9` already specified as requirements (TLS 1.3, encryption at rest, no standing cross-tenant access, audited break-glass access) — turning `c9`'s engineering recommendations into commitments the firm can actually rely on and enforce.
- Commit to the retention floor `c2` §6 recommends (tied to the firm's own configured matter-retention period, with a legal-hold override) and to honoring data subject rights requests within the SLA `c2` §7 proposes (recommended: 15 business days for the company's response to the firm, inside the 45-day statutory outer bound most state privacy laws impose on the firm itself).
- Require the company to maintain and disclose a subprocessor list (per `c2` §8), including the eventual LLM vendor once `c18`'s ADR-0001 D9 gate is satisfied, and commit to flowing down equivalent data-handling obligations to every subprocessor on that list.
- Include mutual confidentiality obligations — the firm's own matter and client information is confidential to the company just as the company's business information is confidential to the firm — with an express carve-out that nothing in this section limits either party's independent legal obligations (the firm's professional-responsibility duties, the company's statutory breach-notification duties).

### 3.6 AI / model-vendor representations that flow through to the firm

Because firms are relying on the company's vendor diligence to satisfy their own Rule 1.6(c)/Rule 1.05 obligations (the exact point `c2` §4 makes about cloud-computing ethics opinions generally), the agreement should make ADR-0001 D9's gate a contractual commitment, not just an internal engineering control: **the company represents that its model vendor's terms prohibit training on submitted data, define a documented (and disclosed) retention window, and are covered by a signed data processing agreement between the company and that vendor**, and that the company will notify subscribing firms before making a model-vendor change that would alter any of those representations. This is a place where the contract should be *more* conservative than the underlying engineering control — D9's gate currently blocks real client data until these terms are verified, which is correct, but the contract should commit to maintaining that posture on an ongoing basis, not just at initial vendor selection.

### 3.7 Warranty disclaimers

Standard SaaS "AS IS" / "AS AVAILABLE" disclaimers apply, with one addition specific to this product category: **the agreement should explicitly disclaim any warranty that use of the product satisfies the firm's own unauthorized-practice-of-law, data-privacy, or professional-responsibility obligations in the firm's jurisdiction.** This is not the company hedging generically — it is the direct contractual expression of `c1`'s and `c2`'s repeated finding that compliance in any given jurisdiction requires that jurisdiction's own legal review (the Texas review doesn't generalize; `c28`'s eventual additional states each need their own pass). A firm operating in a state this product's compliance research hasn't yet covered should not be able to read the contract as an implicit representation that the product is compliant there — the warranty disclaimer is where that gets said affirmatively rather than left to silence.

The agreement should also disclaim any warranty regarding the accuracy of the triage classifier's output, consistent with `c13`'s own design spec treating classifier confidence as advisory, not authoritative — the firm's staff, not the classifier, make the actual intake decision.

### 3.8 Limitation of liability

Recommended structure, consistent with prevailing commercial SaaS market practice for a company at this stage (a solo-founder, pre-revenue product, per ADR-0001's own constraints):

- **A liability cap** set at fees paid by the firm in the 12 months preceding the claim — the standard SaaS market convention, and proportionate to a subscription-fee-sized transaction rather than to the scale of harm a data breach or a failed conflict check could theoretically cause.
- **Mutual exclusion of indirect, consequential, and punitive damages.**
- **Carve-outs from the cap** for: breach of confidentiality obligations (Section 3.5), each party's indemnification obligations (Section 3.9), and gross negligence or willful misconduct — standard carve-outs, not something specific to this product.
- **An explicit statement that the cap does not limit either party's ability to seek injunctive relief** for actual or threatened breach of confidentiality or data-security obligations, since monetary damages are a poor remedy for an active data leak in progress.

One point worth flagging rather than resolving here: a liability cap sized to subscription fees is standard for ordinary SaaS, but this product's failure modes (a missed conflict check resulting in a firm representing an adverse party, a data breach of privileged client information) have a plausibly much larger real-world cost than a typical SaaS outage. Counsel and the founder should weigh whether a standard cap is the right call at this stage versus, e.g., a higher cap or specific carve-outs for conflict-check and data-breach scenarios — this document recommends the market-standard structure as the default, not as the only defensible option.

### 3.9 Indemnification

Recommended as mutual, with different triggers for each side:

- **The firm indemnifies the company** against claims arising from: the firm's own use of the product in violation of the agreement's permitted-use restrictions (Section 3.3); the firm's failure to meet its supervisory and ethical-compliance obligations (Section 3.2); and claims by the firm's own clients or prospective clients arising from the firm's practice of law or its decisions based on the product's output (since those decisions are, and must remain, the firm's own).
- **The company indemnifies the firm** against third-party intellectual-property infringement claims arising from the firm's authorized use of the product, and against claims arising from the company's own breach of its data-security or confidentiality commitments (Section 3.5).

This mirrors `c1` §8's own flagged open question — "should contractual terms with deploying firms include an indemnification or acknowledgment that the firm, not the vendor, is responsible for supervising the tool's use" — by answering it structurally (yes, via the mutual indemnification split above) while leaving the exact drafting to counsel.

### 3.10 Term, termination, and data export/deletion

The agreement should specify a defined post-termination window during which the firm can export its data (recommend 30 days, a common SaaS convention, long enough for a small firm to complete an export without dedicated IT staff), after which the company deletes the firm's data per `c2`'s retention schedule — subject to any legal-hold flags per `c2` §6 and `c6` §4's retention-floor recommendation, which should survive contract termination rather than being wiped by it (a terminated firm's malpractice-defense need for its own historical audit trail doesn't disappear when the subscription ends). The company should also commit to a reasonable off-boarding assistance period, consistent with the firm's own bar-imposed file-retention obligations continuing to run against records that may now need to live elsewhere.

### 3.11 Governing law and venue

Recommend Texas law and Texas venue, consistent with the company's own current jurisdictional footprint and its HQ/founder location — this is a standard vendor-favorable term (litigating close to home) rather than something with special legal-product significance, and should be revisited only if the company's own domicile changes, not each time `c28` adds a new client-facing launch state (client-facing launch state and vendor-contract governing law are independent choices).

### 3.12 Changes to terms

Standard notice-and-continued-use provisions, with one addition: **material changes to the AI/model-vendor representations in Section 3.6, or to the data-processing terms in Section 3.5, should require affirmative notice with a defined advance period (recommend 30 days)** rather than being bundled into routine terms-of-service updates — because those two sections are exactly what firms are relying on to satisfy their own ethics obligations, and a firm's attorneys need real notice to re-assess their own compliance if the underlying facts change.

## 4. The end-user (prospective client) facing disclosures

This is the layer `c23`'s chat widget actually renders, and it needs to work without anyone having read a contract — everything here should be visible in the conversation itself, not buried behind a link.

### 4.1 The core "not a substitute for an attorney" disclosure

`c1` §7 already specified this precisely for Texas: the § 81.101(c) disclosure needs to be clear and conspicuous, and needs to appear before or at the very start of intake, because it is the specific statutory condition Texas attaches to the software/forms safe harbor the product's Texas posture most plausibly relies on. This document adopts that as the *default baseline disclosure for every jurisdiction*, not a Texas-only feature: even in a state without an identical statutory safe harbor, disclosing plainly that the tool is not a lawyer and does not provide legal advice is good practice and reduces exposure under general consumer-protection and UPL principles that exist in some form in every state. Recommended baseline language (subject to the firm's own attorney review per `c1` §7's own note that scripted language needs sign-off before real use):

> *"This chat is an automated intake tool, not a lawyer. It cannot give you legal advice, and nothing it says should be treated as legal advice. It is not a substitute for consulting with an attorney about your situation."*

### 4.2 Disclosure that the user is interacting with an automated system

Separately from the "not legal advice" disclosure, the user should be told plainly they are talking to software, not a person. Two independent reasons support this as a baseline default rather than an optional nicety:

- **It is the direct predicate for the § 81.101(c) analysis in 4.1** — a disclosure that the *tool* isn't a substitute for an attorney is strengthened, not weakened, by making clear the user understands they're talking to a tool at all.
- **A cluster of state laws enacted or taking effect in 2025–2027 specifically mandate this for conversational AI**, though their direct applicability here is limited and shouldn't be overstated: California SB 243 (effective January 1, 2026) requires disclosure of non-human status for "companion chatbots" — a category defined around simulating a relationship or companionship, which this product's fact-gathering intake flow is not designed to do, so SB 243 likely does not squarely apply, but the direction of travel across states (Washington, New York, Oregon, and others enacting similar disclosure-of-non-human-status requirements for conversational AI on a similar timeline) is a strong signal that "tell the user they're talking to a bot" is becoming baseline regulatory expectation for AI chat products generally, independent of whether this specific product falls inside any one statute's current definition. Separately, **California's existing Bot Disclosure Law (Bus. & Prof. Code § 17941, in effect since 2019)** requires disclosure when a bot is used with intent to mislead a person into thinking they're interacting with a human, specifically in a communication intended to incentivize a sale or purchase of goods or services — a legal-intake chat that could be read as encouraging someone toward retaining the firm's paid services plausibly falls within that framing for any California-resident user, which is a second, more direct reason (beyond general best practice) to make this disclosure unconditional rather than state-gated.

Recommended baseline language:

> *"You're chatting with an automated system, not a person. A member of \[Firm Name\]'s staff will follow up with you directly."*

### 4.3 No attorney-client relationship formed by this conversation

Building on Section 3.1's firm-agreement framing and `c1` §7's "route, don't decide" principle: the end-user disclosure should state plainly that submitting information through the chat does not create an attorney-client relationship, and that a relationship forms only if and when the firm affirmatively agrees to represent the person (consistent with how `c17` §3 defines the flow's terminal dispositions — several of the ten outcomes are explicitly *not* an engagement). This protects the firm (avoids an inadvertent-representation argument) and sets accurate expectations for the prospective client, and it is standard language across the legal-intake competitive set `c15` reviewed.

> *"Submitting this information does not create an attorney-client relationship. \[Firm Name\] will only represent you if and when you and the firm both agree to that in writing."*

### 4.4 Privacy notice and data-handling pointer

A short, plain-language pointer to how the submitted information will be used and retained, linking to (or summarizing) the firm's privacy notice — which, per `c2` §7, should itself be built around the retention and data-subject-rights framework `c2` recommends. This does not need to restate `c2` in full inside the chat widget; it needs to exist and be genuinely reachable, not a dead link.

### 4.5 Not for urgent or emergency matters

Consistent with the product's inbound-only, non-time-sensitive design (`c1` §4's barratry-driven caution against anything that looks like urgent outreach, and the practical reality that a chat-based intake tool cannot guarantee a response time), the disclosure block should tell users plainly not to rely on this tool for anything urgent, and to contact the firm directly (or, where relevant, emergency services) if their situation is time-sensitive. This is both a liability-reducing disclosure and a genuine safety point — a chat form is not the right channel for someone who needs help today.

> *"If your situation is urgent or time-sensitive, please call our office directly rather than waiting for a response here."*

### 4.6 Model AI-consent language for firms (the `c2` §4 hand-off)

`c2` §4 asked this document to supply model consent/disclosure language firms can adapt for their own clients, satisfying ABA Formal Opinion 512's requirement that informed consent to GAI processing be specific rather than generic boilerplate. Because Opinion 512's consent requirement is framed around a lawyer's *own client's* confidences going into a GAI tool, and this widget primarily talks to *prospective* clients (a distinct, if related, category — see `c2` §5's discussion of privilege at the pre-engagement stage), the recommended approach is a layered one:

- **At the intake stage** (before engagement), Sections 4.1–4.2's disclosures serve the functional purpose of informed awareness, even though the person is not yet a "client" in Opinion 512's strict sense.
- **At the point a firm actually engages a prospective client** (i.e., the matter converts), the firm should separately and specifically disclose, as part of its own engagement process, that the firm uses an AI-assisted intake and triage tool, naming the tool by category (not necessarily by vendor name) and describing in plain terms what it does and doesn't do — consistent with Opinion 512's "specific enough that the client understands" standard. Recommended model language for the firm's own engagement materials:

> *"As part of our intake process, \[Firm Name\] uses an AI-assisted software tool to help collect and organize the information you provide and to help our staff route your inquiry appropriately. The tool does not make legal decisions or give legal advice — every decision about your matter is made by our attorneys. If you have questions about how this tool works or how your information is handled, please ask us."*

This is model language for the firm to adapt, not language the vendor publishes on the firm's behalf — the firm's own attorney is the one satisfying their own Rule 1.6(c)/Opinion 512 obligation, and the agreement (Section 3.2) should be clear that supplying this template discharges the vendor's obligation to make compliance easy, not the firm's obligation to actually use it.

## 5. How this connects to the human-in-the-loop design principle

Every liability-reducing structure in this document ultimately rests on the same underlying design fact, established well before this card: the product is built so that no automated component makes a final decision that affects a prospective client's legal position. `c17` §5 states it as a scope boundary ("human-in-the-loop, not autonomous decisioning"); `c1` §7 states it as a compliance requirement ("route, don't decide"); `c13`'s classifier spec hard-codes `safetyFlag` conservatively rather than resolving it automatically. The terms of service and disclosures recommended here are the contractual and public-facing expression of that same principle — they work *because* the product is actually built that way, not despite it. If a future feature ever crosses that line (the classifier starts surfacing a confidence-scored legal conclusion to the end user, for instance, rather than routing it internally), this document's liability allocation would need to be revisited alongside the product change, not treated as a static document that absorbs any future feature unchanged.

## 6. What this document does not decide

- **No final contract language.** Everything above is structure and recommended content for counsel to draft into an actual, enforceable agreement — none of it should be published or presented to a firm as-is.
- **No resolution of the controller/processor role allocation** `c2` §3 already flagged as open — Section 3.5 assumes a resolution consistent with `c2`'s recommendation but does not resolve it independently.
- **No specific liability-cap dollar figure or trial length/pricing numbers** — those depend on `c7`'s fuller pricing and packaging work and, per `c29` §5, on real pilot-firm conversations (`c30`) this automation cannot conduct.
- **No confirmation of the exact current Texas Rule 5.04/5.05 citations** used above, beyond the public secondary sources checked in this research pass — flagged in §8, same as the numbering correction this document made to `c1`'s original "5.5(b)" citation.
- **No state other than Texas is analyzed in depth.** Like `c1` and `c2`, this document's Texas-specific citations (Rule 5.04, Rule 5.05, § 81.101(c)) do not generalize; the firm-facing MSA content in Section 3 is largely jurisdiction-agnostic by design, but the end-user disclosure content in Section 4 should be re-verified against each state `c28` eventually adds.

## 7. Open questions for attorney review

1. **Fee-splitting analysis (§3.4).** Whether the recommended per-firm-plus-usage pricing structure is actually clear of Texas Rule 5.04(a) (and the equivalent rule in any other state a firm operates in), and whether the recommended contractual representation ("fees are not calculated as a percentage of or contingent on legal fees earned") is sufficient, or whether additional structural safeguards are needed.
2. **Rule citation corrections.** This document corrects `c1`'s PR description's citation of "Texas Disciplinary Rule of Professional Conduct 5.5(b)" to Rule 5.05(b), based on the Texas Center for Legal Ethics' current rule index (Rule 5.05, "Unauthorized Practice of Law; Remote Practice of Law"). This correction itself needs attorney confirmation, and `c1`'s document should be corrected to match if confirmed.
3. **Liability cap sizing (§3.8).** Whether a standard SaaS fee-based liability cap is appropriate given this product's failure modes (missed conflicts, privileged-data breaches) plausibly carry harm disproportionate to subscription fees, or whether a different structure (higher cap, specific carve-outs, insurance-backed indemnity) is warranted at this stage.
4. **SB 1001 / Bus. & Prof. Code § 17941 applicability (§4.2).** Whether California's existing bot-disclosure law plausibly applies to this product's chat widget for California-resident users, and whether the recommended disclosure (§4.2) is sufficient to satisfy it if so — this document treats it as a reason for caution, not a settled applicability finding.
5. **Pre-engagement privilege and consent layering (§4.6).** Whether the two-layer approach recommended here (baseline chat disclosures pre-engagement; firm-supplied Opinion 512 consent language at actual engagement) is the right way to satisfy Opinion 512 given the genuine gray zone `c2` §5 already identified around when privilege attaches to a pre-engagement conversation.
6. **Whether a standalone "AI Disclosure" or "How We Use AI" public page** (referenced as a possibility in `c2` §4) should be a required deliverable alongside the in-widget disclosures, or whether the in-widget language plus the firm's own engagement-stage disclosure (§4.6) is sufficient.
7. **Indemnification carve-out for conflict-check failures specifically** — whether a missed or incorrect conflict-check result (a `c3` engineering failure, not a firm supervisory failure) should sit inside the company's indemnification obligations in §3.9 given how central that feature is to the product's value proposition, or whether it's properly covered by the general liability-cap/warranty-disclaimer structure in §3.7–3.8.

## Sources

- [Texas Government Code § 81.101 — Definition of "practice of law," including the software/products exception](https://law.justia.com/codes/texas/government-code/title-2/subtitle-g/chapter-81/subchapter-g/section-81-101/) (previously cited in `c1`; re-cited here for the §4.1 disclosure requirement)
- [Texas Occupations Code Chapter 952 — Lawyer Referral Services](https://law.justia.com/codes/texas/2015/occupations-code/title-5/subtitle-b/chapter-952/) (previously cited in `c1`; re-cited here for §3.3's permitted-use clause)
- [Texas Center for Legal Ethics — Professional Independence of a Lawyer (Rule 5.04)](https://www.legalethicstexas.com/resources/rules/texas-disciplinary-rules-of-professional-conduct/professional-independence-of-a-lawyer/)
- [Texas Center for Legal Ethics — Texas Disciplinary Rules of Professional Conduct (rule index, confirming Rule 5.05's number and title)](https://www.legalethicstexas.com/resources/rules/texas-disciplinary-rules-of-professional-conduct/)
- [Texas Bar Blog — Ethical AI Integration for Texas Attorneys: A Practical Guide to Confidentiality, Data Privacy, and Export Controls](https://blog.texasbar.com/2025/08/articles/guest-blog/ethical-ai-integration-for-texas-attorneys-a-practical-guide-to-confidentiality-data-privacy-and-export-controls/) — confirms Rule 1.05 (confidentiality) and Rule 1.01 (competence) remain the current rule numbers post the March 2025 amendments, and their application to AI-vendor vetting and client disclosure.
- ABA Formal Opinion 512 (July 2024), generative AI — as previously cited and summarized in `c2` and `c9`; not re-fetched independently for this document, cross-referenced for consistency.
- [California SB 243 — companion chatbot disclosure requirements, effective January 1, 2026](https://www.orrick.com/en/Insights/2026/04/2026-State-Chatbot-Laws-Key-Provisions-and-Regulatory-Trends) (Orrick summary of 2026 state chatbot laws, used for §4.2's survey of the regulatory direction of travel)
- [California Business & Professions Code § 17941 — Bot disclosure ("B.O.T. Law," SB 1001, in effect since July 2019)](https://law.justia.com/codes/california/code-bpc/division-7/part-3/chapter-6/section-17941/)
- [California's BOT Disclosure Law, SB 1001, Now In Effect — National Law Review](https://natlawreview.com/article/california-s-bot-disclosure-law-sb-1001-now-effect)
- `docs/compliance/upl-compliance-review.md` (`c1`) — §7's disclosure and "route, don't decide" design guardrails, adapted here into contractual and cross-jurisdictional form.
- `docs/compliance/data-privacy-retention-policy.md` (`c2`) — §§3–4, 7–8, the DPA, consent-language, and controller/processor hand-offs this document resolves.
- `docs/security/encryption-access-control-review.md` (`c9`) — §§3–4, the technical commitments Section 3.5 turns into contract language.
- `docs/architecture/audit-log-compliance-trail.md` (`c6`) — §4, the retention-floor logic Section 3.10 extends past contract termination.
- `docs/architecture/adr/0001-initial-technology-stack.md` (`c18`), D9 — the model-vendor gate Section 3.6 turns into an ongoing contractual representation.
- `docs/product/scope-and-problem-statement.md` (`c17`) — §§3, 5, the ten-disposition flow and scope boundaries this document's end-user disclosures and permitted-use clause build on.
- `docs/go-to-market/pricing-hypothesis.md` (`c29`) — the per-firm-plus-usage pricing shape Section 3.3–3.4 formalizes contractually.

---

*This document is a research draft prepared to inform contract drafting and product decisions. It is not legal advice, is not a contract, and creates no attorney-client relationship. A licensed attorney — competent in both legal-professional-responsibility law and commercial/SaaS contracting — must review and revise this material, particularly §§3.4, 3.8, 4.2, and the open questions in §7, before any of it is published, presented to a prospective firm, or relied upon operationally.*
