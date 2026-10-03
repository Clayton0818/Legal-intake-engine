import { alertsRoute, type RouteParams } from "@/app/api/calendar-alerts/_lib/route";
import { draftFromEvent } from "@/engines/calendar-alerts/updates/service";
import { requireRole, ACTING_ROLES, AlertRuleError } from "@/engines/calendar-alerts/common";
import { assertUuidParam, readBody, reqUuid } from "@/engines/calendar-alerts/http";

export const dynamic = "force-dynamic";

/** Draft an update from a CONFIRMED calendar entry: { calendarEventId }. It waits for a lawyer's approval. */
export async function POST(req: Request, { params }: RouteParams<"matterId">) {
  const { matterId } = await params;
  return alertsRoute(
    "POST /api/calendar-alerts/matters/[matterId]/updates/from-event",
    async ({ tx, tenantId, staff, ctx, now }) => {
      requireRole(staff, ACTING_ROLES, "draft client updates");
      const body = await readBody(req);
      const draft = await draftFromEvent(tx, ctx, { tenantId, calendarEventId: reqUuid(body, "calendarEventId"), now });
      if (draft.matterId !== assertUuidParam(matterId, "matter id")) throw new AlertRuleError("That calendar entry belongs to another matter.", 409);
      return draft;
    },
    { permission: "matters.write", status: 201 }
  );
}
