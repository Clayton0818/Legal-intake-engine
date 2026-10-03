import { alertsRoute, type RouteParams } from "@/app/api/calendar-alerts/_lib/route";
import { changeClockTier } from "@/engines/calendar-alerts/replyClock/service";
import { requireRole, ACTING_ROLES } from "@/engines/calendar-alerts/common";
import { assertUuidParam, oneOf, readBody, reqString } from "@/engines/calendar-alerts/http";

export const dynamic = "force-dynamic";

/** Staff re-tag (c44 §4.9): { tier: 'standard'|'deadline', reason }. Replanned from the original start; logged. */
export async function POST(req: Request, { params }: RouteParams<"id">) {
  const { id } = await params;
  return alertsRoute(
    "POST /api/calendar-alerts/reply-clocks/[id]/tier",
    async ({ tx, tenantId, staff, ctx, now }) => {
      requireRole(staff, ACTING_ROLES, "re-tag messages");
      const body = await readBody(req);
      return changeClockTier(tx, ctx, { tenantId, clockId: assertUuidParam(id, "clock id"), tier: oneOf(body, "tier", ["standard", "deadline"] as const), userId: staff.userId, reason: reqString(body, "reason", 2000), now });
    },
    { permission: "ops.act" }
  );
}
