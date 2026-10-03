// Counts for the admin page (/admin/calendar-alerts). Numbers only: the staff
// console is not access-controlled yet, so records stay behind the
// role-checked API.

import { and, eq, inArray, isNull, lte, ne, sql } from "drizzle-orm";
import { tasks } from "@/db/tables/foundation";
import { clientChaseLadders, clientUpdates, courtNotices, replyClocks, stallWatches } from "@/db/tables/calendar-alerts";
import type { TenantTx } from "@/tenancy/withTenant";
import { listHealthDashboard } from "./health/service";

export interface AlertSummary {
  openReplyClocks: number;
  promisesMissed: number;
  overdueTasks: number;
  overdueDeadlineTasks: number;
  activeClientChases: number;
  stalledItems: number;
  courtNoticesUnacknowledged: number;
  courtNoticesUnmatched: number;
  possiblePhishing: number;
  draftsAwaitingApproval: number;
  health: Record<string, number>;
}

async function count(q: Promise<Array<{ n: number }>>): Promise<number> {
  const [r] = await q;
  return r?.n ?? 0;
}

export async function alertSummary(tx: TenantTx, tenantId: string, now: Date): Promise<AlertSummary> {
  const n = sql<number>`count(*)::int`;
  const health: Record<string, number> = { green: 0, amber: 0, red: 0, insufficient_data: 0 };
  for (const row of await listHealthDashboard(tx, tenantId)) health[row.band] = (health[row.band] ?? 0) + 1;
  return {
    openReplyClocks: await count(tx.select({ n }).from(replyClocks).where(and(eq(replyClocks.tenantId, tenantId), eq(replyClocks.status, "open")))),
    promisesMissed: await count(tx.select({ n }).from(replyClocks).where(and(eq(replyClocks.tenantId, tenantId), eq(replyClocks.status, "open"), lte(replyClocks.promiseAt, now)))),
    overdueTasks: await count(tx.select({ n }).from(tasks).where(and(eq(tasks.tenantId, tenantId), eq(tasks.status, "open"), ne(tasks.ownerType, "client"), lte(tasks.dueAt, now)))),
    overdueDeadlineTasks: await count(tx.select({ n }).from(tasks).where(and(eq(tasks.tenantId, tenantId), eq(tasks.status, "open"), eq(tasks.deadlineCritical, true), lte(tasks.dueAt, now)))),
    activeClientChases: await count(tx.select({ n }).from(clientChaseLadders).where(and(eq(clientChaseLadders.tenantId, tenantId), inArray(clientChaseLadders.status, ["active", "paused", "awaiting_lawyer"])))),
    stalledItems: await count(tx.select({ n }).from(stallWatches).where(and(eq(stallWatches.tenantId, tenantId), eq(stallWatches.status, "flagged")))),
    courtNoticesUnacknowledged: await count(tx.select({ n }).from(courtNotices).where(and(eq(courtNotices.tenantId, tenantId), inArray(courtNotices.status, ["matched", "unmatched"]), isNull(courtNotices.acknowledgedAt)))),
    courtNoticesUnmatched: await count(tx.select({ n }).from(courtNotices).where(and(eq(courtNotices.tenantId, tenantId), eq(courtNotices.status, "unmatched")))),
    possiblePhishing: await count(tx.select({ n }).from(courtNotices).where(and(eq(courtNotices.tenantId, tenantId), eq(courtNotices.status, "phishing_review")))),
    draftsAwaitingApproval: await count(tx.select({ n }).from(clientUpdates).where(and(eq(clientUpdates.tenantId, tenantId), eq(clientUpdates.status, "pending_approval")))),
    health,
  };
}
