# Pricing Hypothesis — Direction, Not a Final Number

**Status:** Founder decision brief for board card `c29`, prepared at Clayton's direct request. This fixes a *shape* — pricing model and who gets sold to first — not final price points. Per the card's own framing, it is a direction to adopt or override, not a locked contract.
**Feeds:** `c7` (pricing & packaging model — the fuller deliverable this hypothesis unblocks), `docs/go-to-market/competitive-landscape-scan` (`c15`, referenced below).
**Still needed before `c7` can finalize actual numbers:** real conversations with pilot firms (`c30`, still outstanding, and unavoidably Clayton's own task).

## 1. The structural constraint that decides more than it looks like it should

`c1`'s UPL compliance review already forecloses one entire business model for this product's Texas launch: Texas Occupations Code Chapter 952 restricts lawyer-referral-service certification to nonprofit or governmental entities. A for-profit company cannot itself operate as a multi-firm matching/referral service in Texas without a separate corporate structure. That single finding fixes the shape of monetization before pricing is even discussed: **this is a tool a firm licenses for its own intake, not a marketplace that gets paid per lead routed across firms.** That rules out lead-gen-style pricing (pay per qualified lead, revenue share on retained matters) as the primary model — not because it's a bad idea commercially, but because it's the model most likely to collide with Chapter 952's eligibility bar if the product ever behaves like routing between unrelated firms rather than serving one firm's own intake. `c7` should treat this as settled, not re-litigate it.

That leaves standard B2B SaaS pricing shapes: per-seat, per-firm/flat, or usage-based (by intake volume) — the three the card itself named.

## 2. What the competitive set actually reveals

`c15`'s scan named four comparables. Re-checked against current information, the pattern across them is itself a data point:

- **Clio Grow** is not sold standalone — it's bundled free into Clio's top ("Elite") practice-management tier, or available as a custom-priced add-on to the two mid tiers, with Clio Manage itself starting around $49/user/month at the entry tier and climbing to "contact sales" for anything with Grow attached. **Clio Grow's pricing has effectively been decided by a different product's tier structure, not by intake-CRM value on its own.**
- **Lawmatics** publishes no public pricing at all across any of its four tiers — every plan is "contact sales."
- **Intaker** publishes no public pricing — demo required.
- **Smith.ai** is the outlier: fully public, tiered by call volume — Starter at $300/mo for 30 calls, Basic $810/mo for 90, Pro $2,100/mo for 300, with per-call overage that gets cheaper per tier ($11.50 → $10.50 → $8.50), plus per-call add-ons (booking, SMS, transcription).

Three of four comparable products hide pricing behind a sales conversation. That's a real signal about how this category is typically sold — as a considered, higher-touch B2B purchase, not a self-serve checkout flow — but it's also a signal about where a gap sits: it means the segment likely to want simple, comparison-shoppable pricing (a solo practitioner or small firm, deciding without a procurement process) is underserved by the incumbents' own go-to-market, not just by their feature sets. Smith.ai's transparency is aimed at exactly that segment and its volume-tiered structure is worth borrowing the *shape* of, even though Smith.ai is a live-human-receptionist product solving a different problem (call answering, not compliance-postured AI intake) and isn't really pricing for the same value.

## 3. Who to sell to first

**Recommendation: solo practitioners and small firms (roughly 1–10 attorneys), not mid-size or enterprise firms, for the initial go-to-market.** Four independent reasons converge on this, not one:

- **The product as spec'd fits this segment's actual workflow.** `c12`'s intake-flow spec is a generic, configurable graph built around a single firm's own practice areas and staff roles — exactly the shape of a solo/small firm's real intake process (per the reference SOP material), and comparatively over-built for a large firm that likely already has dedicated intake staff, a practice-management deployment, and its own bespoke workflows that a generic tool would need heavy customization to match.
- **The sales motion matches the product's current maturity.** ADR-0001 commits to "weeks, not months, to something demonstrable," a single-founder build, and — per constraint 7 — a product that sits alongside a firm's existing CRM rather than replacing it. That's a self-serve-or-lightly-assisted sale, which solo/small firms can complete without a procurement cycle; the "contact sales" incumbents above are optimized for exactly the longer, higher-touch enterprise sale this product isn't yet resourced to run.
- **The incumbents' own pricing structure leaves this segment underserved.** Clio Grow isn't buyable on its own below Clio's top tier; Lawmatics and Intaker require a sales conversation for any price at all. A solo practitioner evaluating options today gets friction from the exact products that would otherwise compete directly.
- **`c2`'s "sits alongside, doesn't replace the CRM" framing lowers the switching cost for this segment specifically.** A small firm that already has a lightweight CRM (or none at all) can adopt this product without ripping anything out — the harder sell (integrating into an existing large firm's established practice-management deployment) is deferred to later, once `c5`'s integration layer actually exists.

This is explicitly a sequencing call, not a ceiling — nothing here says the product can't move upmarket once `c5` (PM-tool integrations) and a real security/compliance track record exist. It says where to start.

## 4. The pricing model: per-firm base plus usage tier, not per-seat and not pure usage

**Recommendation: a per-firm (not per-seat) base subscription, with intake-volume tiers and metered overage above the included volume** — structurally closer to Smith.ai's shape than to Clio's per-user model, for reasons specific to this segment and this product:

- **Per-seat pricing actively penalizes the target segment.** A solo practitioner's or small firm's "seats" touching intake are often 1–3 people (the attorney, maybe a paralegal or receptionist), so a per-seat model either prices absurdly low (undervaluing the product) or forces an awkward seat-counting conversation for a two-person office. Worse, it creates friction exactly when a firm grows — adding a receptionist or an associate shouldn't feel like a price hike on the tool that's helping the firm handle more intake, which is the moment the product is proving its value.
- **Pure usage-based pricing is the wrong fit for a budget-conscious, non-technical buyer.** Solo/small-firm software buyers strongly prefer predictable monthly spend over metered billing they can't easily forecast — and because intake volume tracks a firm's marketing spend more than its size, a purely usage-based model makes the tool's own cost move in a direction the firm doesn't fully control, which is a bad trait for a product asking this segment to trust it with its intake pipeline.
- **A firm-tier-plus-overage model gets the predictability of per-firm pricing with the fairness of usage-based pricing at the margin**, the same trade-off Smith.ai already validated in a directly comparable service (call/lead volume as the metered unit). Concretely: a base monthly fee covers a set number of intakes per month (sized to typical solo/small-firm intake volume), with clearly-priced overage per intake beyond that — not a hard cutoff, so a firm never loses leads because it hit a cap mid-month.

**On a free tier — recommend a full-featured trial, not a permanent free tier.** The product's differentiator is its compliance posture (UPL guardrails, tenant isolation, audit trail) — none of which gets cheaper to run at zero revenue, and a curious solo practitioner needs to actually experience that posture (the confirmed-classification flow, the conflict-check behavior, the referral routing) before a price point means anything to them. A time-boxed trial (comparable to Smith.ai's 30-day money-back framing, though structured as a trial rather than a refund guarantee) gives that experience without the ongoing cost of hosting matters that never convert to paying firms. This document does not recommend a specific trial length or included-intake count — those are exactly the numbers `c30`'s pilot-firm conversations should calibrate, not something to fix from competitive research alone.

