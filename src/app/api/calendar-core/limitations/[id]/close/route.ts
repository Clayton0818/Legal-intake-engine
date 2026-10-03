import { coreRoute } from "@/app/api/calendar-core/_lib/route";
import { closeLimitation } from "@/engines/calendar-core/limitations/service";
import { assertUuidParam, oneOf, readBody, reqString } from "@/engines/calendar-core/http";

export const dynamic = "force-dynamic";

/** A lawyer closes the watch: { outcome: satisfied|withdrawn, reason }. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return coreRoute(
    "POST /api/calendar-core/limitations/[id]/close",
    async ({ tx, tenantId, staff }) => {
      const body = await readBody(req);
      const limitation = await closeLimitation(tx, {
        tenantId,
        staff,
        limitationId: assertUuidParam(id, "limitation id"),
        outcome: oneOf(body, "outcome", ["satisfied", "withdrawn"] as const),
        reason: reqString(body, "reason"),
      });
      return { limitation };
    },
    { permission: "calendar.confirm_deadline" }
  );
}
