import { coreRoute } from "@/app/api/calendar-core/_lib/route";
import { attachParty, detachParty, EVENT_PARTY_ROLES } from "@/engines/calendar-core/calendar/service";
import { assertUuidParam, oneOf, readBody, reqUuid } from "@/engines/calendar-core/http";

export const dynamic = "force-dynamic";

/** Attach a person to an event: { partyId, role }. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return coreRoute(
    "POST /api/calendar-core/events/[id]/parties",
    async ({ tx, tenantId, staff }) => {
      const body = await readBody(req);
      await attachParty(tx, { tenantId, staff, eventId: assertUuidParam(id, "event id"), partyId: reqUuid(body, "partyId"), role: oneOf(body, "role", EVENT_PARTY_ROLES) });
      return { ok: true };
    },
    { permission: "calendar.write", status: 201 }
  );
}

/** Detach a person: { partyId }. */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return coreRoute(
    "DELETE /api/calendar-core/events/[id]/parties",
    async ({ tx, tenantId, staff }) => {
      const body = await readBody(req);
      await detachParty(tx, { tenantId, staff, eventId: assertUuidParam(id, "event id"), partyId: reqUuid(body, "partyId") });
      return { ok: true };
    },
    { permission: "calendar.write" }
  );
}
