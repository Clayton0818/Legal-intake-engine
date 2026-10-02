import { conflictRoute } from "@/app/api/conflict-check/_lib/route";
import { openQueue } from "@/engines/conflict-check/logService";

export const dynamic = "force-dynamic";

/** Checks waiting on a decision, oldest first, with business-hours waiting time (c63 §4.2). */
export async function GET(req: Request) {
  return conflictRoute("GET /api/conflict-check/queue", req, ({ tx, tenantId, access }) => openQueue(tx, { tenantId, access }), { capability: "queue.view" });
}
