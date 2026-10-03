import { alertsRoute, type RouteParams } from "@/app/api/calendar-alerts/_lib/route";
import { correctUpdate } from "@/engines/calendar-alerts/updates/service";
import { requireRole, ACTING_ROLES } from "@/engines/calendar-alerts/common";
import { assertUuidParam, readBody, reqString } from "@/engines/calendar-alerts/http";

export const dynamic = "force-dynamic";

/** Sent updates are never edited: send a correction { body } that links to the original (c54 rule 5). */
export async function POST(req: Request, { params }: RouteParams<"id">) {
  const { id } = await params;
  return alertsRoute(
    "POST /api/calendar-alerts/updates/[id]/correct",
    async ({ tx, tenantId, staff, ctx, now }) => {
      requireRole(staff, ACTING_ROLES, "send corrections");
      const body = await readBody(req);
      return correctUpdate(tx, ctx, { tenantId, updateId: assertUuidParam(id, "update id"), staff, body: reqString(body, "body"), now });
    },
    { permission: "matters.write", status: 201 }
  );
}
