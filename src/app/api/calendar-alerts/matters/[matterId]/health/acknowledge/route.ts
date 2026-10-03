import { alertsRoute, type RouteParams } from "@/app/api/calendar-alerts/_lib/route";
import { acknowledgeHealthFlag } from "@/engines/calendar-alerts/health/service";
import { requireRole } from "@/engines/calendar-alerts/common";
import { assertUuidParam, optDateTime, readBody, reqString } from "@/engines/calendar-alerts/http";

export const dynamic = "force-dynamic";

/** c53 §4.10 — acknowledge the health flag: { note, checkBackAt? }. The score keeps updating. */
export async function POST(req: Request, { params }: RouteParams<"matterId">) {
  const { matterId } = await params;
  return alertsRoute(
    "POST /api/calendar-alerts/matters/[matterId]/health/acknowledge",
    async ({ tx, tenantId, staff, ctx, now }) => {
      requireRole(staff, ["attorney", "firm_admin"], "acknowledge health flags");
      const body = await readBody(req);
      await acknowledgeHealthFlag(tx, ctx, { tenantId, matterId: assertUuidParam(matterId, "matter id"), userId: staff.userId, note: reqString(body, "note", 2000), checkBackAt: optDateTime(body, "checkBackAt"), now });
      return { ok: true };
    },
    { permission: "flags.acknowledge" }
  );
}
