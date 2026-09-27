# src/engines/

One folder per engine. Engines are built in parallel on top of the
case-management foundation (`src/core`, `src/compliance`, the shared tables),
so the rules below exist to keep seven streams of work from colliding.

## Slugs and what each one owns

| Slug | Engine | Board cards |
|---|---|---|
| `intake` | Intake engine | c48, c65–c74 |
| `conflict-check` | Conflict-check engine | c3, c55–c63, c96, c97 |
| `document` | Document engine | c39–c41, c49, c84–c90 |
| `calendar-alerts` | Calendar & deadline engine: alerts, replies, overdue, email of flags | c42–c47, c51, c53, c54, c64 |
| `calendar-core` | Calendar & deadline engine: matter calendar, deadline calculators, limitations, task lists, stages | c91–c95 |
| `billing-trust` | Billing & trust engine | c50, c52, c75–c83 |
| `all-engines` | Cross-cutting: data import, permissions, mobile, reports, practice-area packs | c98–c105 |

The same list is in code as `ENGINE_SLUGS` (`src/core/engines.ts`).

## Where an engine's files go

```
src/engines/<slug>/**          domain logic + vitest tests (pure functions first)
src/engines/<slug>/gates.ts    this engine's approval gates (optional, discovered automatically)
src/engines/<slug>/worker.ts   worker tick hooks + scheduled-task handlers (optional, discovered automatically)
src/db/tables/<slug>.ts        this engine's tables (already exists as an empty stub)
src/app/api/<slug>/**          API routes
src/app/admin/<slug>/**        admin/staff pages
```

An engine only creates or edits files under those paths.

## What an engine may import

- `@/core` (or `@/core/<module>`): business hours, tasks, flags, notifications, audit, firm settings, practice areas, contacts, shared vocabularies
- `@/compliance/approvals`, `@/compliance/gates`, `@/compliance/server`
- `@/db/schema` and `@/db/tables/foundation` (read them, never edit them), plus its own `@/db/tables/<slug>`
- `@/tenancy/withTenant` (type `TenantTx`), `@/tenancy/route`, `@/tenancy/testing`
- `@/worker/hooks` (types only)

It must **never** import another engine (`@/engines/<other>/**` or
`@/db/tables/<other>`). When two engines need to cooperate, they do it through
the shared tables: tasks, flags, calendar events, documents, parties, the
notification outbox, or audit events. Example: the intake engine creates a
`tasks` row with `kind: "intake.first_response_due"`; the calendar-alerts
engine's overdue scan flags it like any other task, without importing intake.

Shared files (`src/core/**`, `src/compliance/**`, `src/db/schema.ts`,
`src/db/tables/foundation.ts`, `src/worker/**`, `src/tenancy/**`) are not
edited in engine PRs. If the foundation is missing something, say so in the PR
description instead of patching it in place.

## Approval placeholders (the founder's rule)

Write real, working code. Anything that needs legal, accounting or vendor
approval goes through `src/compliance/approvals.ts` instead of being
hard-coded:

| Kind of thing | What to do |
|---|---|
| Client-facing legal wording, disclaimers, consent text, letters | `defineGate({ key: "copy.<slug>.<name>", reviewers: ["attorney"], description, draft })` in your `gates.ts`, then render it with `legalCopy(key, vars)`. Until approved this returns a visible `[PENDING ATTORNEY REVIEW — <description> (gate: <key>)]`. |
| Legal-rule logic: conflict rules, court/deadline rules, limitation periods, trust-accounting rules, fee-agreement terms, retention periods | Call `requireApproval(key, { action, tenantId })` before applying the rule. It throws `PendingApprovalError` and logs the blocked attempt. Never catch it and carry on as if the rule ran; record it with `auditBlocked()` or let the route return 423. Rule values (tables, periods) sit in gated config, never hard-coded as settled law. |
| Any movement of trust money | `requireApproval("rules.trust_accounting", …)`. It needs both an attorney and a CPA. |
| External vendors: email, SMS, calendar sync, e-filing, payments, mailbox access, AI model calls, e-signature, storage | Put the vendor behind an interface with a stub adapter that records to the outbox or log instead of sending, and gate the real call on the shared `vendor.*` gate. |
| Numbers the founder already set (24h/48h replies, $4,500 retainer floor, Family Law default…) | Not gates. These are firm settings in `firm_settings` (see `getFirmSettings()`). Engine-specific settings go in `engineSettings[<slug>]` via `engineSetting()` / `updateEngineSettings()`. |

