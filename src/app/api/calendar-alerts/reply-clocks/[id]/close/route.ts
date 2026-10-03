import { alertsRoute, type RouteParams } from "@/app/api/calendar-alerts/_lib/route";
import { closeClock } from "@/engines/calendar-alerts/replyClock/service";
import { requireRole, ACTING_ROLES } from "@/engines/calendar-alerts/common";
import { assertUuidParam, readBody, reqString } from "@/engines/calendar-alerts/http";

export const dynamic = "force-dynamic";

/** "No reply needed" (c43 rule 9): { reason }. Logged. */
export async function POST(req: Request, { params }: RouteParams<"id">) {
  const { id } = await params;
  return alertsRoute(
    "POST /api/calendar-alerts/reply-clocks/[id]/close",
    async ({ tx, tenantId, staff, now }) => {
      requireRole(staff, ACTING_ROLES, "close reply clocks");
      const body = await readBody(req);
      return closeClock(tx, { tenantId, clockId: assertUuidParam(id, "clock id"), userId: staff.userId, reason: reqString(body, "reason", 2000), now });
    },
    { permission: "ops.act" }
  );
}
