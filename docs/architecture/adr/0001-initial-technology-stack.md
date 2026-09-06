# ADR-0001: Initial technology stack

**Status:** Proposed — requires sign-off (board card `c27`)
**Date:** 2026-09-04
**Board card:** `c18`
**Deciders:** Clayton (founder). Security/architecture reviewer if one is appointed before build starts.
**Supersedes:** nothing. **Constrained by:** `c8` (multi-tenant architecture, PR #4), `c12` (intake flow spec, PR #3), `c2` (data privacy, PR #2).

---

## Context

The board has a specification (`c12`) and an isolation model (`c8`) but no stack, so six implementation cards (`c19`–`c24`) are blocked behind this decision. This ADR unblocks them.

### Constraints taken as given

**From `c8` (hard requirements, not preferences):**
1. An RLS-capable relational database.
2. Pool-by-default tenancy with a credible silo escape hatch — a firm must be able to get its own database later without a rewrite.
3. Connection pooling that can safely carry per-request tenant context. `c8` explicitly leaves this unanswered and hands it here. **§D5 answers it.**
4. No LLM vendor that trains on inputs; no cross-tenant shared embeddings, memory, or fine-tunes.

**From the founder, 2026-09-04:**
5. **Claude writes the code; Clayton reviews and merges.** No engineering team for now.
6. **Weeks, not months, to something demonstrable** in front of a pilot firm.
7. **The product sits alongside the firm's existing CRM and drives it** — it does not replace it.
8. No hosting preference; optimise for low operational burden.

### The reframe this decision turns on

The tempting framing is "this is an AI product, so pick an AI stack" — which usually means Python, an agent framework, and a vector database.

Read `c12` again and that framing collapses. The specification describes a **durable, multi-tenant, human-in-the-loop workflow engine with heavy third-party integration**, in which a language model is *one node type behind an API call*. The hard parts are: holding state across days while a human decides something; never leaking one firm's data to another; writing to four external systems in the right order; and proving afterwards what the system did and why.

None of those are AI problems. They are ordinary — and well-understood — backend problems.

So: **choose the stack for the workflow, isolation, integration and audit problem, and treat the model as a swappable external service.** Every decision below follows from that. It also means Python's genuine advantage — its AI/ML ecosystem — buys us very little here, because we are not training, serving, or fine-tuning anything. We are making HTTPS calls to somebody else's model.

### One non-obvious quality attribute

Constraint 5 introduces a requirement most stacks are never chosen against: **the reviewer cannot reliably catch subtle bugs by reading the diff.**

Normally you rely on an engineer's judgement at review time. Here that safety net is thin, so the architecture has to compensate structurally. Concretely, this ADR prefers technology where mistakes are **loud** (compile errors, failing tests, refused migrations) over technology that is merely *elegant*, and it mandates a small number of automated tripwires (§D5, §Action items) for the failure modes a human reviewer would most plausibly miss. Where those two goals conflict below, loudness wins.

---

## Decision

Build a **TypeScript monolith plus one background worker, on managed Postgres, hosted on a single managed platform**, with tenant isolation enforced by Postgres row-level security via a mandatory transaction wrapper, and with workflow state, audit history, timers and outbound sync all held in Postgres rather than in additional infrastructure.

Nine decisions follow. D5 and D6 are the load-bearing ones; the rest are comparatively easy to reverse.

---

## D1 — Language: TypeScript everywhere

| Option | Corpus / LLM reliability | Type safety across boundaries | Languages to maintain | AI ecosystem |
|---|---|---|---|---|
| **TypeScript** | Very high | End-to-end (API ↔ both UIs) | 1 | Adequate — we only make API calls |
| Python + TS frontend | Very high | Breaks at the HTTP boundary | 2 | Excellent, but largely unused here |
| Go + TS frontend | Medium | Breaks at the HTTP boundary | 2 | Weak |
| Ruby/Rails | High | Dynamic; errors surface at runtime | 2 | Weak |

**Chosen: TypeScript.**

The decisive factor is not preference, it is constraint 5. With one language, the compiler checks the seam between the API and the two UIs — exactly the class of mistake an AI writing across a boundary will make and a non-engineer reviewer will not spot. Split the stack and that seam becomes untyped JSON validated by hope.

Rails deserves an honest mention: its conventions are strong, its corpus is large, and Django-style admin scaffolding would genuinely accelerate `c24`. It loses on the same point — a dynamic language moves errors from compile time to runtime, which is the wrong direction under constraint 5.

*Non-obvious consequence:* this is the decision most people would make for the wrong reason ("TypeScript is popular"). The reason that actually matters is that it is the only option preserving type-checking across the client/server boundary without a second toolchain.

---

## D2 — Shape: modular monolith + one worker

**Chosen: a single deployable web application and a single background worker process.** Not microservices; not serverless-only.

Microservices would be indefensible here: they trade local complexity for distributed complexity, and distributed bugs are precisely the sort that survive review by a non-engineer.

Serverless-only fails for a concrete reason rather than an ideological one: the spec requires **durable timers measured in days** — follow-up cadences of 1/2/7/7 days, 24-hour payment holds, SLA clocks on escalations. A serverless function cannot hold those. Something must be running, or something must be waking up on a schedule.

Modules inside the monolith map to spec concepts, so the AI has a place to put things: `flow/` (the engine), `tenancy/`, `integrations/`, `llm/`, `scheduler/`, `audit/`.

---

## D3 — Framework: Next.js for the surfaces, plain Node for the worker

**Chosen: Next.js (App Router) hosting the admin console and the chat surface; a plain Node process for the worker; shared TypeScript packages between them.**

Next.js is the highest-corpus full-stack TS framework, which matters under constraint 5, and it covers both UIs (`c23`, `c24`) in one deployment.

One caveat worth recording now: **the client-facing chat widget (`c23`) must eventually embed on a law firm's own website**, which is a different artefact from an admin console — a small standalone script or iframe, not a Next page. For the demo, an iframe pointing at a hosted route is fine. Rewriting that widget as a standalone bundle later is expected and cheap; do not let it drag the admin console's architecture around.

---

## D4 — Data access: managed Postgres + Drizzle

**Chosen: Postgres (managed), with Drizzle as the query layer.**

Postgres is not really a choice — `c8` requires RLS, which decides it.

The query layer is a genuine trade-off:

| | Prisma | Drizzle |
|---|---|---|
| LLM corpus | Larger | Smaller but sufficient |
| Migrations DX | Better | Good |
| Explicit transaction + `SET LOCAL` control | Awkward | Direct |
| Distance from SQL | Further | Close |

**Drizzle wins on the one dimension that is load-bearing:** D5 requires every tenant-scoped query to run inside an explicit transaction that sets a session-local variable. Drizzle expresses that transparently; Prisma fights it. Prisma is the defensible alternative if Drizzle proves awkward — but revisit D5's mechanics at the same time, because they are coupled.

Migrations are reviewed **as generated SQL**, never as ORM diffs. A non-engineer can read `ALTER TABLE`; nobody can review a schema diff they cannot see.

---

## D5 — Tenant isolation mechanics *(answers `c8` open question 2)*

This is the sharpest technical question in the project, and `c8` deliberately left it open. Getting it wrong leaks one law firm's privileged intake to another — potentially to opposing counsel.

**The trap.** The natural implementation is: acquire a connection, `SET app.current_tenant_id = '<tenant>'`, run queries, rely on RLS. Under a transaction-mode connection pooler this is **actively dangerous**: `SET` is session-scoped, the physical connection returns to the pool at transaction end still carrying that value, and the next request — a different firm — inherits it. RLS is enabled, correctly configured, and silently useless.

**The decision — three mechanisms, all mandatory:**

1. **`SET LOCAL` inside an explicit transaction.** `SET LOCAL` is scoped to the transaction and is discarded at commit or rollback, so it cannot outlive the request or survive into a pooled reuse. This is safe under transaction pooling, which is what makes it the right primitive rather than merely a working one.

2. **A single mandatory wrapper.** All tenant-scoped database access goes through one function:

   ```ts
   withTenant(tenantId, async (tx) => { /* all queries use tx */ })
   ```

   which opens the transaction, issues `SET LOCAL app.tenant_id`, and hands back the scoped handle. No other database handle is exported from the data module. Under constraint 5 this matters more than usual: correctness becomes a property of the *structure* rather than of every future diff being reviewed carefully.

3. **The application's database role must not hold `BYPASSRLS` and must not be a superuser.** Migrations run as a separate, elevated role on a separate path.

**And a tripwire, because the above is only as good as its enforcement:** an automated test that seeds two tenants, queries tenant A's data while scoped to tenant B, and asserts zero rows — running on every PR as a required check. If that test ever fails, the merge stops without depending on anyone noticing.

Defence in depth still applies: application-level `tenant_id` filtering stays, and `tenant_id` is `NOT NULL` on every tenant-scoped table from the first migration, per `c8` §4.1 and handed to `c19`.

**Silo escape hatch:** tenant → connection resolution lives behind one function from day one. Moving a firm to a dedicated database then becomes configuration, not surgery.

---

## D6 — Workflow execution: Postgres, not a workflow engine

The spec is a state machine with human-in-the-loop pauses and multi-day timers. That description makes people reach for Temporal, Inngest, or Restate.

| Option | Fit | Cost under our constraints |
|---|---|---|
| **Postgres tables + cron worker** | Good | No new infrastructure; all state inspectable with SQL; trivially reviewable |
| Inngest / managed durable execution | Very good | Another vendor, another failure mode, another mental model to review |
| Temporal (self-hosted) | Excellent at scale | Serious operational burden — indefensible for a solo non-engineer |
| Temporal Cloud | Excellent | Cost and conceptual overhead far ahead of the need |

**Chosen: Postgres tables driven by a scheduled worker.** Four tables carry the entire model:

- `intake_sessions` — one row per intake, holding `current_node` and collected answers.
- `intake_events` — **append-only**, one row per state transition, with actor, timestamp, and the rule that fired.
- `scheduled_tasks` — due-at rows for cadence steps, payment holds, and SLA clocks.
- `outbox` — outbound writes to external systems, written in the same transaction as the state change.

The worker wakes each minute, claims due rows with `SELECT ... FOR UPDATE SKIP LOCKED`, and advances them.

**Why this is the sophisticated answer rather than the lazy one.** Three things fall out of it for free:

- **The audit log (`c6`) is already built.** `intake_events` *is* the immutable record of every automated decision, which `c6` requires for bar compliance and malpractice defence. It is not a feature to add later; it is the storage design.
- **The ordering constraint from the reference SOP is enforceable.** "Write the matter record before the appointment is confirmed" becomes a transactional outbox guarantee rather than a hopeful sequence of API calls.
- **Everything is inspectable with SQL.** When something goes wrong, the answer is a query, not a distributed trace across a vendor's UI — which matters enormously when the person debugging is not an engineer.

**Revisit when** any of these becomes true: more than roughly a thousand scheduled tasks due per minute; a need for fan-out/parallel branches the flow does not currently have; or worker runtime consistently exceeding the tick interval. None is near.

---

## D7 — Hosting: one managed platform, US region

**Chosen: a single managed platform running the web service, the worker, cron, and managed Postgres — Render as the primary recommendation, Railway as an equivalent alternative. US region.**

The requirement is mundane: long-running processes, scheduled jobs, and a managed database in one place with minimal operations. Splitting the frontend onto Vercel and hosting the worker elsewhere is a common pattern and a poor fit here — it doubles the number of consoles, deploy pipelines and failure modes for a team of one.

US region is deliberate: the reference firm is in Texas, `c1` scopes compliance to Texas, and data residency is a question firms will ask in security review.

Portability is high by construction — Postgres and Node run anywhere — so this is among the cheapest decisions here to reverse.

---

## D8 — Auth: a managed provider

**Chosen: a managed authentication provider (Clerk to start; WorkOS if enterprise SSO appears early).** Never roll our own.

Note for `c9`: staff-level roles inside a firm, and the platform's own break-glass support access, are *authorisation* concerns and should be enforced at the same layer as tenant isolation (D5), not bolted on as application checks.

---

## D9 — Model vendor: an adapter, and a gate

**Chosen: all model calls go through one internal interface (`llm/`), with the vendor swappable behind it.**

The classifier (`c13`) does one job: turn free text into a practice-area label and an urgency signal. That is a small, replaceable surface, and it should stay that way — no framework, no agent abstraction, no vector store until something concretely requires one.

**On vendor terms, this ADR deliberately specifies a requirement rather than naming a compliant vendor.** Public secondary sources on retention and training policy age quickly and are not a sound basis for a compliance decision in a legal product. The requirement, from `c8` §4.2:

- inputs not used for training;
- zero or short retention, documented, with the window actually in effect recorded;
- a signed DPA;
- no shared embeddings, memory, or fine-tunes across tenants.

**Gate:** these are verified against the vendor's own contractual terms **before any real client data reaches the model** — not before the demo. Which leads to the control below.

### A control this ADR adds

The combination of "weeks to demo", AI-written code, and privileged legal data creates one genuinely dangerous failure mode: **real client data flowing through the system before the compliance gates (`c1`, `c2`, `c26`, and D9's DPA) are cleared.**

Mitigation, cheap and structural: production tenant creation is disabled behind a flag until those gates are signed off, and the demo runs on **synthetic data only**. This costs nearly nothing to build now and is very hard to retrofit after the first firm has typed a real client's name into a prototype.

---

## Trade-off analysis

**The genuine trade-offs, stated honestly:**

- **TypeScript over Python** costs us the better AI ecosystem. That cost is close to zero *today* because we only make API calls, but it would become real if the product ever needs local models, embeddings at scale, or serious document processing. Revisit if that happens — and note it could be a separate Python service rather than a rewrite.
- **Postgres-as-workflow-engine over a durable execution platform** costs us fan-out, versioned workflow definitions, and replay debugging. We do not need any of them yet, and the operational simplicity is worth more at this stage than capability we would not exercise.
- **Monolith over services** will eventually cost us independent scaling. Years away, if ever.
- **Drizzle over Prisma** trades corpus size for transaction control. If Drizzle proves awkward for the AI to write consistently, switching is a contained refactor — but D5's mechanics move with it.

**Where I am least confident:** D4 (Drizzle vs Prisma) is the closest call, and it is the one I would most expect a working engineer to argue with. It is also the cheapest to change.

**Where I am most confident:** D5. The `SET LOCAL`-in-transaction pattern is not a preference — the alternative is a silent cross-tenant leak under a standard pooler configuration.

---

## Consequences

**Easier:**
- `c6` (audit log) is largely delivered by D6's `intake_events` table rather than being separate work.
- `c19` (data model) has its constraints fixed: `tenant_id NOT NULL` everywhere, RLS on every tenant-scoped table, four workflow tables.
- `c20` (CI/CD) has a clear required check to build around: the cross-tenant isolation test.
- Debugging is SQL, which is reviewable by a non-engineer.
- **The "sits alongside" scope decision (constraint 7) materially improves the compliance posture** — the firm's CRM stays the system of record, so we can hold less privileged data and purge transcripts after sync. `c2`'s retention policy gets easier the more aggressively we exploit this. Treat data minimisation as an architectural principle, not an afterthought.

**Harder:**
- Integration correctness now carries more weight, since we drive four external systems rather than owning the data (constraint 7 cuts both ways).
- Every tenant-scoped query must go through `withTenant()`. That discipline is enforced by structure and one test, but it is discipline nonetheless.
- The chat widget will need rewriting as a standalone embeddable bundle before any real firm deploys it.

**Revisit when:**
- A firm demands a dedicated database → exercise D5's escape hatch.
- Scheduled load approaches ~1k due tasks/minute → graduate D6 to a real queue.
- The product decision changes from "alongside" to "replaces the CRM" → the data model expands substantially and `c19` needs rework. This is the single change most likely to invalidate parts of this ADR.

---

## Hand-offs

| Card | What this ADR fixes for it |
|---|---|
| `c19` data model | `tenant_id NOT NULL` + RLS on every tenant-scoped table; the four workflow tables from D6; migrations reviewed as SQL |
| `c20` CI/CD | Required checks: typecheck, migration review, and the cross-tenant isolation test |
| `c21` API scaffold | Next.js app + worker, module layout from D2, `withTenant()` before any query code exists |
| `c6` audit log | Satisfied in large part by `intake_events`; the card becomes retention and presentation, not capture |
| `c9` access control | Staff roles and break-glass access enforced at the D5 layer |
| `c3` conflict engine | Per-firm scoped, no cross-tenant lookups, consistent with `c8` §4.1 |
| `c13` classifier | Lives behind the `llm/` adapter; subject to D9's gate |
| `c23` chat UI | Standalone embeddable bundle eventually, not a Next page |

---

## Action items

1. [ ] Sign-off on this ADR (`c27`).
2. [ ] Provision managed Postgres and the hosting platform, US region.
3. [ ] Scaffold the monolith with the D2 module layout (`c21`).
4. [ ] Implement `withTenant()` **before** any other data access code exists.
5. [ ] Write the cross-tenant isolation test and make it a required CI check (`c20`).
6. [ ] Create the four workflow tables and RLS policies (`c19`).
7. [ ] Build the production-tenant flag so real tenants cannot be created before compliance sign-off.
8. [ ] Verify model-vendor terms and sign a DPA before any real client data flows (`c2`, D9).
9. [ ] Confirm the chosen platform's pooler mode and verify `SET LOCAL` behaviour empirically — do not assume it.

---

## Open questions for the decider

1. **Drizzle or Prisma (D4)?** The closest call here. Happy to switch if you have a view.
2. **Does the "sits alongside" decision hold?** It is load-bearing for D6, the data model, and the compliance posture. If it might flip within six months, say so now — it is much cheaper to know before `c19` than after.
3. **Should the demo be throwaway?** This ADR assumes the demo is the beginning of the real system. An explicitly disposable prototype would justify cutting D5's rigour *for that artefact only* — but then it must never touch real client data, and the production flag in D9 becomes mandatory rather than prudent.

---

*This ADR is engineering judgement, not legal advice. The compliance points it references are constraints inherited from `c1`, `c2` and `c8`, all of which remain subject to the attorney review tracked in `c26`.*
