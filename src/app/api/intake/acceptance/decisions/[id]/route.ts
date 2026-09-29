// c73 — a lawyer decides a borderline case (accept / decline / more info), reason required.
import { tenantRoute } from "@/tenancy/route";
import { decideBorderline } from "@/engines/intake/acceptance/service";
import { oneOf, readJson, requireActingUserId, str, uuid } from "../../../_lib/http";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return tenantRoute("POST /api/intake/acceptance/decisions/[id]", async ({ tx, tenantId }) => {
    const body = await readJson(req);
    return decideBorderline(tx, {
      tenantId,
      evaluationId: uuid(id, "evaluation id"),
      userId: requireActingUserId(req),
      decision: oneOf(body.decision, ["accept", "decline", "more_info"] as const, "decision"),
      reason: str(body, "reason"),
    });
  });
}
