import { alertsRoute, type RouteParams } from "@/app/api/calendar-alerts/_lib/route";
import { setCheckBack } from "@/engines/calendar-alerts/stall/service";
import { requireRole, ACTING_ROLES } from "@/engines/calendar-alerts/common";
import { assertUuidParam, readBody, reqDateTime, reqString } from "@/engines/calendar-alerts/http";

export const dynamic = "force-dynamic";

/** "Waiting on the court until Oct 10": { reason, checkBackAt }. Clears the flag until then; logged. */
export async function POST(req: Request, { params }: RouteParams<"id">) {
  const { id } = await params;
  return alertsRoute(
    "POST /api/calendar-alerts/stalls/[id]/check-back",
    async ({ tx, tenantId, staff, ctx, now }) => {
      requireRole(staff, ACTING_ROLES, "set check-back dates");
      const body = await readBody(req);
      return setCheckBack(tx, ctx, { tenantId, watchId: assertUuidParam(id, "stall id"), userId: staff.userId, reason: reqString(body, "reason", 2000), checkBackAt: reqDateTime(body, "checkBackAt"), now });
    },
    { permission: "ops.act" }
  );
}
