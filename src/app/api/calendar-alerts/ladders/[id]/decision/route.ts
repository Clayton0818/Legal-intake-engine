import { alertsRoute, type RouteParams } from "@/app/api/calendar-alerts/_lib/route";
import { recordLawyerDecision } from "@/engines/calendar-alerts/ladder/service";
import { LADDER_DECISIONS } from "@/engines/calendar-alerts/ladder/plan";
import { requireRole } from "@/engines/calendar-alerts/common";
import { assertUuidParam, oneOf, optInt, readBody, reqString } from "@/engines/calendar-alerts/http";

export const dynamic = "force-dynamic";

/**
 * The lawyer's decision at the end of the ladder (c42 §4.6): { decision, note, extendBusinessHours? }.
 * Never a legal step — withdrawal or non-engagement is always a separate, human decision.
 */
export async function POST(req: Request, { params }: RouteParams<"id">) {
  const { id } = await params;
  return alertsRoute(
    "POST /api/calendar-alerts/ladders/[id]/decision",
    async ({ tx, tenantId, staff, ctx, now }) => {
      requireRole(staff, ["attorney"], "decide the next step with a client");
      const body = await readBody(req);
      return recordLawyerDecision(tx, ctx, {
        tenantId,
        ladderId: assertUuidParam(id, "ladder id"),
        userId: staff.userId,
        decision: oneOf(body, "decision", LADDER_DECISIONS),
        note: reqString(body, "note", 2000),
        extendBusinessHours: optInt(body, "extendBusinessHours") ?? undefined,
        now,
      });
    },
    { permission: "ops.act" }
  );
}
