import { alertsRoute, type RouteParams } from "@/app/api/calendar-alerts/_lib/route";
import { pauseLadder } from "@/engines/calendar-alerts/ladder/service";
import { requireRole } from "@/engines/calendar-alerts/common";
import { assertUuidParam, readBody, reqString } from "@/engines/calendar-alerts/http";

export const dynamic = "force-dynamic";

/** The lawyer pauses automatic reminders: { reason }. */
export async function POST(req: Request, { params }: RouteParams<"id">) {
  const { id } = await params;
  return alertsRoute(
    "POST /api/calendar-alerts/ladders/[id]/pause",
    async ({ tx, tenantId, staff, now }) => {
      requireRole(staff, ["attorney", "firm_admin"], "pause client reminders");
      const body = await readBody(req);
      return pauseLadder(tx, { tenantId, ladderId: assertUuidParam(id, "ladder id"), userId: staff.userId, reason: reqString(body, "reason", 2000), now });
    },
    { permission: "ops.act" }
  );
}
