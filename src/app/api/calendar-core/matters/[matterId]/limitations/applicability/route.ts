import { coreRoute } from "@/app/api/calendar-core/_lib/route";
import { setApplicability } from "@/engines/calendar-core/limitations/service";
import { assertUuidParam, oneOf, optString, readBody } from "@/engines/calendar-core/http";

export const dynamic = "force-dynamic";

/** A lawyer records whether a limitation date applies: { applicability: applies|not_applicable, reason? (required for not_applicable) }. */
export async function POST(req: Request, { params }: { params: Promise<{ matterId: string }> }) {
  const { matterId } = await params;
  return coreRoute(
    "POST /api/calendar-core/matters/[matterId]/limitations/applicability",
    async ({ tx, tenantId, staff }) => {
      const body = await readBody(req);
      return setApplicability(tx, {
        tenantId,
        staff,
        matterId: assertUuidParam(matterId, "matter id"),
        applicability: oneOf(body, "applicability", ["applies", "not_applicable"] as const),
        reason: optString(body, "reason"),
      });
    },
    { permission: "calendar.confirm_deadline" }
  );
}
