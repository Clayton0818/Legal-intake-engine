import { alertsRoute, type RouteParams } from "@/app/api/calendar-alerts/_lib/route";
import { resumeLadder } from "@/engines/calendar-alerts/ladder/service";
import { requireRole } from "@/engines/calendar-alerts/common";
import { assertUuidParam, readBody, reqString } from "@/engines/calendar-alerts/http";

export const dynamic = "force-dynamic";

/** Resume paused reminders: { reason }. */
export async function POST(req: Request, { params }: RouteParams<"id">) {
  const { id } = await params;
  return alertsRoute(
    "POST /api/calendar-alerts/ladders/[id]/resume",
    async ({ tx, tenantId, staff, ctx, now }) => {
      requireRole(staff, ["attorney", "firm_admin"], "resume client reminders");
      const body = await readBody(req);
      return resumeLadder(tx, ctx, { tenantId, ladderId: assertUuidParam(id, "ladder id"), by: { type: "user", userId: staff.userId }, reason: reqString(body, "reason", 2000), now });
    },
    { permission: "ops.act" }
  );
}
