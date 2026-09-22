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
// (src/tenancy/firms.ts) and runs one withTenant()-scoped claim per firm.
// At today's scale (a handful of pilot firms) this is cheap; the "revisit
// when scheduled load approaches ~1k due tasks/minute" trigger from
// ADR-0001 §D6 applies to this loop structure as much as to the four-table
// design generally.

import { sql } from "drizzle-orm";
import { withTenant } from "@/tenancy/withTenant";
import { listActiveFirmIds } from "@/tenancy/firms";
import { scheduledTasks } from "@/db/schema";

const CLAIM_BATCH_SIZE = 100;
const WORKER_ID = `worker-${process.pid}-${Date.now()}`;

async function claimAndProcessForTenant(tenantId: string): Promise<number> {
  return withTenant(tenantId, async (tx) => {
    const due = await tx.execute(sql`
      select id from ${scheduledTasks}
      where due_at <= now() and claimed_at is null and cancelled_at is null
      order by due_at
      for update skip locked
      limit ${CLAIM_BATCH_SIZE}
    `);

    const rows = due as unknown as { id: string }[];
    if (rows.length === 0) return 0;

    for (const row of rows) {
      // Claim immediately so a slow handler in a future tick doesn't
      // double-process the same row. Actual task-type handling (payment
      // reminders, SLA escalations, follow-up cadences) is not implemented
      // yet — this scaffold only proves the claim mechanism works safely
      // under concurrent workers, per ADR-0001 §D6's `SKIP LOCKED` design.
      await tx
        .update(scheduledTasks)
        .set({ claimedAt: new Date(), claimedByWorker: WORKER_ID, completedAt: new Date() })
        .where(sql`${scheduledTasks.id} = ${row.id}`);
    }

    return rows.length;
  });
}

async function main() {
  const firmIds = await listActiveFirmIds();
  let totalClaimed = 0;

  for (const firmId of firmIds) {
    totalClaimed += await claimAndProcessForTenant(firmId);
  }

  console.log(
    `[worker:tick] ${WORKER_ID} checked ${firmIds.length} active firm(s), claimed ${totalClaimed} due task(s).`
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("[worker:tick] failed:", err);
  process.exit(1);
});
