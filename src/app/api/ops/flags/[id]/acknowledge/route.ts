import { HttpError, tenantRoute } from "@/tenancy/route";
import { requirePrincipal } from "@/auth/request";
import { acknowledgeFlag } from "@/core/flags";
import { OPS_ENGINE } from "@/engines/platform/ops/queue";

export const dynamic = "force-dynamic";

// c37 — acknowledge a flag from the ops queue. Needs a real user (the synthetic
// dev principal has no users row to record as the acknowledger).
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return tenantRoute("POST /api/ops/flags/:id/acknowledge", async ({ tx, tenantId }) => {
    const me = await requirePrincipal(tx, tenantId, "flags.acknowledge");
    if (!me.userId) throw new HttpError(403, "Set DEV_USER_ID to a real user to acknowledge flags in dev mode.");
    const flag = await acknowledgeFlag(tx, { tenantId, flagId: id, userId: me.userId, engine: OPS_ENGINE });
    return { id: flag.id, acknowledgedAt: flag.acknowledgedAt };
  });
}
