import { coreRoute } from "@/app/api/calendar-core/_lib/route";
import { rescheduleEvent } from "@/engines/calendar-core/calendar/service";
import { assertUuidParam, optBool, optDateTime, optString, readBody, reqDateTime } from "@/engines/calendar-core/http";

export const dynamic = "force-dynamic";

/** Move an event: { startsAt, endsAt?, allDay?, reason } — a reason is required for confirmed dates and deadlines. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return coreRoute(
    "POST /api/calendar-core/events/[id]/reschedule",
    async ({ tx, tenantId, staff }) => {
      const body = await readBody(req);
      const event = await rescheduleEvent(tx, {
        tenantId,
        staff,
        eventId: assertUuidParam(id, "event id"),
        startsAt: reqDateTime(body, "startsAt"),
        ...(body.endsAt !== undefined ? { endsAt: optDateTime(body, "endsAt") } : {}),
        allDay: optBool(body, "allDay"),
        reason: optString(body, "reason"),
      });
      return { event };
    },
    { permission: "calendar.write" }
  );
}
