// c73 — evaluate the firm's case-acceptance rules for a session.
import { tenantRoute } from "@/tenancy/route";
import { evaluateFit, listFitEvaluations } from "@/engines/intake/acceptance/service";
import { requireActingStaff, uuid } from "../../../_lib/http";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return tenantRoute("GET /api/intake/sessions/[id]/fit", async ({ tx, tenantId }) => {
    await requireActingStaff(tx, tenantId, req);
    return listFitEvaluations(tx, tenantId, uuid(id, "session id"));
  });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return tenantRoute("POST /api/intake/sessions/[id]/fit", async ({ tx, tenantId }) => {
    await requireActingStaff(tx, tenantId, req);
    const result = await evaluateFit(tx, { tenantId, intakeSessionId: uuid(id, "session id") });
    // Internal view: the rule results never go to the prospective client.
    return result;
  });
}
