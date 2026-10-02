// c65 — one intake queue for every channel (staff only).
import { tenantRoute } from "@/tenancy/route";
import { listIntakeQueue } from "@/engines/intake/channels/service";
import { requireActingStaff } from "../_lib/http";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return tenantRoute("GET /api/intake/queue", async ({ tx, tenantId }) => {
    await requireActingStaff(tx, tenantId, req);
    return listIntakeQueue(tx, tenantId);
  });
}
