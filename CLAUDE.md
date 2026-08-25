# CLAUDE.md

Instructions for any Claude session (scheduled or manual) working in this repository. If you're a fresh session picking up work here, read this whole file before doing anything.

## What this project is

A generic, commercial legal-intake AI: conversational triage, conflict-check automation, and a compliance-aware pipeline a law firm can drop its own intake process into. Owner: Clayton (idiongo@hotmail.com).

## Source of truth for status

The [Legal Intake Build](https://claude.ai/code/artifact/c002dcf5-570b-4d92-9afd-9cde9d8daa3e) kanban board, not this file and not any status comment in code. Read it with the Artifact tool (`action: "read"`) before assuming what's done, in progress, or next.

It's a self-contained HTML page. Current state lives as JSON inside `<script id="state-data" type="application/json">`. Columns: `backlog`, `scoping`, `in-progress`, `review-qa`, `shipped`. Each card: `id`, `column`, `title`, `type` (`Founder`/`Compliance`/`Product`/`Engineering`/`Security`/`Go-to-Market`), `source` (priority `P0`/`P1`/`P2`), `date`, `note`, `order`, and optionally `pr` (a GitHub PR URL, once one exists for that card — shown as a "View PR ↗" link on the card).

To publish a board update: read the artifact, edit only the field(s) that actually changed in the JSON, and republish with the Artifact tool — `action: "publish"`, the same URL, `capabilities: {"artifact": {}}`, `title: "Legal Intake Build"`, `favicon: "🛠️"`. Never touch any other card or the page's structure.

## The board and the repo are kept in sync manually, in both directions

There is no live/automatic link between them — a card only moves because a session (usually the daily scheduled one) explicitly reads one side and writes the other:

- **Board → repo**: when starting work on a card, do the work, open a PR, then set that card's `pr` field to the PR's URL and move it to `review-qa`.
- **Repo → board**: at the *start* of every session, before picking any new work, check every card currently in `review-qa` that has a `pr` set — if that PR has been merged, move the card to `shipped`. This is a status sync, not "work," so do it for every eligible card, not just one.

If you skip either direction, the board silently drifts from reality. Always do the repo→board sync check first, every session, even if you end up not picking new work.

## Cards you never touch

Any card with `type: "Founder"` is Clayton's own task — reviewing/merging PRs, talking to an attorney, deciding pricing, setting up hosting accounts, approving a decision. Never pick one, never write anything for it, never move it, regardless of priority.

## Repository structure

- `docs/compliance/`, `docs/product/`, `docs/architecture/`, `docs/security/`, `docs/go-to-market/` — one folder per board track. A card's real deliverable (research, spec, ADR) lands here before the card is considered started.
- `src/` — stays empty until the "Technology stack decision (ADR)" card is done. Don't write implementation code before that decision exists and has real work behind items 1–7 below.

## Workflow rules

- Work on a branch (`work/<card-id>-<short-slug>`), never push directly to `main`.
- Open a pull request describing what you did, what sources you used, and open questions for human review. Never merge your own PR — that's Clayton's job (Founder card).
- One new card of work per session. Don't sprawl across multiple cards in one sitting (the repo→board Shipped sync above doesn't count against this — that's status-checking, not new work).
- Check `docs/` and open PRs before starting anything, so you don't duplicate work already done or in flight.

## Dependency order

Later items depend on earlier ones being settled. Don't jump ahead just because something downstream is also P0.

1. UPL compliance review across target states
2. Data privacy & retention policy
3. Terms of service & liability disclaimers
4. Multi-tenant architecture & data isolation
5. Encryption & access control review
6. Conversational intake flow design
7. LLM triage classifier
8. **Technology stack decision (ADR)** — gate before any code is written
9. Core data model & schema design
10. CI/CD pipeline & staging environment
11. Core API service scaffold — the first real commit into `src/`
12. Test suite & testing strategy
13. Client-facing intake chat UI (build)
14. Admin/staff console UI (build)
15. Everything else by priority (conflict-check engine, e-signature/engagement letters, PM-tool integrations, audit log, client status portal, pricing, competitive scan, pilot recruitment)

## Compliance content guardrails

This project touches unauthorized-practice-of-law (UPL) rules, data privacy law, and liability terms. When writing anything in `docs/compliance/` or touching legal/regulatory claims elsewhere:

- Ground claims in actual current sources (state bar rules, real statutes) via web search — never fabricate a citation or a legal conclusion.
- Write findings as research and a recommended approach, not a definitive legal opinion.
- Explicitly flag that a licensed attorney in the relevant jurisdiction should review the material before it's relied on.
- When in doubt, under-claim. This is a legal product; confident-sounding wrong answers here are a real liability, not just a bug.
