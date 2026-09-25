# Product Expansion: Legal Intake → Full Legal Case Management — Scope Memo

**Status:** Product/strategy research and a recommended approach, requested directly by the founder. Where this touches new legal/regulatory territory (trust accounting specifically, §3), it is **research, not a legal or accounting opinion** — flagged in the same way as every other compliance document on this board, with an added note that trust accounting needs a CPA reviewer alongside the attorney reviewer already tracked on `c26`.
**Requested by:** Clayton, 2026-09-25, directly in conversation: "we are upgrading the legal intake build to a Legal Case management software."
**Depends on / synthesizes:** `docs/product/scope-and-problem-statement.md` (`c17`), `docs/go-to-market/pricing-hypothesis.md` (`c29`), `docs/architecture/adr/0001-initial-technology-stack.md` (`c18`), `docs/architecture/core-data-model-schema-design.md` (`c19`), `docs/architecture/audit-log-compliance-trail.md` (`c6`), `docs/compliance/upl-compliance-review.md` (`c1`).
**Author:** Claude (interactive session, at the founder's direct request), 2026-09-25.

---

## 1. What's changing, and why it's a structural shift, not a feature add

The product as scoped through `c17` ends at the moment a matter is opened or declined — its ten terminal dispositions (`c17` §3) are all *intake* outcomes: scheduled, pending, referred, declined, out of scope, abandoned. `c17` §6 explicitly listed several things as out of scope for v1 specifically because they're what happens *after* intake: payment processing, post-signature client onboarding, e-signature and engagement-letter generation (`c4`), and practice-management-tool integrations (`c5`) — the product was designed to sit "alongside" a firm's existing tools (ADR-0001 constraint 7) rather than replace them.

"Upgrading to legal case management software" reverses that boundary. Case management is everything `c17` deliberately deferred, plus a substantial amount `c17` never contemplated at all: document management, calendaring and deadline tracking, time tracking and billing, trust accounting, client communication, task/workflow management, and reporting. This isn't intake-plus-a-few-features — it's a different, larger product category. The competitive set changes accordingly: instead of `c15`'s intake-specific comparison (Clio Grow, Lawmatics, Intaker, Smith.ai), the real comparison set becomes full practice-management suites — Clio Manage, MyCase, PracticePanther, Smokeball, CASEpeer, Filevine — each of which is a mature, multi-year product built by teams much larger than "one founder, AI-written code" (ADR-0001 constraint 5).

That's not a reason not to do it — it's the reason this memo exists before any board restructuring: the founder should make this call with the scale of the shift in view, not discover it card by card.

## 2. What the case-management competitive set actually offers

Checked against current (2026) sources rather than assumed, the feature set is consistent across every product reviewed:

- **Case/matter management** — the organizing spine every other feature attaches to (this product already has this, via `c19`'s `matters` table).
- **Calendaring**, frequently with *court-rule deadline automation* — the software calculates filing deadlines from a triggering event (e.g., a court rule's response window) rather than the user computing them by hand. Flagged specifically in §5 below because this feature sits close to a line `c1` already drew for a different feature.
- **Billing and trust accounting** — invoicing, time tracking, payment processing, and trust-account reconciliation. Treated by every vendor as one connected feature area, not two, because billable time and trust-fund handling are procedurally linked (an invoice is frequently paid out of retained trust funds).
- **Client communication** — secure messaging portals, distinct from (and often replacing) email for anything client-confidential.
- **Task management** — assignment, workflow automation, deadline monitoring at the task level, not just the matter level.
- **Document management** — centralized storage, templates, and document-assembly tools.
- **Financial reporting** — profitability and budget analytics, a firm-owner-facing layer distinct from the day-to-day case work (conceptually adjacent to `c33`'s recently-shipped insights dashboard, which this expansion would extend rather than replace).

**Named differentiators worth reacting to, not just noting:** MyCase leads with built-in trust reconciliation and a large integration/automation surface (75+ native integrations, Zapier for the rest). Clio splits Manage/Grow as separate products with a large integration library, but user feedback cited in this research specifically calls out *conflict-check friction* as a weak point — directly adjacent to this product's own strongest differentiator (`c3`'s tri-state, role-sensitive conflict engine, still unbuilt). PracticePanther wins on fast onboarding, loses on sync reliability. Smokeball's passive time tracking (automatic capture, not manual entry) and built-in document generation are called out as genuine UX wins worth understanding before this product's own time-tracking and document features are designed.

**Strategic read:** this product already has two differentiators the incumbents don't emphasize as hard — a first-class conflict-check engine purpose-built for role-sensitivity, and an intake/triage layer purpose-built for UPL compliance from day one rather than bolted on. The case-management expansion should carry those differentiators through the full matter lifecycle (e.g., trust-fund handling should be exactly as rigorously reviewed as `c1`'s UPL work was), not treat case management as a separate, generic feature checklist to match competitors on.

## 3. The new compliance surface: trust accounting / IOLTA

This is the single biggest thing this expansion adds, and it is categorically different from anything `c1`, `c2`, or `c9` already cover.

**What's actually required (Texas, as the concrete worked example, consistent with every other compliance document on this board):**

- Texas attorneys holding "nominal or short-term" client funds — retainers, settlement advances, any money received but not yet earned — are required to hold them in an IOLTA (Interest on Lawyers' Trust Accounts) account. This is not optional once a firm holds client funds at all, and every attorney certifies IOLTA compliance annually at State Bar renewal, regardless of whether they currently hold client funds.
- **Three-way reconciliation** is the core mechanical control: the bank statement balance, the pooled trust-ledger balance, and the sum of every individual client's sub-ledger balance must all agree. Monthly reconciliation is the recommended cadence; a discrepancy across any of the three requires immediate investigation, not a note-and-move-on.
- **Texas Rules of Disciplinary Procedure Rule 17.10** requires complete trust-account records — checkbooks, canceled checks, check registers, bank statements, and a per-client ledger showing every deposit, disbursement, and running balance — retained for **five years after representation ends**. This is a materially longer, and procedurally different, retention obligation than anything `c2`'s retention schedule currently specifies, because it's not about the underlying intake/matter data — it's about the money.
- **Enforcement runs through the Office of Chief Disciplinary Counsel**, with outcomes ranging from reprimand to disbarment — this is an attorney-discipline regime, not a civil-injunction or AG-enforcement regime like the UPL and privacy exposure `c1`/`c2` already cover. The Texas Access to Justice Foundation separately administers the interest-remittance side (the "IOLTA" part specifically — pooled trust-account interest funds legal aid).

**Why this changes the product's risk profile, not just its feature list:** every compliance document on this board so far treats its worst-case failure as a civil or regulatory action against the *business* — an injunction, a fine, an AG enforcement action. A trust-accounting failure is different in kind: it's a fiduciary breach that can end an *individual attorney's license to practice*, and this product would become the system of record for money it is professionally disqualifying to mishandle. A missed conflict check or a late data-deletion request is a serious bug with real consequences; a broken three-way reconciliation is the kind of failure that shows up in bar-discipline case reporters.

**Recommendation:** a new document, structured like `c1` — **"Trust Accounting / IOLTA Compliance Review,"** Texas-scoped first, same "research and recommended approach, not a legal or accounting opinion" framing `c1` and `c2` already use, **plus an explicit CPA-reviewer requirement alongside the attorney reviewer** (trust accounting is as much an accounting-competence area as a legal one — the "who reviews this" question `c1`/`c26` already answered for UPL doesn't automatically extend to a CPA, and this document shouldn't assume it does). This should be the first card picked in the new case-management track — not because it blocks the existing intake-track work (it doesn't), but because it's the one place in this entire expansion where getting the compliance research wrong before any code is written has the highest cost.

## 4. Data model and architecture implications

`c19`'s schema (12 tables: `firms`, `users`, `parties`, `matters`, `matter_parties`, `conflict_check_results`, `documents` (currently a stub), plus the four ADR-0001 workflow tables) is a reasonable foundation, but case management needs real tables for things `c19` only stubbed or never touched:

- **A real `documents` table** (not the current placeholder) with versioning and storage-location metadata — see the storage note below.
- **A calendar/deadlines table**, tied to matters, almost certainly built on ADR-0001 D6's existing `scheduled_tasks`/worker pattern rather than a new subsystem — the "durable timer" infrastructure this product already has for intake cadences generalizes naturally to matter deadlines.
- **Time-entry and invoice/billing tables.**
- **A trust-ledger table** — a pooled account ledger plus per-client sub-ledgers, matching the three-way-reconciliation structure §3 describes. This table's integrity requirements are at least as strict as `c6`'s audit-log immutability requirements (ADR-0001 D5's "structure over convention" principle, applied to accounting instead of tenant isolation): no `UPDATE`/`DELETE` grants on the application role, a required CI tripwire, and — where `c6` §3 called hash-chaining a "should-have, not must-have" for the general audit log — this document recommends treating it as closer to a must-have for the trust ledger specifically, since three-way reconciliation is the exact mechanism a bar examiner or auditor actually checks, and tamper-evidence matters most exactly where the stakes are license-ending.
- **A tasks table** and, if the client communication feature is built as in-app messaging rather than document/status sharing alone, **a messages/communications table.**

Multi-tenancy (`c8`) and the encryption/access-control model (`c9`) both generalize to this new data without re-architecture — RLS and `withTenant()` don't care what table they're scoping. What ADR-0001 genuinely doesn't have an opinion on yet is **binary/file storage**: the current stack is Postgres-only by design (D4–D6), and real document management needs object storage (encryption at rest for files specifically, a virus/malware scan on upload, and an integration point for `c4`'s deferred e-signature work). This needs a short ADR addendum, not a re-litigation of ADR-0001's core decisions.

## 5. A UPL flag worth carrying forward, not resolving now

Court-rule-based deadline automation (§2's "calendaring" feature) is a place products can drift from "calendaring tool" into "applying the law to a specific matter's facts" — the same legal-information-vs-legal-advice line `c1` §2 already drew for the conversational intake flow. Computing "your response is due in 21 days" from a generic court-rules table is squarely legal information; computing it correctly requires knowing which rule applies to *this* matter, which starts to look like the kind of fact-specific legal determination `c1` was written to keep this product away from. This doesn't block starting the trust-accounting review or the data-model work — it's a narrow addendum `c1`'s eventual reviewer should scope when the calendaring feature itself gets built, flagged here so it isn't rediscovered from scratch later.

## 6. A recommended sequence for the new track

This does not replace or reorder the existing 1–14 dependency order in `CLAUDE.md` — that order remains correct for finishing the intake product essentially as already scoped, and most of it is done or close (see the board). This is a **parallel track**, sequenced on its own:

1. **Trust accounting / IOLTA compliance review** (Compliance, P0) — §3. Gates trust/billing feature work specifically, the same relationship `c1` has to the conversational flow; does not block the rest of this track.
2. **Case-management competitive landscape scan** (Go-to-Market, P1) — a deeper pass than §2's summary here, parallel to the existing `c15` intake-competitor scan, not blocking anything.
3. **Case-management data model extension + storage ADR addendum** (Engineering, P0) — blocked on the stack decision already existing (it does, `c18`) and, for the trust-ledger portion specifically, on item 1's compliance framing existing in draft form (the same relationship `c19` had to `c1`'s draft, not final sign-off).
4. **Document management & storage** (Engineering/Product, P1) — blocked on item 3.
5. **Calendaring & deadline/SOL tracking** (Engineering/Product, P1) — blocked on item 3; carries the §5 UPL flag forward when scoped.
6. **Time tracking & billing/invoicing** (Engineering/Product, P1) — blocked on item 3.
7. **Trust accounting ledger & three-way reconciliation engine** (Engineering, P0) — blocked on items 1 *and* 3. The single highest-risk build in this entire expansion; should not start until item 1 has real attorney-and-CPA-reviewed work behind it, not just a draft.
8. **Client communication portal** (Engineering/Product, P2) — blocked on item 3.
9. **Task management & workflow automation** (Engineering/Product, P2) — blocked on item 3.
10. **Revised pricing & packaging model for case management** (Go-to-Market, P1) — see §7; not a build blocker for anything above, but shouldn't be left until launch.

## 7. Pricing implications — flagged, not resolved

`c29`'s pricing hypothesis (per-firm base plus intake-volume tiers) was sized specifically to intake volume — a lumpy, lead-driven metric. Every case-management competitor reviewed here prices **per attorney/user per month** instead (Clio Manage's entry tier was priced around $49/user/month in `c29`'s own prior research), because daily case-management usage scales with headcount, not lead volume, and per-seat pricing is the market-standard shape for that usage pattern — the opposite of `c29` §4's argument for why per-seat pricing was the *wrong* fit for intake specifically. Taken together, this product likely needs **two pricing dimensions once case management ships** — a usage-based component for intake/triage, a seat-based component for case management — not the single dimension `c29` assumed. This is exactly the kind of numbers-and-market-fit question `c29` §5 already deferred to real pilot-firm conversations (`c30`); flagging it now so `c7`'s eventual packaging work doesn't silently inherit `c29`'s single-dimension assumption into a product that no longer fits it.

## 8. Recommendation

Treat this as a **full repositioning**, not an additive side-feature: the product becomes end-to-end legal case management, with the existing intake/triage/conflict-check work as the front door into it rather than a separate product. Finish the existing 1–14 track roughly as scoped (most of it is done or close per the board), and open the new case-management track starting with item 1 above (trust accounting compliance) given its outsized risk profile relative to everything else in this memo.

One tension worth naming directly: ADR-0001's founding constraint was **"weeks, not months, to something demonstrable, one founder, AI-written code."** That constraint was calibrated to an intake product. Full case management — especially trust accounting, which every source reviewed here treats as its own specialized, high-stakes subsystem even at mature vendors — is a materially larger build. Two honest paths forward: revisit the timeline/resourcing constraint explicitly (this is now a multi-month build even at this team's velocity), or ship a deliberately reduced case-management v1 (document management, calendaring, time tracking) with trust accounting and full billing explicitly deferred to a v2, since trust accounting is simultaneously the highest compliance risk and the highest engineering complexity item in this whole expansion. This document recommends making that choice explicitly (§9, question 2) rather than letting it default by omission.

## 9. What this document does not decide

- No architecture decisions beyond flagging that document/object storage needs an ADR addendum — ADR-0001 itself is not superseded or reopened.
- No trust-accounting compliance conclusions of any kind — that is entirely item 1's job in §6, and explicitly needs a CPA co-reviewer, not just an attorney.
- No pricing numbers, and no resolution of the two-dimension-pricing question in §7.
- No scope-trim decision (full case management v1 vs. a phased build with trust accounting deferred) — this is squarely the founder's call, framed but not made in §8.
- No renaming of the board, the repository, or the Claude Project itself — those are one-line changes Clayton can make directly wherever he wants the new framing to show up; this document doesn't presume to make them.

## 10. Open questions for the founder

1. **Confirm the framing:** full repositioning (as recommended in §8) versus an additive/phased expansion where intake stays primary and case management is explicitly a later-stage module?
2. **Trust accounting: v1 or explicitly deferred to v2?** It's both the highest compliance risk and the biggest single re-architecture in this memo — worth a direct decision rather than letting it default in either direction.
3. **Does ADR-0001's "weeks, not months, one founder" constraint still hold** for this expanded scope, or should that be explicitly revisited now rather than discovered later as the build stalls against it?
4. **Who is the CPA reviewer for trust-accounting compliance**, parallel to the attorney reviewer already lined up for `c26`'s UPL sign-off?
5. **Does the target buyer segment still hold** (`c17` §4: solo/small firms, 1–10 attorneys)? Case management is stickier and higher-ACV than intake alone, which can shift who a product should sell to first — worth a deliberate check rather than an inherited assumption.

## Sources

- [Legal Practice Management Software Compared — MyCase (2026)](https://www.mycase.com/blog/legal-case-management/best-legal-practice-management-software/) — feature-category survey and named differentiators for MyCase, Clio, PracticePanther, and Smokeball, used in §2.
- [Texas IOLTA Trust Account Management — Law Firm Velocity](https://www.lawfirmvelocity.com/resources/iolta/texas) — IOLTA trigger conditions, three-way reconciliation mechanics, Texas Rules of Disciplinary Procedure Rule 17.10's five-year retention requirement, and the Office of Chief Disciplinary Counsel / Texas Access to Justice Foundation enforcement structure, used in §3.
- `docs/product/scope-and-problem-statement.md` (`c17`) — §§3, 6, the terminal-disposition list and out-of-scope items this expansion pulls back into scope.
- `docs/go-to-market/pricing-hypothesis.md` (`c29`) — §§3–4, the intake-volume pricing shape §7 flags as likely insufficient on its own for case management.
- `docs/architecture/adr/0001-initial-technology-stack.md` (`c18`) — constraints 5–7 and D4–D6, the build-velocity and Postgres-only-by-design decisions §4 and §8 build on.
- `docs/architecture/core-data-model-schema-design.md` (`c19`) — the existing 12-table schema §4 extends.
- `docs/architecture/audit-log-compliance-trail.md` (`c6`) — §3's immutability pattern, reused in §4 for the trust ledger.
- `docs/compliance/upl-compliance-review.md` (`c1`) — §2's legal-information-vs-legal-advice line, carried forward in §5 for deadline-automation.

---

*This document is product and technical strategy research to inform a founder decision. Section 3's trust-accounting content in particular is not legal or accounting advice, creates no attorney-client or accountant-client relationship, and must be reviewed by both a licensed attorney and a CPA competent in trust accounting before any of it is relied on operationally or built into the product.*
