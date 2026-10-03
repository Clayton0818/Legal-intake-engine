import { coreRoute } from "@/app/api/calendar-core/_lib/route";
import { confirmEvent } from "@/engines/calendar-core/calendar/service";
import { assertUuidParam } from "@/engines/calendar-core/http";

export const dynamic = "force-dynamic";

/** A lawyer confirms a proposed date (AI suggestion, court notice, calculator result, staff entry). Never the AI. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return coreRoute(
    "POST /api/calendar-core/events/[id]/confirm",
    async ({ tx, tenantId, staff }) => ({ event: await confirmEvent(tx, { tenantId, staff, eventId: assertUuidParam(id, "event id") }) }),
    { permission: "calendar.write" }
  );
}