Reuse the shared gates in `src/compliance/gates.ts` (`VENDOR_GATES`,
`RULE_GATES`, `NOTIFY_COPY_GATES`). Don't define a second gate for the same
vendor or rule set. Gate keys an engine defines should start with a namespace
such as `copy.<slug>.…` or `rules.<slug>.…` so they can't collide.

`runGated(key, action, fn)` returns `{ ok: false, blocked }` instead of
throwing, for flows that should record "blocked" and continue with something
else. Approvals are recorded by an operator with
`npm run compliance -- approve --gate <key> --reviewer <kind> --by "<name>"`,
and `npm run compliance -- list` shows everything still pending. Changing a
gate's `draft` automatically re-closes it until it is reviewed again.

## Founder decisions the core already enforces

- **Business hours vs real clock.** Firm timers count the firm's business
  hours (`addBusinessHours`, `businessHoursBetween`, or `createTask` with
  `due: { hours, clock: "business" }`). Court notices and deadline safety nets
  use the real clock (`clock: "real"`, or `deadlineCritical: true`, which
  forces the real clock, no grace period and critical severity).
- **Internal flags stay internal.** `raiseFlag({ audience: "internal" })` can
  never be addressed to a client, and the database enforces this too.
  Client-facing queries must use `listClientFlags` / `listClientTasks` or pass
  rows through `clientVisible()`.
- **Every flag also emails the affected party.** `raiseFlag` queues in-app and
  email rows per recipient. Client emails carry only ids (minimal content),
  use only approved wording, and go only to the DV-safe address from
  `resolveClientAddress()`. Nothing leaves while `vendor.email` is pending: the
  row is held with the placeholder as its reason.
- **The AI never gives legal advice, never decides a deadline, never clears a
  conflict.** Log AI output with `actor: { type: "ai", model }`. Calendar
  events start as `proposed`, and only a lawyer can confirm them
  (`canConfirmEvent`, plus a CHECK constraint).

## Worker hooks and scheduled tasks

Export `worker` from `src/engines/<slug>/worker.ts`:

```ts
import type { EngineWorkerModule } from "@/worker/hooks";

export const worker: EngineWorkerModule = {
  tickHooks: [{ name: "<slug>.overdue_scan", engine: "<slug>", run: async ({ tx, tenantId, now }) => ({ flagged: 0 }) }],
  scheduledTaskHandlers: { "<slug>.send_reminder": async ({ tx, tenantId, task, now }) => { /* … */ } },
};
```

Names must start with `<slug>.`. Each hook runs once per active firm per tick,
in its own tenant transaction. A failing scheduled-task handler is rolled back
to a savepoint and retried on the next tick.

## Tables

Put tables in `src/db/tables/<slug>.ts` following the conventions at the top
of `src/db/tables/foundation.ts`: a NOT NULL `tenantId` referencing `firms.id`
on every tenant-scoped table, text plus CHECK constraints for statuses, and
`timestamptz` for times. **Do not generate migrations.** The integration step
runs `npm run db:generate` once for everyone. Add a `MIGRATION NOTES` comment
at the bottom of your table file listing the RLS policies and GRANTs your
tables need (copy the pattern from foundation.ts).

## Routes

```ts
// src/app/api/<slug>/things/route.ts
import { tenantRoute } from "@/tenancy/route";
export const dynamic = "force-dynamic";
export async function GET() {
  return tenantRoute("GET /api/<slug>/things", ({ tx, tenantId }) => listThings(tx, tenantId));
}
```

`tenantRoute` resolves the tenant, opens `withTenant()` lazily (so `next build`
never needs a database), loads approvals, and turns a `PendingApprovalError`
into HTTP 423 with the visible placeholder.

## Tests

Pure domain logic gets plain vitest tests next to the code. Tests that need a
real database use `describeWithDb` and `loadDb()` from `@/tenancy/testing`.
They are skipped when `DATABASE_URL` is unset. See
`src/core/foundation.db.test.ts` for an example that runs inside one
rolled-back transaction and skips itself until the tables it needs have been
migrated. Before opening a PR, run `npm run typecheck`, `npm run lint` and
`npm test`.
