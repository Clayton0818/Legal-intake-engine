import { conflictRoute } from "@/app/api/conflict-check/_lib/route";
import { runPeriodicRecheck } from "@/engines/conflict-check/triggers";

export const dynamic = "force-dynamic";

/**
 * Run the c58 periodic re-check now (conflicts role): open matters are
 * re-checked against parties indexed since the last run. The worker also runs
 * it on the firm's `periodicRecheckIntervalHours` schedule.
 */
export async function POST(req: Request) {
  return conflictRoute(
    "POST /api/conflict-check/recheck",
    req,
    ({ tx, tenantId }) => runPeriodicRecheck(tx, tenantId, new Date(), { queueNext: false }),
    { capability: "index.edit" }
  );
}
