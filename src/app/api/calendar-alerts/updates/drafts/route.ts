import { alertsRoute } from "@/app/api/calendar-alerts/_lib/route";
import { listPendingDrafts } from "@/engines/calendar-alerts/updates/service";

export const dynamic = "force-dynamic";

/** c54 — drafted updates waiting for a lawyer's approval. */
export async function GET() {
  return alertsRoute("GET /api/calendar-alerts/updates/drafts", async ({ tx, tenantId }) => listPendingDrafts(tx, tenantId), { permission: "matters.read" });
}
