import { alertsRoute, type RouteParams } from "@/app/api/calendar-alerts/_lib/route";
import { acknowledgeNotice } from "@/engines/calendar-alerts/courtNotice/service";
import { assertUuidParam } from "@/engines/calendar-alerts/http";

export const dynamic = "force-dynamic";

/** A person acknowledges the court-notice alert (stops escalation; logged). */
export async function POST(_req: Request, { params }: RouteParams<"id">) {
  const { id } = await params;
  return alertsRoute(
    "POST /api/calendar-alerts/court-notices/[id]/acknowledge",
    async ({ tx, tenantId, staff, now }) => acknowledgeNotice(tx, { tenantId, noticeId: assertUuidParam(id, "notice id"), staff, now }),
    { permission: "flags.acknowledge" }
  );
}
