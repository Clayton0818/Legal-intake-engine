import { alertsRoute } from "@/app/api/calendar-alerts/_lib/route";
import { listOpenClocks } from "@/engines/calendar-alerts/replyClock/service";
import { queryUuid } from "@/engines/calendar-alerts/http";

export const dynamic = "force-dynamic";

/** Open reply clocks (c43/c44), soonest client promise first. ?matterId= */
export async function GET(req: Request) {
  return alertsRoute("GET /api/calendar-alerts/reply-clocks", async ({ tx, tenantId }) => listOpenClocks(tx, tenantId, { matterId: queryUuid(new URL(req.url), "matterId") }));
}
