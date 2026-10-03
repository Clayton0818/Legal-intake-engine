import { alertsRoute } from "@/app/api/calendar-alerts/_lib/route";
import { MESSAGE_CHANNELS, recordInboundMessage } from "@/engines/calendar-alerts/replyClock/service";
import { requireRole, ACTING_ROLES } from "@/engines/calendar-alerts/common";
import { oneOf, optBool, optDateTime, optString, optUuid, readBody, reqString, reqUuid } from "@/engines/calendar-alerts/http";

export const dynamic = "force-dynamic";

/**
 * c43/c44 — record a client's message on a matter (portal adapter, email filed to the matter,
 * or a phone call / voicemail logged by staff). Starts or joins the reply clock; never answers the client.
 */
export async function POST(req: Request) {
  return alertsRoute(
    "POST /api/calendar-alerts/messages/inbound",
    async ({ tx, tenantId, staff, ctx, now }) => {
      requireRole(staff, ACTING_ROLES, "record client messages");
      const body = await readBody(req);
      return recordInboundMessage(tx, ctx, {
        tenantId,
        matterId: reqUuid(body, "matterId"),
        partyId: reqUuid(body, "partyId"),
        channel: oneOf(body, "channel", MESSAGE_CHANNELS),
        body: reqString(body, "body"),
        occurredAt: optDateTime(body, "occurredAt") ?? now,
        threadKey: optString(body, "threadKey", 100) ?? undefined,
        autoSubmitted: optBool(body, "autoSubmitted"),
        classifierSafety: optBool(body, "classifierSafety"),
        inReplyToUpdateId: optUuid(body, "inReplyToUpdateId"),
        loggedBy: { type: "user", userId: staff.userId },
      });
    },
    { permission: "matters.write", status: 201 }
  );
}
