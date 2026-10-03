import { coreRoute } from "@/app/api/calendar-core/_lib/route";
import { connectCalendar, listConnections, syncApproved } from "@/engines/calendar-core/calendar/sync";
import { oneOf, optString, readBody } from "@/engines/calendar-core/http";
import { placeholderFor } from "@/compliance/approvals";
import { VENDOR_GATES } from "@/compliance/gates";

export const dynamic = "force-dynamic";

/** The signed-in lawyer's calendar connections and whether sync is allowed yet (vendor.calendar_sync). */
export async function GET() {
  return coreRoute("GET /api/calendar-core/sync/connections", async ({ tx, tenantId, staff }) => ({
    vendorApproved: syncApproved(),
    pendingMessage: syncApproved() ? null : placeholderFor(VENDOR_GATES.calendarSync.key),
    connections: await listConnections(tx, tenantId, staff.userId),
  }));
}

/**
 * Connect the signed-in lawyer's own calendar: { provider: microsoft|google, tokenRef, externalCalendarId?, direction? }.
 * tokenRef is a secret-store reference (the OAuth flow itself is part of the vendor integration).
 */
export async function POST(req: Request) {
  return coreRoute(
    "POST /api/calendar-core/sync/connections",
    async ({ tx, tenantId, staff }) => {
      const body = await readBody(req);
      const row = await connectCalendar(tx, {
        tenantId,
        userId: staff.userId,
        provider: oneOf(body, "provider", ["microsoft", "google"] as const),
        tokenRef: optString(body, "tokenRef"),
        externalCalendarId: optString(body, "externalCalendarId"),
        direction: body.direction === undefined ? undefined : oneOf(body, "direction", ["two_way", "push_only", "pull_only"] as const),
      });
      return { id: row?.id ?? null, vendorApproved: syncApproved() };
    },
    { permission: "calendar.write", status: 201 }
  );
}
