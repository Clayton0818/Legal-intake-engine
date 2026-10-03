import { alertsRoute } from "@/app/api/calendar-alerts/_lib/route";
import { MESSAGE_CHANNELS, recordOutboundMessage } from "@/engines/calendar-alerts/replyClock/service";
import { requireRole, ACTING_ROLES } from "@/engines/calendar-alerts/common";
import { oneOf, optBool, optDateTime, optInt, optString, optUuid, readBody, reqString, reqUuid } from "@/engines/calendar-alerts/http";

export const dynamic = "force-dynamic";

/** A lawyer or staff member writes to the client. A human reply stops the reply clock (c43); expectsReply starts c42. */
export async function POST(req: Request) {
  return alertsRoute(
    "POST /api/calendar-alerts/messages/outbound",
    async ({ tx, tenantId, staff, ctx, now }) => {
      requireRole(staff, ACTING_ROLES, "write to clients");
      const body = await readBody(req);
      return recordOutboundMessage(tx, ctx, {
        tenantId,
        matterId: reqUuid(body, "matterId"),
        partyId: reqUuid(body, "partyId"),
        channel: oneOf(body, "channel", MESSAGE_CHANNELS),
        body: reqString(body, "body"),
        occurredAt: optDateTime(body, "occurredAt") ?? now,
        threadKey: optString(body, "threadKey", 100) ?? undefined,
        sender: { type: "user", userId: staff.userId },
        expectsReply: optBool(body, "expectsReply"),
        replyWindowHours: optInt(body, "replyWindowHours"),
        relatedCalendarEventId: optUuid(body, "relatedCalendarEventId"),
      });
    },
    { permission: "matters.write", status: 201 }
  );
}
