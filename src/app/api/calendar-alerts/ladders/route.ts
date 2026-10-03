import { alertsRoute } from "@/app/api/calendar-alerts/_lib/route";
import { listLadders } from "@/engines/calendar-alerts/ladder/service";
import { queryUuid } from "@/engines/calendar-alerts/http";

export const dynamic = "force-dynamic";

/** c42/c46 chase ladders. ?matterId= &all=1 (include finished ones). */
export async function GET(req: Request) {
  return alertsRoute("GET /api/calendar-alerts/ladders", async ({ tx, tenantId }) => {
    const url = new URL(req.url);
    return listLadders(tx, tenantId, { matterId: queryUuid(url, "matterId"), openOnly: url.searchParams.get("all") !== "1" });
  });
}
