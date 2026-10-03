import { alertsRoute, type RouteParams } from "@/app/api/calendar-alerts/_lib/route";
import { computeMatterHealth, matterHealthHistory } from "@/engines/calendar-alerts/health/service";
import { AlertRuleError, getMatter, isFirmAdmin } from "@/engines/calendar-alerts/common";
import { assertUuidParam } from "@/engines/calendar-alerts/http";

export const dynamic = "force-dynamic";

/** c53 — a matter's health history with reasons. INTERNAL ONLY. */
export async function GET(_req: Request, { params }: RouteParams<"matterId">) {
  const { matterId } = await params;
  return alertsRoute("GET /api/calendar-alerts/matters/[matterId]/health", async ({ tx, tenantId, staff }) => {
    const matter = await getMatter(tx, tenantId, assertUuidParam(matterId, "matter id"));
    if (!isFirmAdmin(staff) && matter.assignedUserId !== staff.userId) throw new AlertRuleError("Lawyers see health on their own matters.", 403);
    return matterHealthHistory(tx, tenantId, matter.id);
  });
}

/** Recompute now (e.g. after a reply). */
export async function POST(_req: Request, { params }: RouteParams<"matterId">) {
  const { matterId } = await params;
  return alertsRoute(
    "POST /api/calendar-alerts/matters/[matterId]/health",
    async ({ tx, tenantId, ctx, now }) => {
      const r = await computeMatterHealth(tx, ctx, tenantId, assertUuidParam(matterId, "matter id"), now);
      return { snapshot: r.snapshot, flagged: r.flagged };
    },
    { permission: "ops.act" }
  );
}
