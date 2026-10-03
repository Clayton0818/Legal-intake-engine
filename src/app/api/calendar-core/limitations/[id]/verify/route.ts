import { coreRoute } from "@/app/api/calendar-core/_lib/route";
import { getVerificationView, verifyLimitationDate } from "@/engines/calendar-core/limitations/service";
import { assertUuidParam, optString, readBody, reqIsoDate } from "@/engines/calendar-core/http";

export const dynamic = "force-dynamic";

/** What the verifier sees first: the claim and matter, NEVER the lawyer's date (blind check). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return coreRoute("GET /api/calendar-core/limitations/[id]/verify", ({ tx, tenantId }) => getVerificationView(tx, tenantId, assertUuidParam(id, "limitation id")));
}

/** The second person enters the date they worked out: { verifierDate: 'YYYY-MM-DD', method?, notes? }. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return coreRoute(
    "POST /api/calendar-core/limitations/[id]/verify",
    async ({ tx, tenantId, staff }) => {
      const body = await readBody(req);
      return verifyLimitationDate(tx, {
        tenantId,
        staff,
        limitationId: assertUuidParam(id, "limitation id"),
        verifierDate: reqIsoDate(body, "verifierDate"),
        method: optString(body, "method"),
        notes: optString(body, "notes"),
      });
    },
    { permission: "calendar.write" }
  );
}
