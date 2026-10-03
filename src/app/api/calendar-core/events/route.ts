import { coreRoute } from "@/app/api/calendar-core/_lib/route";
import { agenda, createEvent, EVENT_PARTY_ROLES, type EventPartyRole } from "@/engines/calendar-core/calendar/service";
import type { CalendarView } from "@/engines/calendar-core/calendar/events";
import { CalendarCoreError } from "@/engines/calendar-core/errors";
import { isUuid, optBool, optString, optUuid, optDateTime, queryDate, queryUuid, readBody, reqDateTime, reqString, uuidList } from "@/engines/calendar-core/http";

export const dynamic = "force-dynamic";

/**
 * c91 — the calendar: ?view=firm|lawyer|matter (&userId / &matterId), &from, &to (ISO; default next 30 days),
 * &deadlinesOnly=1, &proposedOnly=1. Grouped into days in the firm's time zone; proposed items are marked.
 */
export async function GET(req: Request) {
  return coreRoute("GET /api/calendar-core/events", async ({ tx, tenantId, staff }) => {
    const url = new URL(req.url);
    const kind = url.searchParams.get("view") ?? "lawyer";
    let view: CalendarView;
    if (kind === "firm") view = { kind: "firm" };
    else if (kind === "matter") {
      const matterId = queryUuid(url, "matterId");
      if (!matterId) throw new CalendarCoreError("'matterId' is required for the matter view.", 422);
      view = { kind: "matter", matterId };
    } else if (kind === "lawyer") view = { kind: "lawyer", userId: queryUuid(url, "userId") ?? staff.userId };
    else throw new CalendarCoreError("'view' must be firm, lawyer or matter.", 422);
    const from = queryDate(url, "from") ?? new Date();
    const to = queryDate(url, "to") ?? new Date(from.getTime() + 30 * 86_400_000);
    return agenda(tx, tenantId, {
      view,
      from,
      to,
      deadlinesOnly: url.searchParams.get("deadlinesOnly") === "1",
      proposedOnly: url.searchParams.get("proposedOnly") === "1",
      includeCancelled: url.searchParams.get("includeCancelled") === "1",
    });
  });
}

/** Add an event. A lawyer may send confirm: true to confirm their own entry at once; staff entries wait for a lawyer. */
export async function POST(req: Request) {
  return coreRoute(
    "POST /api/calendar-core/events",
    async ({ tx, tenantId, staff }) => {
      const body = await readBody(req);
      const rawParties = Array.isArray(body.parties) ? body.parties : [];
      const parties = rawParties.map((p, i) => {
        const o = (p ?? {}) as Record<string, unknown>;
        if (!isUuid(o.partyId)) throw new CalendarCoreError(`Party ${i + 1}: 'partyId' must be an id.`, 422);
        const role = (typeof o.role === "string" ? o.role : "other") as EventPartyRole;
        if (!(EVENT_PARTY_ROLES as readonly string[]).includes(role)) throw new CalendarCoreError(`Party ${i + 1}: unknown role.`, 422);
        return { partyId: o.partyId, role };
      });
      const event = await createEvent(tx, {
        tenantId,
        staff,
        draft: {
          matterId: optUuid(body, "matterId"),
          eventType: reqString(body, "eventType"),
          title: reqString(body, "title"),
          description: optString(body, "description"),
          startsAt: reqDateTime(body, "startsAt"),
          endsAt: optDateTime(body, "endsAt"),
          allDay: optBool(body, "allDay") ?? false,
          location: optString(body, "location"),
          courtName: optString(body, "courtName"),
          causeNumber: optString(body, "causeNumber"),
          isDeadline: optBool(body, "isDeadline"),
          assignedUserIds: uuidList(body, "assignedUserIds"),
        },
        confirmNow: optBool(body, "confirm") ?? false,
        parties,
      });
      return { event };
    },
    { permission: "calendar.write", status: 201 }
  );
}
