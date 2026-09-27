// ADR-0001 §D6: "The worker wakes each minute, claims due rows with
// SELECT ... FOR UPDATE SKIP LOCKED, and advances them." This is that
// worker's entry point — invoked as `npm run worker:tick`, which is what
// both a real persistent worker process and the staging GitHub Actions
// stand-in (.github/workflows/staging-worker.yml) call.
//
// Deliberately per-tenant rather than one global query: `scheduled_tasks`
// IS tenant-scoped and RLS-protected, so there is no single query the
// app_runtime role can run that sees due rows across every firm at once —
// by design, per ADR-0001 §D5. Instead this loops over known firms
// (src/tenancy/firms.ts) and runs withTenant()-scoped work per firm.
// At today's scale (a handful of pilot firms) this is cheap; the "revisit
// when scheduled load approaches ~1k due tasks/minute" trigger from
// ADR-0001 §D6 applies to this loop structure as much as to the four-table
// design generally.
//
// Case-management foundation additions (see ./hooks.ts):
//   - approval gates are loaded from `compliance_approvals` first; if that
//     fails, EVERY gate is treated as pending (fail safe);
//   - claimed scheduled_tasks rows are dispatched to the engine handler for
//     their task_type (src/engines/<slug>/worker.ts);
//   - tick hooks run per firm (core: drain the notification outbox through
//     the stub/real providers; engines: their own scans).

import { and, asc, eq, isNull, lte } from "drizzle-orm";
import { withTenant } from "@/tenancy/withTenant";
import { listActiveFirmIds } from "@/tenancy/firms";
import { scheduledTasks } from "@/db/schema";
import { ensureServerApprovals } from "@/compliance/server";
import { buildRegistry, loadEngineWorkerModules, runTenantHooks, type WorkerRegistry } from "./hooks";

const CLAIM_BATCH_SIZE = 100;
const WORKER_ID = `worker-${process.pid}-${Date.now()}`;

interface ClaimReport {
  claimed: number;
  handled: number;
  unhandled: number;
  failed: number;
}

async function claimAndProcessForTenant(tenantId: string, registry: WorkerRegistry, now: Date): Promise<ClaimReport> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(scheduledTasks)
      .where(and(lte(scheduledTasks.dueAt, now), isNull(scheduledTasks.claimedAt), isNull(scheduledTasks.cancelledAt)))
      .orderBy(asc(scheduledTasks.dueAt))
      .limit(CLAIM_BATCH_SIZE)
      .for("update", { skipLocked: true });

    const report: ClaimReport = { claimed: 0, handled: 0, unhandled: 0, failed: 0 };
    for (const row of rows) {
      const entry = registry.handlers.get(row.taskType);
      if (entry) {
        try {
          // Savepoint: a failing handler rolls back only its own writes.
          await tx.transaction(async (sp) => entry.handler({ tx: sp, tenantId, now, task: row }));
          report.handled++;
        } catch (err) {
          // Left unclaimed so the next tick retries it; logged loudly.
          console.error(
            JSON.stringify({
              level: "error",
              event: "worker.scheduled_task_failed",
              taskId: row.id,
              taskType: row.taskType,
              engine: entry.engine,
              tenantId,
              error: err instanceof Error ? err.message : String(err),
            })
          );
          report.failed++;
          continue;
        }
      } else {
        // No engine handles this type (yet): keep the original scaffold
        // behaviour of claiming it so it is not re-examined every minute.
        console.warn(JSON.stringify({ level: "warn", event: "worker.scheduled_task_unhandled", taskType: row.taskType, tenantId }));
        report.unhandled++;
      }
      await tx
        .update(scheduledTasks)
        .set({ claimedAt: new Date(), claimedByWorker: WORKER_ID, completedAt: new Date() })
        .where(eq(scheduledTasks.id, row.id));
      report.claimed++;
    }
    return report;
  });
}

async function main() {
  await ensureServerApprovals(0); // fresh every tick; fails safe (nothing approved) if unreadable
  const registry = buildRegistry(await loadEngineWorkerModules());
  const firmIds = await listActiveFirmIds();
  const now = new Date();
  const totals: ClaimReport = { claimed: 0, handled: 0, unhandled: 0, failed: 0 };
  let hookFailures = 0;

  for (const firmId of firmIds) {
    const r = await claimAndProcessForTenant(firmId, registry, now);
    totals.claimed += r.claimed;
    totals.handled += r.handled;
    totals.unhandled += r.unhandled;
    totals.failed += r.failed;

    const reports = await runTenantHooks(firmId, registry.hooks, withTenant, now);
    for (const rep of reports) {
      if (!rep.ok) {
        hookFailures++;
        console.error(JSON.stringify({ level: "error", event: "worker.hook_failed", hook: rep.name, tenantId: firmId, error: rep.error }));
      }
    }
  }

  console.log(
    `[worker:tick] ${WORKER_ID} checked ${firmIds.length} active firm(s): claimed ${totals.claimed} due task(s) ` +
      `(${totals.handled} handled, ${totals.unhandled} with no handler, ${totals.failed} failed and left for retry); ` +
      `${registry.hooks.length} hook(s) per firm, ${hookFailures} hook failure(s).`
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("[worker:tick] failed:", err);
  process.exit(1);
});