## 5. What this hypothesis deliberately does not fix

Consistent with the card's own note ("not a final number — a direction"), this document fixes the *shape* — per-firm-plus-usage, solo/small-firm-first, trial-not-free — and leaves the actual numbers open, because they need something this research pass cannot substitute for: **a real conversation with a real firm about what they currently pay for intake-adjacent tools (a CRM, an answering service, sometimes both) and what a compliance-postured AI alternative would be worth to them.** That is squarely `c30`'s job, and it remains a founder task for the reason the board already states — outreach and real conversations aren't something this automation can do on Clayton's behalf. `c7` should treat the shape here as settled enough to build a packaging structure around, while leaving the literal dollar figures as placeholders pending `c30`.

## Sources

- `docs/compliance/upl-compliance-review.md` (`c1`) — §5, Texas Occupations Code Chapter 952's nonprofit/governmental eligibility requirement for lawyer referral services, which forecloses a for-profit multi-firm routing/lead-gen pricing model in Texas.
- [Clio Legal AI Software Pricing & Plans](https://www.clio.com/pricing/) — Clio Manage tier pricing and Clio Grow's bundled/add-on-only availability.
- [Lawmatics Pricing Plans & History — PricingSaaS](https://pricingsaas.com/companies/lawmatics) — confirms no public pricing across any Lawmatics tier.
- [Intaker Pricing — LawNext Directory](https://directory.lawnext.com/products/intaker/pricing/) — confirms demo-required, no public pricing.
- [Smith.ai Plans & Pricing for 24/7 Sales & Support](https://smith.ai/pricing/receptionists) — current tiered call-volume pricing and per-call overage structure used as this document's structural reference point.
- ADR-0001 (`docs/architecture/adr/0001-initial-technology-stack.md`) — constraint 7 ("sits alongside the firm's CRM, doesn't replace it") and the "weeks not months, one founder" build constraints informing the go-to-market sequencing in §3.
- `docs/product/spec/intake-flow.yaml` and `question-bank.yaml` (`c12`) — the generic, configurable intake shape this document argues fits the solo/small-firm segment particularly well.

## Review notes

This is a decision brief, not a neutral survey — it takes a clear position because that's what was asked for. The place most worth pushing back if the direction feels wrong: §3's solo/small-firm-first call assumes the product's current maturity (single founder, weeks-not-months build) should drive go-to-market sequencing as much as market size does. If the intent is to skip straight to larger firms regardless of sales-motion fit, that changes §4's pricing shape too — enterprise buyers are far more tolerant of, and often prefer, per-seat pricing with a real sales process behind it.
