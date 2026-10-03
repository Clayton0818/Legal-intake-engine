import { alertsRoute, type RouteParams } from "@/app/api/calendar-alerts/_lib/route";
import { decideSuggestion } from "@/engines/calendar-alerts/courtNotice/service";
import { assertUuidParam, oneOf, optString, readBody } from "@/engines/calendar-alerts/http";

export const dynamic = "force-dynamic";

/**
 * A LAWYER decides a date found in a court email: { decision: 'accept'|'reject', note? }. Accept adds a
 * PROPOSED calendar entry that the lawyer confirms in the calendar; relative periods are never turned into dates.
 */
export async function POST(req: Request, { params }: RouteParams<"id">) {
  const { id } = await params;
  return alertsRoute(
    "POST /api/calendar-alerts/court-notices/suggestions/[id]",
    async ({ tx, tenantId, staff, now }) => {
      const body = await readBody(req);
      return decideSuggestion(tx, { tenantId, suggestionId: assertUuidParam(id, "suggestion id"), staff, decision: oneOf(body, "decision", ["accept", "reject"] as const), note: optString(body, "note", 2000), now });
    },
    { permission: "calendar.confirm_deadline" }
  );
}
