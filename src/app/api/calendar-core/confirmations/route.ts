import { coreRoute } from "@/app/api/calendar-core/_lib/route";
import { listAwaitingConfirmation } from "@/engines/calendar-core/calendar/service";

export const dynamic = "force-dynamic";

/** Proposed dates waiting for a lawyer (the confirmation queue). */
export async function GET() {
  return coreRoute("GET /api/calendar-core/confirmations", async ({ tx, tenantId }) => ({ events: await listAwaitingConfirmation(tx, tenantId) }));
}
