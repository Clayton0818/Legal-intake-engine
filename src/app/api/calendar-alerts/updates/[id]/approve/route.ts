import { alertsRoute, type RouteParams } from "@/app/api/calendar-alerts/_lib/route";
import { approveUpdate } from "@/engines/calendar-alerts/updates/service";
import { assertUuidParam, optString, readBody } from "@/engines/calendar-alerts/http";

export const dynamic = "force-dynamic";

/** Lawyer approval of a drafted update: { editedBody? }. Stale drafts are refused. */
export async function POST(req: Request, { params }: RouteParams<"id">) {
  const { id } = await params;
  return alertsRoute(
    "POST /api/calendar-alerts/updates/[id]/approve",
    async ({ tx, tenantId, staff, ctx, now }) => {
      const body = await readBody(req);
      return approveUpdate(tx, ctx, { tenantId, updateId: assertUuidParam(id, "update id"), staff, editedBody: optString(body, "editedBody"), now });
    },
    { permission: "matters.write" }
  );
}
