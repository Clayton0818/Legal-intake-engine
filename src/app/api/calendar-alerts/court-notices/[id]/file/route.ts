import { alertsRoute, type RouteParams } from "@/app/api/calendar-alerts/_lib/route";
import { fileNoticeToMatter } from "@/engines/calendar-alerts/courtNotice/service";
import { assertUuidParam, readBody, reqUuid } from "@/engines/calendar-alerts/http";

export const dynamic = "force-dynamic";

/** Admin queue: file a notice to a matter: { matterId }. Its cause numbers are remembered; the lawyer is alerted. */
export async function POST(req: Request, { params }: RouteParams<"id">) {
  const { id } = await params;
  return alertsRoute(
    "POST /api/calendar-alerts/court-notices/[id]/file",
    async ({ tx, tenantId, staff, ctx, now }) => {
      const body = await readBody(req);
      return fileNoticeToMatter(tx, ctx, { tenantId, noticeId: assertUuidParam(id, "notice id"), matterId: reqUuid(body, "matterId"), staff, now });
    },
    { permission: "ops.act" }
  );
}
