import { alertsRoute } from "@/app/api/calendar-alerts/_lib/route";
import { listNotices } from "@/engines/calendar-alerts/courtNotice/service";
import { queryUuid } from "@/engines/calendar-alerts/http";

export const dynamic = "force-dynamic";

/** c64 — court notices. ?status=unmatched,phishing_review (the admin queue) &matterId= */
export async function GET(req: Request) {
  return alertsRoute("GET /api/calendar-alerts/court-notices", async ({ tx, tenantId }) => {
    const url = new URL(req.url);
    const status = url.searchParams.get("status")?.split(",").filter(Boolean);
    return listNotices(tx, tenantId, { status, matterId: queryUuid(url, "matterId") });
  });
}
