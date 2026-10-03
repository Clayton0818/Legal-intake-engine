import { alertsRoute, type RouteParams } from "@/app/api/calendar-alerts/_lib/route";
import { createUpdate, listFirmUpdates } from "@/engines/calendar-alerts/updates/service";
import { requireRole, ACTING_ROLES } from "@/engines/calendar-alerts/common";
import { assertUuidParam, optString, readBody, reqString, uuidList } from "@/engines/calendar-alerts/http";

export const dynamic = "force-dynamic";

/** c54 — the firm-side update history with delivery and read status. */
export async function GET(_req: Request, { params }: RouteParams<"matterId">) {
  const { matterId } = await params;
  return alertsRoute("GET /api/calendar-alerts/matters/[matterId]/updates", async ({ tx, tenantId }) => listFirmUpdates(tx, tenantId, assertUuidParam(matterId, "matter id")), { permission: "matters.read" });
}

/** A lawyer or staff member sends an update now: { recipientPartyIds, body, language? }. */
export async function POST(req: Request, { params }: RouteParams<"matterId">) {
  const { matterId } = await params;
  return alertsRoute(
    "POST /api/calendar-alerts/matters/[matterId]/updates",
    async ({ tx, tenantId, staff, ctx, now }) => {
      requireRole(staff, ACTING_ROLES, "send client updates");
      const body = await readBody(req);
      return createUpdate(tx, ctx, {
        tenantId,
        matterId: assertUuidParam(matterId, "matter id"),
        recipientPartyIds: uuidList(body, "recipientPartyIds"),
        body: reqString(body, "body"),
        language: optString(body, "language", 10) ?? undefined,
        author: { type: "user", staff },
        now,
      });
    },
    { permission: "matters.write", status: 201 }
  );
}
