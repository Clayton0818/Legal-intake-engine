// c14 — a matter's stage: staff view (firm label) or the client-safe status; manual moves.
import { tenantRoute } from "@/tenancy/route";
import { clientStatusForMatter, getMatterStageView, moveMatterToFirmStage } from "@/engines/intake/pipeline/service";
import { actingUserId, optionalStr, readJson, requireActingStaff, requireActingUserId, str, uuid } from "../../../_lib/http";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return tenantRoute("GET /api/intake/matters/[id]/stage", async ({ tx, tenantId }) => {
    const matterId = uuid(id, "matter id");
    // Without a staff user only the attorney-reviewed generic status is returned, never the firm label.
    if (!actingUserId(req)) return clientStatusForMatter(tx, tenantId, matterId);
    await requireActingStaff(tx, tenantId, req);
    return getMatterStageView(tx, tenantId, matterId);
  });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return tenantRoute("POST /api/intake/matters/[id]/stage", async ({ tx, tenantId }) => {
    const body = await readJson(req);
    return moveMatterToFirmStage(tx, { tenantId, matterId: uuid(id, "matter id"), toKey: str(body, "toKey"), byUserId: requireActingUserId(req), reason: optionalStr(body, "reason") ?? undefined });
  });
}
