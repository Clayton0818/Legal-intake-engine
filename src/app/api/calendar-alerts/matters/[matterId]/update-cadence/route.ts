import { alertsRoute, type RouteParams } from "@/app/api/calendar-alerts/_lib/route";
import { setCadence } from "@/engines/calendar-alerts/updates/service";
import { assertUuidParam, optInt, readBody } from "@/engines/calendar-alerts/http";

export const dynamic = "force-dynamic";

/** c54 §4.8 — per-matter update rhythm: { everyBusinessDays: number | null } (null = off). */
export async function PUT(req: Request, { params }: RouteParams<"matterId">) {
  const { matterId } = await params;
  return alertsRoute(
    "PUT /api/calendar-alerts/matters/[matterId]/update-cadence",
    async ({ tx, tenantId, staff, ctx, now }) => {
      const body = await readBody(req);
      return setCadence(tx, ctx, { tenantId, matterId: assertUuidParam(matterId, "matter id"), everyBusinessDays: optInt(body, "everyBusinessDays"), staff, now });
    },
    { permission: "matters.write" }
  );
}
