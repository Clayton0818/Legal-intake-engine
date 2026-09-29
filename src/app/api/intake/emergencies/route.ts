// c66 — open emergency alerts (staff only).
import { tenantRoute } from "@/tenancy/route";
import { listOpenEmergencies } from "@/engines/intake/emergency/service";
import { requireActingStaff } from "../_lib/http";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return tenantRoute("GET /api/intake/emergencies", async ({ tx, tenantId }) => {
    await requireActingStaff(tx, tenantId, req);
    return listOpenEmergencies(tx, tenantId);
  });
}
