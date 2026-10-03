import { coreRoute } from "@/app/api/calendar-core/_lib/route";
import { disconnectCalendar } from "@/engines/calendar-core/calendar/sync";
import { assertUuidParam } from "@/engines/calendar-core/http";
import { notFound } from "@/engines/calendar-core/errors";

export const dynamic = "force-dynamic";

/** Disconnect one of the signed-in lawyer's own calendars. */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return coreRoute(
    "DELETE /api/calendar-core/sync/connections/[id]",
    async ({ tx, tenantId, staff }) => {
      const row = await disconnectCalendar(tx, { tenantId, userId: staff.userId, connectionId: assertUuidParam(id, "connection id") });
      if (!row) throw notFound("Connection");
      return { ok: true };
    },
    { permission: "calendar.write" }
  );
}
