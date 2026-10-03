import { alertsRoute, type RouteParams } from "@/app/api/calendar-alerts/_lib/route";
import { loadDeadlineContext } from "@/engines/calendar-alerts/deadline/context";
import { getMatter } from "@/engines/calendar-alerts/common";
import { assertUuidParam } from "@/engines/calendar-alerts/http";

export const dynamic = "force-dynamic";

/**
 * c44 §4.6 — what the LAWYER sees when answering a deadline question: confirmed entries, plus
 * proposals marked "unconfirmed". Internal only; never given to client-facing AI.
 */
export async function GET(_req: Request, { params }: RouteParams<"matterId">) {
  const { matterId } = await params;
  return alertsRoute(
    "GET /api/calendar-alerts/matters/[matterId]/deadline-context",
    async ({ tx, tenantId, ctx, now }) => {
      const matter = await getMatter(tx, tenantId, assertUuidParam(matterId, "matter id"));
      return loadDeadlineContext(tx, tenantId, matter.id, now, ctx.alerts.deadlineLookaheadDays);
    },
    { permission: "calendar.read" }
  );
}
