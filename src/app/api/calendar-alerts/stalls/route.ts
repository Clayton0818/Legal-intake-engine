import { alertsRoute } from "@/app/api/calendar-alerts/_lib/route";
import { listStalls } from "@/engines/calendar-alerts/stall/service";

export const dynamic = "force-dynamic";

/** c47 — stalled items (flagged and on check-back). INTERNAL ONLY. */
export async function GET(req: Request) {
  return alertsRoute("GET /api/calendar-alerts/stalls", async ({ tx, tenantId }) =>
    listStalls(tx, tenantId, { includeCheckBack: new URL(req.url).searchParams.get("flaggedOnly") !== "1" })
  );
}
