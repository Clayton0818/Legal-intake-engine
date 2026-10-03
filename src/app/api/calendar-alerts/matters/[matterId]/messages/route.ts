import { alertsRoute, type RouteParams } from "@/app/api/calendar-alerts/_lib/route";
import { listMatterMessages, listOpenClocks } from "@/engines/calendar-alerts/replyClock/service";
import { assertUuidParam } from "@/engines/calendar-alerts/http";

export const dynamic = "force-dynamic";

/** Staff view of the matter's client thread (internal tags included) and its open reply clocks. */
export async function GET(_req: Request, { params }: RouteParams<"matterId">) {
  const { matterId } = await params;
  return alertsRoute(
    "GET /api/calendar-alerts/matters/[matterId]/messages",
    async ({ tx, tenantId }) => {
      const id = assertUuidParam(matterId, "matter id");
      return { messages: await listMatterMessages(tx, tenantId, id), openClocks: await listOpenClocks(tx, tenantId, { matterId: id }) };
    },
    { permission: "matters.read" }
  );
}
