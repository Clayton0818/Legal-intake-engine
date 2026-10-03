import { coreRoute } from "@/app/api/calendar-core/_lib/route";
import { listOpenLimitations } from "@/engines/calendar-core/limitations/service";

export const dynamic = "force-dynamic";

/** c93 — every open limitation date in the firm, soonest first, with verification state. Staff only. */
export async function GET() {
  return coreRoute("GET /api/calendar-core/limitations", async ({ tx, tenantId }) => ({ limitations: await listOpenLimitations(tx, tenantId) }));
}
