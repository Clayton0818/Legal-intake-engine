import { conflictRoute } from "@/app/api/conflict-check/_lib/route";
import { listLog } from "@/engines/conflict-check/logService";

export const dynamic = "force-dynamic";

/** The conflicts log (c63), newest first. Filters: from, to, outcome, status, trigger, q (name). */
export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  const filter = {
    from: p.get("from") ?? undefined,
    to: p.get("to") ?? undefined,
    outcome: p.get("outcome") ?? undefined,
    status: p.get("status") ?? undefined,
    trigger: p.get("trigger") ?? undefined,
    q: p.get("q") ?? undefined,
  };
  return conflictRoute("GET /api/conflict-check/log", req, ({ tx, tenantId, access }) => listLog(tx, { tenantId, access, filter }), { capability: "log.view" });
}
