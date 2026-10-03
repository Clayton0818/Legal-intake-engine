import { alertsRoute } from "@/app/api/calendar-alerts/_lib/route";
import { listOverdueWork } from "@/engines/calendar-alerts/overdue/service";
import { AlertRuleError, isFirmAdmin } from "@/engines/calendar-alerts/common";
import { queryUuid } from "@/engines/calendar-alerts/http";

export const dynamic = "force-dynamic";

/**
 * c45 — overdue and due-soon work. INTERNAL ONLY. ?scope=mine (default: your own tasks) | firm (firm admin only)
 * &matterId=
 */
export async function GET(req: Request) {
  return alertsRoute("GET /api/calendar-alerts/overdue", async ({ tx, tenantId, staff, ctx, now }) => {
    const url = new URL(req.url);
    const scope = url.searchParams.get("scope") ?? "mine";
    if (scope === "firm" && !isFirmAdmin(staff)) throw new AlertRuleError("Only a firm admin can see the whole firm's overdue work.", 403);
    if (scope !== "firm" && scope !== "mine") throw new AlertRuleError("scope must be 'mine' or 'firm'.");
    return listOverdueWork(tx, ctx, tenantId, now, { userId: scope === "mine" ? staff.userId : undefined, matterId: queryUuid(url, "matterId") });
  });
}
