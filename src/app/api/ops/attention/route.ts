import { tenantRoute } from "@/tenancy/route";
import { requirePrincipal } from "@/auth/request";
import { loadAttentionQueue } from "@/engines/platform/ops/queue";

export const dynamic = "force-dynamic";

// c37 — the ops "attention needed" queue (internal only).
export async function GET() {
  return tenantRoute("GET /api/ops/attention", async ({ tx, tenantId }) => {
    await requirePrincipal(tx, tenantId, "ops.view");
    return loadAttentionQueue(tx, tenantId);
  });
}
