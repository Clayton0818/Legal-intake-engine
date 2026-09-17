# Multi-Tenant Architecture & Data Isolation

**Board card:** `c8` | **Status:** Research and recommended approach — not a final architecture decision | **Date:** 2026-09-04

## Status

This document is engineering research and a recommended approach, prepared for review by Clayton and, before anything ships, by whoever owns security/architecture sign-off. It sets **isolation requirements** that the eventual technology-stack ADR (`c18`) and data model (`c19`) must satisfy — it does not itself pick a stack, and nothing here should be read as a final architectural commitment. Two sections below (data handling and AI/vendor practices) intersect with attorney-client privilege and professional-responsibility rules; those points are flagged for the same attorney review already required for `c1` and `c2`, not resolved here.

## 1. Why this card is unusually high-stakes for this product

Most multi-tenant SaaS isolation failures leak a competitor's customer list or a support ticket. A failure here leaks a prospective client's account of a car accident, a custody dispute, or a workplace injury — across law firms that may be adverse to each other, or even opposing counsel in the same matter. Three things make the bar higher than a typical B2B SaaS:

- **Attorney-client privilege and confidentiality (Model Rule 1.6)** attach to intake conversations even before a matter is opened in many jurisdictions, and firms using this product remain the parties responsible for protecting that confidentiality — the platform is a vendor they are trusting with privileged and sensitive material, not just PII. `c2` (data privacy & retention) already surveys the two overlapping regulatory layers — consumer privacy law and professional-responsibility/privilege — and flags multi-tenant data leakage as a hand-off to this card.
- **Cross-tenant leakage through the AI layer, not just the database.** ABA Formal Opinion 512 (July 2024) singles out self-learning generative AI tools by name: information relating to one client's matter "may be disclosed improperly... [and] resurface when the tool responds to prompts" for a different client, even within the same firm — and this product's tenants are *different firms*, which is a strictly worse failure mode. A conflict-check or triage classifier that inadvertently lets Firm A's model context, embeddings, or fine-tuning data influence Firm B's session is a confidentiality breach, not a bug ticket. ([Zuva: ABA Formal Opinion 512](https://zuva.ai/blog/aba-formal-opinion-512/))
- **Firms are themselves competitors, and sometimes adverse parties.** Two law firms on the platform may represent opposing sides of the same litigation. This is a stronger requirement than "tenant A can't see tenant B's data" — it means the platform itself must never become a channel that links two firms' matters together (e.g., via shared conflict-check indexes, shared vector stores, or support tooling that shows one firm's data to an engineer debugging another firm's issue).

Everything below should be read against that bar, not against a generic SaaS bar.

## 2. The isolation model spectrum

There is no single "multi-tenant architecture" — isolation is a spectrum, and different resources within the same product can sit at different points on it. AWS's SaaS tenant-isolation whitepaper frames three reference models:

| Model | What it means | Isolation guarantee | Cost/ops profile |
|---|---|---|---|
| **Silo** | Each tenant gets dedicated infrastructure — separate DB instance, separate compute, separate backups | Physical/absolute — a cross-tenant breach is architecturally impossible, not just policy-prevented | 10–100x higher per-tenant cost; operational overhead scales roughly linearly with tenant count |
| **Pool** | All tenants share the same tables/compute; every row is tagged with a `tenant_id` and every query filters on it | Logical only — enforced entirely by application code and/or database policy, not infrastructure boundaries | Cheapest, most operationally simple; "one runaway query or one missed filter affects everyone" |
| **Bridge** | A hybrid — different layers or tenant tiers use different models (e.g., shared web tier + siloed storage tier, or shared DB instance + schema-per-tenant) | Mixed, chosen per component | More design/ops complexity, but lets you spend isolation budget where it matters most |

Sources: [AWS — Pool Isolation](https://docs.aws.amazon.com/whitepapers/latest/saas-tenant-isolation-strategies/pool-isolation.html), [AWS — The Bridge Model](https://docs.aws.amazon.com/whitepapers/latest/saas-tenant-isolation-strategies/the-bridge-model.html), [The HLD Handbook — Multi-Tenancy](https://hld.handbook.academy/curriculum/architecture-patterns/multi-tenancy/)

AWS's own framing of the pool model is worth quoting directly, because it's the one most founders get backwards: sharing infrastructure is *not* a reason to relax isolation controls — it's the opposite. "Even though this is a more challenging environment to isolation... you cannot use this as a rationale to relax the isolation requirements of your environment. If anything, these shared models increase the chance for cross-tenant access... it represents an area that requires you to be especially diligent."

At the database layer specifically, the three common patterns map roughly onto silo/bridge/pool:

- **Database-per-tenant** (silo) — strongest isolation, highest operational cost, hardest to run migrations/analytics across tenants at scale.
- **Schema-per-tenant** (bridge/"pod") — shared instance, dedicated schema per tenant; allows per-tenant backup/restore and some per-tenant migration flexibility, but Postgres catalog bloat makes this break down somewhere in the 1,000–10,000-tenant range, which is fine for a law-firm-facing product but worth knowing as a ceiling.
- **Shared schema + `tenant_id` + Row-Level Security** (pool) — cheapest and simplest to operate, but isolation now depends entirely on RLS policies and application discipline being correct on every table, forever.

## 3. Recommendation for this product's current stage

**Adopt a bridge model: pool (shared schema + Postgres RLS) as the default for the self-serve/mid-market tier, with an explicit, already-designed escape hatch to silo per-tenant databases for enterprise or unusually sensitive firms.** Reasoning:

1. This product doesn't have a stack, a customer, or a revenue model yet (`c18`, `c27`, `c29` are all still open). Committing to per-tenant database provisioning before knowing the customer profile (solo practitioners vs. large firms — see `c29`) would over-engineer for a shape of business that isn't confirmed.
2. The pool model, done correctly with RLS as a *backstop* rather than the only control, is what the current PostgreSQL multi-tenant literature converges on for this scale. ([Leapcell — PostgreSQL RLS for Multi-Tenant Isolation](https://leapcell.io/blog/achieving-robust-multi-tenant-data-isolation-with-postgresql-row-level-security), [AWS Prescriptive Guidance — Multi-tenant Postgres best practices](https://docs.aws.amazon.com/prescriptive-guidance/latest/saas-multitenant-managed-postgresql/best-practices.html))
3. Designing the escape hatch *now* — i.e., making `tenant_id` a first-class, non-optional concept everywhere, and keeping tenant provisioning logic abstracted from "which physical database" — means a later decision to silo a specific enterprise tenant (their own DB, possibly their own region) is a deployment change, not a rewrite. This directly serves `c19` (data model): every tenant-scoped table needs a `tenant_id` column from day one, full stop, even before multi-region or per-tenant siloing is built.
4. Given the stakes described in Section 1, I am explicitly **not** recommending pure pool with no dedicated-tenant option. Some prospective firm customers — especially larger firms with their own security review processes — will reasonably ask "is my data in the same database as my opposing counsel's firm," and the honest answer needs to be able to become "no" without a re-architecture.

This is a recommendation, not a decision — it constrains but does not replace the ADR at `c18`. Whoever writes that ADR should treat "pool by default, silo-capable per tenant" as a requirement to satisfy, not a foregone conclusion; a stack that made bridge-model support materially harder would be a real strike against it.

## 4. Isolation by layer

### 4.1 Data layer (the most important one)

- **Every tenant-scoped table carries a mandatory `tenant_id` (or `firm_id`) column**, enforced `NOT NULL`, from the very first migration. This is a hand-off requirement to `c19`.
- **PostgreSQL Row-Level Security (RLS) as the database-level backstop.** The standard pattern: the application sets a session variable (e.g., `SET app.current_tenant_id = '<tenant>'`) immediately after acquiring a connection and *before* any tenant-scoped query runs; every tenant-scoped table has an RLS policy whose `USING` clause checks rows against that session variable. The value of RLS here is specifically that it protects against the failure mode AWS's whitepaper calls the most common: "one missed filter" in application code. If a developer forgets a `WHERE tenant_id = ?` clause, RLS still blocks the cross-tenant read. ([Leapcell](https://leapcell.io/blog/achieving-robust-multi-tenant-data-isolation-with-postgresql-row-level-security))
- **RLS is a backstop, not the only control — two known gaps to design around explicitly:**
  - *Superuser / `BYPASSRLS` bypass.* Any role with `BYPASSRLS`, or a superuser, ignores RLS entirely. The application's runtime database role must **not** have this privilege or superuser status. Administrative/migration tooling that does need elevated privileges should be a separate, tightly audited path, never the path application requests use.
  - *Connection pooling can leak tenant context between requests.* This is the sharpest edge case and the literature reviewed here does not treat it with the weight it deserves: if the app uses a connection pooler (e.g., PgBouncer) in transaction-pooling mode, a session-scoped `SET` can persist on a physical connection that then gets handed to a *different* tenant's request, silently reintroducing cross-tenant access despite RLS being "on." The mitigation is to either (a) use session-level (not transaction-level) pooling for any connection that sets tenant context, (b) set and reset the tenant context within the same transaction/statement lifecycle so it can never outlive one request, or (c) use a pooler and driver combination verified to support `SET` safely per-transaction. This must be explicitly verified against whatever stack `c18` picks, not assumed.
- **Application-level tenant scoping stays mandatory even with RLS on.** Defense in depth: the query layer/ORM should still filter by `tenant_id` explicitly (e.g., via a shared base repository/query builder that no code path can bypass), so isolation doesn't depend on RLS alone being configured correctly on every table, forever, including future ones a developer forgets to protect.
- **Conflict-check data (`c3`) is the sharpest edge case in this whole document.** Conflict checking arguably *requires* checking a name against records outside the requesting firm's own tenant boundary in some designs (e.g., a shared referral network) — but for this product, conflict checks must be scoped **per firm**, matching the existing `c3` design (tri-state, role-sensitive, evaluated against that firm's own client/matter/prior-consultation records). There is no product requirement today for cross-firm conflict data sharing, and given Section 1's point about firms sometimes being adverse to each other, cross-tenant conflict-check lookups should be treated as explicitly out of scope unless a future card proposes it with its own privilege analysis.

### 4.2 AI / LLM layer

This is the layer general multi-tenant SaaS guidance doesn't cover well, and where ABA Opinion 512's warning is most concrete. Requirements:

- **No fine-tuning or training on tenant data that could surface across tenants.** If a hosted LLM vendor's default terms allow using API inputs for model training, that must be disabled/opted out contractually before any tenant data touches it (this is a `c18` vendor-selection gate, and a `c2`/privacy hand-off).
- **No shared long-term memory, embeddings store, or fine-tuned adapter across tenants.** Per-tenant conversation context, retrieval indexes (if the design uses RAG for firm-specific intake scripts per `c12`'s wording layer), and any classifier feature store must be tenant-partitioned with the same rigor as the relational data layer above — logically at minimum, and same `tenant_id`-scoped-query discipline.
- **Prefer vendors offering zero/short data retention and a signed DPA** over default API terms, and document the retention window actually in effect per vendor — this feeds directly into `c2`'s vendor-handling requirements section.
- **The classifier (`c13`) and future conversational flow (`c12`) must be re-reviewed against whatever specific model/vendor `c18` selects**, since this document can only state the requirement, not verify a specific vendor's compliance.

### 4.3 Compute and network

Given the pool-by-default recommendation, compute is shared by default. The concrete requirements:
- Per-tenant rate limiting and resource quotas so one firm's traffic spike (or a bug) can't degrade service for others (the "noisy neighbor" risk pool model accepts by design).
- No tenant-specific secrets, API keys, or credentials embedded in shared compute images/config — these belong in a secrets store keyed by tenant, resolved at request time.
- Logging and observability tooling must **redact or tenant-scope** log contents by default — an engineer debugging Firm A's support ticket must not incidentally see Firm B's intake transcripts in shared logs/traces. This is a real operational risk that's easy to miss: most APM/logging tooling captures full request/response bodies by default.

### 4.4 Internal/staff access (not just tenant-to-tenant)

Multi-tenancy isolation usually focuses on tenant A vs. tenant B. Equally important here: **firm staff users must only ever see their own firm's data**, and platform staff (this company's own employees) need a documented, audited, break-glass-only path to cross-tenant access for support — never standing access. This is a direct input to `c9` (encryption & access control review), which should define the actual role/permission model; this document only establishes that the boundary must exist and must be enforced at the same layer (ideally RLS) as tenant isolation itself, not as a separate, weaker control.

## 5. What this changes / hands off to other cards

- **`c19` (core data model):** every tenant-scoped table needs a mandatory `tenant_id` column and an RLS policy from the first migration onward; conflict-check data model must stay per-firm-scoped per Section 4.1.
- **`c9` (encryption & access control):** needs to define the actual staff/role permission model referenced in Section 4.4, and should treat "RLS session-variable management" and connection-pooling safety (Section 4.1) as in scope for its access-control review, not purely an encryption question.
- **`c18` (technology stack ADR):** should treat "supports pool-by-default with a credible silo escape hatch," "RLS-capable relational database," and "connection pooling that can safely carry per-request tenant context" as hard requirements, not nice-to-haves. Any LLM/AI vendor considered there must be evaluated against Section 4.2.
- **`c2` (data privacy & retention):** this document's AI-vendor retention/training requirements (4.2) and staff break-glass-access requirement (4.4) should be cross-referenced into that policy's vendor-handling and access sections.
- **`c3` (conflict-check engine):** confirmed as per-firm-scoped, no cross-tenant lookups, consistent with its existing tri-state/role-sensitive design from the `c12` spec PR.

## 6. Open questions for human review

1. **Silo pricing/packaging implications.** Offering a silo tier to enterprise firms has real infra cost implications that should inform `c29` (pricing hypothesis) once that's underway — this document assumes it's an option to build toward, not commits to offering it at any particular price point.
2. **Which specific pooler/driver combination is safe for per-request RLS session variables** can't be answered until `c18` picks a stack; flagging it here so it isn't silently assumed away when that ADR gets written.
3. **Whether any conflict-check design should ever support cross-firm lookups** (e.g., a future "shared referral network" feature) is explicitly out of scope for the current `c3` design per this document, but if a future product idea wants that, it needs its own privilege/confidentiality analysis before being built — it is not a simple extension of the isolation model described here.
4. This document's legal-adjacent framing (privilege, confidentiality, ABA Opinion 512) is engineering research informed by public ethics-opinion summaries, not a legal opinion — it should be reviewed by the same licensed attorney handling `c1`/`c26`/`c2` sign-off, particularly Section 1 and Section 4.2.

## Sources

- [AWS — SaaS Tenant Isolation Strategies: Pool Isolation](https://docs.aws.amazon.com/whitepapers/latest/saas-tenant-isolation-strategies/pool-isolation.html)
- [AWS — SaaS Tenant Isolation Strategies: The Bridge Model](https://docs.aws.amazon.com/whitepapers/latest/saas-tenant-isolation-strategies/the-bridge-model.html)
- [AWS Prescriptive Guidance — Multi-tenant Managed PostgreSQL Best Practices](https://docs.aws.amazon.com/prescriptive-guidance/latest/saas-multitenant-managed-postgresql/best-practices.html)
- [The HLD Handbook — Multi-Tenancy: Silo, Pool, and the SaaS Isolation Spectrum](https://hld.handbook.academy/curriculum/architecture-patterns/multi-tenancy/)
- [Leapcell — Achieving Robust Multi-Tenant Data Isolation with PostgreSQL Row-Level Security](https://leapcell.io/blog/achieving-robust-multi-tenant-data-isolation-with-postgresql-row-level-security)
- [Zuva — ABA Formal Opinion 512](https://zuva.ai/blog/aba-formal-opinion-512/)
- ABA Formal Opinion 512 (July 29, 2024), as summarized above and previously cited in the `c2` data privacy & retention policy draft (PR #2)
