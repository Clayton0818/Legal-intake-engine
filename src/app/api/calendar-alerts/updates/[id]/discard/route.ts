import { alertsRoute, type RouteParams } from "@/app/api/calendar-alerts/_lib/route";
import { discardUpdate } from "@/engines/calendar-alerts/updates/service";
import { assertUuidParam, readBody, reqString } from "@/engines/calendar-alerts/http";

export const dynamic = "force-dynamic";

/** Discard an unsent draft: { reason }. */
export async function POST(req: Request, { params }: RouteParams<"id">) {
  const { id } = await params;
  return alertsRoute(
    "POST /api/calendar-alerts/updates/[id]/discard",
    async ({ tx, tenantId, staff, now }) => {
      const body = await readBody(req);
      return discardUpdate(tx, { tenantId, updateId: assertUuidParam(id, "update id"), staff, reason: reqString(body, "reason", 2000), now });
    },
    { permission: "matters.write" }
  );
}
