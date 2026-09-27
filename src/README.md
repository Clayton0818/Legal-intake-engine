# src/

The application code (board card `c21`, "the first real commit into `src/`"). Built against the stack ADR-0001 settled: TypeScript, Next.js (App Router), Drizzle ORM over Postgres via `postgres.js`, deployed to Render with Supabase (transaction-pooler mode) as the database.

## Layout

- `app/` — the Next.js surfaces. `api/health/` is a real, working health check; everything else here is a placeholder until `c23` (client-facing chat) or `c24` (admin console) lands.
- `middleware.ts` — an **auth stub**, not real authentication. See the file's own comment before building anything that trusts it.
- `db/schema.ts` — the Drizzle schema implementing `docs/architecture/core-data-model-schema-design.md` (`c19`). `db/migrate.ts` applies `migrations/*.sql` against a real database.
- `tenancy/` — `withTenant()`, the mandatory tenant-scoping wrapper ADR-0001 §D5 requires. This is the *only* way anything in this codebase is meant to touch the database — see `tenancy/withTenant.ts` and `tenancy/db.ts` for why, and `tenancy/withTenant.isolation.test.ts` for the required cross-tenant isolation check that proves it.
- `worker/tick.ts` — the ADR-0001 §D6 background worker's entry point (`npm run worker:tick`), claiming due `scheduled_tasks` rows, dispatching them to engine handlers, and running per-firm tick hooks (`worker/hooks.ts`; core drains the notification outbox).
- `db/tables/` — case-management tables: `foundation.ts` (shared: firm settings, calendar events, tasks, flags, notification outbox, audit events, compliance approvals) and one file per engine.
- `core/` — the shared case-management core every engine builds on: business-hours arithmetic, tasks, flags (internal/client audience), notifications (outbox + stub email/SMS providers), one-line audit logging, firm settings, practice areas, safe-contact resolution.
- `compliance/` — **approval placeholders**. Anything that needs attorney, CPA, vendor-DPA or founder sign-off is a gate: user-facing wording comes from `legalCopy()` (a visible `[PENDING … REVIEW …]` placeholder until approved) and gated actions call `requireApproval()`, which blocks and logs. `npm run compliance -- list` shows what is still pending.
- `engines/` — one folder per engine; `engines/README.md` is the layout and import contract.
- `flow/`, `integrations/`, `llm/`, `scheduler/`, `audit/` — module layout stubs per ADR-0001 §D2. Each has its own README explaining what belongs there and which board card is expected to fill it in first.

## Running this locally

```bash
npm install
cp .env.example .env.local   # fill in DATABASE_URL from your own Supabase project
npm run db:migrate           # requires MIGRATIONS_DATABASE_URL (an elevated role, not app_runtime)
npm run dev
```

`npm run test:isolation` runs the required cross-tenant isolation check against whatever `DATABASE_URL` points at — see that test file's own comments for why it needs a real database, not a mock.
