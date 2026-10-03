import { coreRoute } from "@/app/api/calendar-core/_lib/route";
import { suggestDate } from "@/engines/calendar-core/limitations/service";
import { assertUuidParam, readBody, reqIsoDate, reqString } from "@/engines/calendar-core/http";

export const dynamic = "force-dynamic";

/**
 * A suggestion from the firm's own period table: { periodKey, accrualDate }. Blocked (423) until
 * 'rules.limitation_periods' is approved. Never saved: the lawyer still enters the date.
 */
export async function POST(req: Request, { params }: { params: Promise<{ matterId: string }> }) {
  const { matterId } = await params;
  return coreRoute(
    "POST /api/calendar-core/matters/[matterId]/limitations/suggest",
    async ({ tx, tenantId, staff }) => {
      const body = await readBody(req);
      return suggestDate(tx, { tenantId, staff, matterId: assertUuidParam(matterId, "matter id"), periodKey: reqString(body, "periodKey"), accrualDate: reqIsoDate(body, "accrualDate") });
    },
    { permission: "calendar.confirm_deadline" }
  );
}
