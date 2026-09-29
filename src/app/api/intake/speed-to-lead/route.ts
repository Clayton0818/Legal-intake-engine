// c69 — the first-response queue (sorted by business time remaining) and response-time metrics.
import { tenantRoute } from "@/tenancy/route";
import { listSpeedToLeadQueue, responseTimeMetrics } from "@/engines/intake/speedToLead/service";
import { requireActingStaff } from "../_lib/http";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return tenantRoute("GET /api/intake/speed-to-lead", async ({ tx, tenantId }) => {
    await requireActingStaff(tx, tenantId, req);
    const days = Number(new URL(req.url).searchParams.get("days") ?? "30");
    const since = new Date(Date.now() - (Number.isFinite(days) && days > 0 ? days : 30) * 86_400_000);
    return { queue: await listSpeedToLeadQueue(tx, tenantId), metrics: await responseTimeMetrics(tx, tenantId, since) };
  });
}
