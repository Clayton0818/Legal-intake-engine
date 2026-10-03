import { coreRoute } from "@/app/api/calendar-core/_lib/route";
import { enterLimitationDate, listForMatter } from "@/engines/calendar-core/limitations/service";
import { assertUuidParam, optIsoDate, optString, readBody, reqIsoDate, reqString } from "@/engines/calendar-core/http";

export const dynamic = "force-dynamic";

/** The matter's limitation dates with change and verification history (staff only). */
export async function GET(_req: Request, { params }: { params: Promise<{ matterId: string }> }) {
  const { matterId } = await params;
  return coreRoute("GET /api/calendar-core/matters/[matterId]/limitations", ({ tx, tenantId }) => listForMatter(tx, tenantId, assertUuidParam(matterId, "matter id")));
}

/** A lawyer enters a limitation date: { claimDescription, limitationDate, accrualDate?, basis? }. It starts unverified. */
export async function POST(req: Request, { params }: { params: Promise<{ matterId: string }> }) {
  const { matterId } = await params;
  return coreRoute(
    "POST /api/calendar-core/matters/[matterId]/limitations",
    async ({ tx, tenantId, staff }) => {
      const body = await readBody(req);
      return enterLimitationDate(tx, {
        tenantId,
        staff,
        matterId: assertUuidParam(matterId, "matter id"),
        claimDescription: reqString(body, "claimDescription"),
        limitationDate: reqIsoDate(body, "limitationDate"),
        accrualDate: optIsoDate(body, "accrualDate"),
        basis: optString(body, "basis"),
      });
    },
    { permission: "calendar.confirm_deadline", status: 201 }
  );
}
