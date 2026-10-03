import { alertsRoute, type RouteParams } from "@/app/api/calendar-alerts/_lib/route";
import { getNoticeDetail } from "@/engines/calendar-alerts/courtNotice/service";
import { assertUuidParam } from "@/engines/calendar-alerts/http";

export const dynamic = "force-dynamic";

/** One court notice with its attachments (metadata) and date suggestions. INTERNAL ONLY. */
export async function GET(_req: Request, { params }: RouteParams<"id">) {
  const { id } = await params;
  return alertsRoute("GET /api/calendar-alerts/court-notices/[id]", async ({ tx, tenantId }) => getNoticeDetail(tx, tenantId, assertUuidParam(id, "notice id")));
}
