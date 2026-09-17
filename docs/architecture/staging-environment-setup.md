# Staging Environment Setup — Runbook

**Status:** Design + operational runbook for board card `c20`. Item 10 in `CLAUDE.md`'s dependency order.
**Depends on:** ADR-0001 (`c18`, PR #5 — merged).
**Consumed by:** `c19` (data model — the worker and app both read this doc's connection conventions), `c21` (API scaffold — first thing that actually deploys to what this sets up), `c31` (branch protection — the required-checks list this doc's CI workflow feeds).

## 1. Why this shape, not ADR-0001's literal recommendation

ADR-0001 §D7 recommends Render or Railway as a single managed platform running web service, worker, cron, and Postgres together — clean, one console, minimal ops. That recommendation assumed a paid plan. Checked against current (2026) pricing, none of the platforms the ADR considered still offer a genuinely free way to run all four pieces together: Render's free tier is web-service-only (no free background worker or cron job); Railway now requires a post-paid card with no meaningful free allowance; Fly.io's free tier is down to a 2-VM-hour trial.

So staging specifically — never production, see §5 — trades §D7's one-console simplicity for three free-tier services doing what each is actually free at:

| Piece | Provider | Why this one |
|---|---|---|
| Database | Supabase (free) | The only free tier that gives a real Postgres connection string, full RLS support, and a pooler exposing both transaction and session modes — the actual mechanism §D5 depends on, not a vendor abstraction over it |
| Web app | Render (free web service) | Free indefinitely; the honest cost is a cold start after 15 minutes idle |
| Worker | GitHub Actions (scheduled workflow, this repo) | Render's free tier has no background-worker or cron product at all; a scheduled Action is the free substitute — see §4 for why this is staging-only, not a production design |

This is a staging-only deviation. Production still follows §D7 as written once there's revenue or funding to justify a paid single-platform setup — nothing here should be read as walking back that decision.

## 2. Supabase: project creation and connection strings

**Steps (Clayton — account creation isn't something this automation can do):**

1. Create a free account at supabase.com and a new project. Choose a region close to Texas (per ADR-0001 §D7's US-region reasoning — `us-east-1` or similar).
2. In Project Settings → Database, note two distinct connection strings, not one:
   - **Session pooler** (port `5432` via the pooler host, or the direct connection) — a dedicated backend connection per client. Not what this project uses for application traffic (see below), but useful for one-off manual `psql` access during setup.
   - **Transaction pooler** (port `6543`, Supavisor) — connections are handed back to the pool at transaction end, not held per-client.
3. **Use the transaction-pooler connection string for everything the application and worker do.** This is the one real technical decision in this section, and it's directly downstream of ADR-0001 §D5: the whole reason §D5 mandates `SET LOCAL` inside an explicit transaction rather than a session-level `SET` is that the tenant-scoping value must not survive past the transaction that set it, specifically because it might get reused by a different tenant's request under a transaction-mode pooler. Supabase's transaction pooler is exactly that pooling mode. Using it in staging is what makes staging an actual test of §D5's mechanism rather than a pooling configuration that happens to be too forgiving to catch a bug production would hit.
4. Enable Row Level Security on every tenant-scoped table as it's created (`c19`'s job), and confirm the connection role used by the app does **not** have `BYPASSRLS` — Supabase's default `postgres` role does have superuser-equivalent bypass; create a separate, narrower application role for this, mirroring §D5's "the application's database role must not hold `BYPASSRLS`" requirement exactly. Using the default role here would make staging structurally unable to catch the one bug class §D5 exists to catch.
5. Store the transaction-pooler connection string as a GitHub repo secret (`Settings → Secrets and variables → Actions`), named `DATABASE_URL_STAGING`. **Never commit it to the repo, and never paste it into a chat with this automation** — there is no tool available to this automation for managing repo secrets, and pasting a live connection string into conversation text is exactly the kind of exposure that's hard to fully undo.
6. Separately, add the same value as an environment variable directly in Render's dashboard (`DATABASE_URL`) for the web service — Render's environment variables are also not something this automation can set; that's a step only Clayton can do in Render's own UI.

**Known limitation:** the free project pauses after seven days of inactivity. Staging traffic is inherently bursty (a demo, a pilot-firm call), so expect to click "resume" in Supabase's dashboard before a session after a quiet week. Not a defect to fix — a property of the free tier to plan around.

## 3. Render: web service configuration

1. New → Web Service, connect the `Clayton0818/Legal-intake-engine` GitHub repo, branch `main`.
2. Runtime: Node. Build command and start command depend on `c21`'s actual scaffold once it exists (likely `npm run build` / `npm start` for the Next.js surface per ADR-0001 §D3) — this doc doesn't fix those commands because the package layout isn't decided yet; update this section when `c21` lands.
3. Environment variables (set in Render's dashboard, not in the repo): `DATABASE_URL` (the Supabase transaction-pooler string from §2), plus whatever `c19`/`c21` end up requiring (model vendor key behind the `llm/` adapter per ADR-0001 §D9, auth provider keys per §D8).
4. Instance type: Free.
5. **Do not enable production tenant creation on this service.** Per ADR-0001 §D9's control: production tenant creation stays behind a flag until `c1`/`c2`/`c26` and the model vendor's DPA all clear. This Render service is staging by construction — the flag should default off here permanently, not just until launch.

**Known limitation:** the free web service spins down after 15 minutes without inbound traffic and takes about a minute to wake back up on the next request. Fine for internal review and a scheduled demo; worth warning a pilot firm about if they're ever given a direct staging link ad hoc.

## 4. The worker: a scheduled GitHub Actions workflow, and why it's a staging-only stand-in

ADR-0001 §D6 specifies a persistent worker that wakes every minute and claims due rows from `scheduled_tasks` with `SELECT ... FOR UPDATE SKIP LOCKED`. Render's free tier has no product for a persistent non-web process — Background Workers and Cron Jobs both require a paid plan. The free substitute is a GitHub Actions workflow on a `schedule` trigger (`.github/workflows/staging-worker.yml` — see the PR description for its contents; this connector could not write directly into `.github/workflows/` — see §6).

**This is not the same thing as §D6's worker, and the gap is worth naming precisely rather than papering over:**

- GitHub's `schedule` trigger is not punctual. Documented and commonly observed behavior is delays of several minutes during high load on GitHub's scheduler, so `*/5 * * * *` (every 5 minutes) is a more honest cadence to design around than `*/1 * * * *`, even though the cron syntax accepts the latter.
- Each run is a fresh checkout and a fresh process — there's no persistent worker holding state between ticks, which is actually fine for §D6's design (each tick is meant to be stateless and idempotent, claiming rows via `SKIP LOCKED`), but it does mean cold-start overhead (checkout, `npm ci`) on every single tick, which would be wasteful and slow at production volumes.
- **Revisit trigger:** the moment there's a paid hosting plan (i.e., the moment `c32` happens with a budget behind it), this workflow should be retired in favor of the real persistent worker §D6 describes. This file should not quietly become "how production works" by default — flagging that explicitly here so it isn't lost.

The workflow file itself is written to be safe to merge today, before `c19`/`c21` exist: it checks for a `worker:tick` script in `package.json` and exits cleanly with a log message if that script doesn't exist yet, rather than failing on every run. It activates automatically — no further edits needed — the moment `c21` defines that script.

## 5. The compliance gate this doesn't change

None of the above alters ADR-0001's own gate: production tenant creation stays flagged off, and no real client data reaches this staging environment (or any environment) before `c1`, `c2`, and `c26` clear and a DPA is signed with the model vendor per §D9. Everything this staging environment ever sees should be synthetic — the same synthetic transcripts `c13`'s eval suite already uses (§8 of that document). A free-tier database with a 500MB cap and a compliance posture nobody's independently audited is a second, independent reason this was never going to be where real client data lives, on top of the reason that was already true regardless of hosting cost.

## 6. Why the two workflow files aren't in this commit

GitHub Apps (and the token behind this connector) require a distinct `workflows` permission scope to create or update anything under `.github/workflows/`, separate from ordinary write access to repo contents — pushing `ci.yml` and `staging-worker.yml` through this connector failed with a 403 ("Resource not accessible by integration"). Their full content is in this PR's description instead. Adding them requires either: pasting them in through GitHub's own web UI (Add file → Create new file, under `.github/workflows/`), or granting this GitHub App the Actions/workflows write permission it's currently missing, if there's a place to do that in how this integration was installed.

## 7. Explicitly not included

- Actual build/start commands for Render (§3) — depend on `c21`'s package layout, not yet decided.
- The real cross-tenant isolation test and migration-review logic — placeholders only, per `c19`/`c21`'s job.
- Making any of these workflow checks *required* on `main` — that's `c31` (branch protection), still blocked on the same GitHub ruleset limitation the board already notes: this connector has no tools for managing branch protection rules.
- A production hosting setup — this document is staging-only throughout; §D7 stands for production once there's budget for it.

## Sources

- ADR-0001 (`docs/architecture/adr/0001-initial-technology-stack.md`) — §D5 (the pooling-safety mechanism this whole runbook is built around), §D6 (the worker design this GitHub Actions workflow stands in for), §D7 (the production hosting recommendation this staging setup deliberately departs from and why), §D9 (the production-data gate this staging environment stays behind).
- Render's own free-tier documentation and Supabase's own pricing/connection documentation — current limits (free web service spin-down, free Postgres pause-after-inactivity, transaction vs. session pooler modes) checked against 2026 pricing rather than assumed from general familiarity with these platforms, since free-tier terms change often.

## Review notes

This is infrastructure planning, not a compliance document, so it doesn't carry the same "needs attorney review" flag as `c1`/`c2`/`c6`/`c9`. The one thing worth a second pair of eyes: whether the GitHub Actions worker stand-in (§4) is an acceptable staging compromise or whether it's worth just waiting on a small paid plan before building anything worker-shaped at all — this document assumes staging value now is worth the gap, but that's a judgment call, not a technical fact.
