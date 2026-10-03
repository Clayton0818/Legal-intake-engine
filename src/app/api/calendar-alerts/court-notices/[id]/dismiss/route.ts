import { alertsRoute, type RouteParams } from "@/app/api/calendar-alerts/_lib/route";
import { dismissNotice } from "@/engines/calendar-alerts/courtNotice/service";
import { assertUuidParam, readBody, reqString } from "@/engines/calendar-alerts/http";

export const dynamic = "force-dynamic";

/** Dismiss a phishing look-alike or a non-notice: { reason }. The record is kept. */
export async function POST(req: Request, { params }: RouteParams<"id">) {
  const { id } = await params;
  return alertsRoute(
    "POST /api/calendar-alerts/court-notices/[id]/dismiss",
    async ({ tx, tenantId, staff, now }) => {
      const body = await readBody(req);
      return dismissNotice(tx, { tenantId, noticeId: assertUuidParam(id, "notice id"), staff, reason: reqString(body, "reason", 2000), now });
    },
    { permission: "ops.act" }
  );
}
