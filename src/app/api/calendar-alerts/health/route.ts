import { alertsRoute } from "@/app/api/calendar-alerts/_lib/route";
import { listHealthDashboard } from "@/engines/calendar-alerts/health/service";
import { isFirmAdmin } from "@/engines/calendar-alerts/common";
import { queryUuid } from "@/engines/calendar-alerts/http";

export const dynamic = "force-dynamic";

/**
 * c53 — firm health dashboard, highest-ranked first. INTERNAL ONLY. Lawyers see their own matters;
 * firm admins see all (?userId= to filter). &band=green|amber|red &falling=1
 */
export async function GET(req: Request) {
  return alertsRoute("GET /api/calendar-alerts/health", async ({ tx, tenantId, staff }) => {
    const url = new URL(req.url);
    const userId = isFirmAdmin(staff) ? queryUuid(url, "userId") : staff.userId;
    return listHealthDashboard(tx, tenantId, { userId, band: url.searchParams.get("band") ?? undefined, fallingOnly: url.searchParams.get("falling") === "1" });
  });
}
