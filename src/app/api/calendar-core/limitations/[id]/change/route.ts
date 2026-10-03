import { coreRoute } from "@/app/api/calendar-core/_lib/route";
import { changeLimitationDate } from "@/engines/calendar-core/limitations/service";
import { assertUuidParam, readBody, reqIsoDate, reqString } from "@/engines/calendar-core/http";

export const dynamic = "force-dynamic";

/** A lawyer changes the date with a logged reason: { newDate, reason }. A fresh independent verification follows. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return coreRoute(
    "POST /api/calendar-core/limitations/[id]/change",
    async ({ tx, tenantId, staff }) => {
      const body = await readBody(req);
      return changeLimitationDate(tx, { tenantId, staff, limitationId: assertUuidParam(id, "limitation id"), newDate: reqIsoDate(body, "newDate"), reason: reqString(body, "reason") });
    },
    { permission: "calendar.confirm_deadline" }
  );
}
