import { tenantRoute } from "@/tenancy/route";
import { requirePrincipal } from "@/auth/request";
import { describePrincipal } from "@/auth/principal";

export const dynamic = "force-dynamic";

// c34 — who am I, which firm, which permissions. Staff only.
export async function GET() {
  return tenantRoute("GET /api/auth/me", async ({ tx, tenantId }) =>
    describePrincipal(await requirePrincipal(tx, tenantId))
  );
}
