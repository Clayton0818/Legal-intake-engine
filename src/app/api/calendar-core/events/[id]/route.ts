import { coreRoute } from "@/app/api/calendar-core/_lib/route";
import { getEventDetail, updateEventDetails } from "@/engines/calendar-core/calendar/service";
import { assertUuidParam, readBody, uuidList } from "@/engines/calendar-core/http";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return coreRoute("GET /api/calendar-core/events/[id]", ({ tx, tenantId }) => getEventDetail(tx, tenantId, assertUuidParam(id, "event id")));
}

/** Edit non-date details (title, place, court, cause number, people). Dates: POST …/reschedule. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return coreRoute(
    "PATCH /api/calendar-core/events/[id]",
    async ({ tx, tenantId, staff }) => {
      const body = await readBody(req);
      const str = (k: string) => (body[k] === undefined ? undefined : body[k] === null ? null : String(body[k]));
      const event = await updateEventDetails(tx, {
        tenantId,
        staff,
        eventId: assertUuidParam(id, "event id"),
        patch: {
          ...(body.title !== undefined ? { title: String(body.title) } : {}),
          ...(body.description !== undefined ? { description: str("description") } : {}),
          ...(body.location !== undefined ? { location: str("location") } : {}),
          ...(body.courtName !== undefined ? { courtName: str("courtName") } : {}),
          ...(body.causeNumber !== undefined ? { causeNumber: str("causeNumber") } : {}),
          ...(body.assignedUserIds !== undefined ? { assignedUserIds: uuidList(body, "assignedUserIds") } : {}),
        },
      });
      return { event };
    },
    { permission: "calendar.write" }
  );
}
