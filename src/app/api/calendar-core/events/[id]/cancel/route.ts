import { coreRoute } from "@/app/api/calendar-core/_lib/route";
import { cancelEvent } from "@/engines/calendar-core/calendar/service";
import { assertUuidParam, readBody, reqString } from "@/engines/calendar-core/http";

export const dynamic = "force-dynamic";

/** Cancel with a logged reason: { reason }. Confirmed deadlines and court dates: a lawyer only. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return coreRoute(
    "POST /api/calendar-core/events/[id]/cancel",
    async ({ tx, tenantId, staff }) => {
      const body = await readBody(req);
      return { event: await cancelEvent(tx, { tenantId, staff, eventId: assertUuidParam(id, "event id"), reason: reqString(body, "reason") }) };
    },
    { permission: "calendar.write" }
  );
}
