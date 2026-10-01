// c66 — "I've got this" (acknowledge) or downgrade a false positive (reason required).
import { tenantRoute } from "@/tenancy/route";
import { acknowledgeEmergency, downgradeEmergency } from "@/engines/intake/emergency/service";
import { oneOf, readJson, requireActingUserId, str, uuid } from "../../_lib/http";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return tenantRoute("POST /api/intake/emergencies/[id]", async ({ tx, tenantId }) => {
    const alertId = uuid(id, "alert id");
    const body = await readJson(req);
    const userId = requireActingUserId(req);
    if (oneOf(body.action, ["acknowledge", "downgrade"] as const, "action") === "acknowledge") {
      return acknowledgeEmergency(tx, { tenantId, alertId, userId });
    }
    return downgradeEmergency(tx, { tenantId, alertId, userId, reason: str(body, "reason") });
  });
}
