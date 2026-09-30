import { tenantRoute } from "@/tenancy/route";
import { requirePrincipal } from "@/auth/request";
import { readJsonObject, requireString } from "@/auth/body";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

// c34 — grant a capability (conflicts_attorney | bookkeeper). Body: { capability, reason }.
export async function POST(req: Request, { params }: Params) {
  const { id } = await params;
  return tenantRoute(
    "POST /api/auth/users/:id/capabilities",
    async ({ tx, tenantId }) => {
      const body = await readJsonObject(req);
      const by = await requirePrincipal(tx, tenantId, "users.manage");
      const { grantCapability } = await import("@/auth/session");
      return grantCapability(tx, { by, userId: id, capability: requireString(body, "capability"), reason: requireString(body, "reason") });
    },
    { status: 201 }
  );
}

// c34 — revoke a capability. Body: { capability, reason }. History is kept.
export async function DELETE(req: Request, { params }: Params) {
  const { id } = await params;
  return tenantRoute("DELETE /api/auth/users/:id/capabilities", async ({ tx, tenantId }) => {
    const body = await readJsonObject(req);
    const by = await requirePrincipal(tx, tenantId, "users.manage");
    const { revokeCapability } = await import("@/auth/session");
    const revoked = await revokeCapability(tx, {
      by,
      userId: id,
      capability: requireString(body, "capability"),
      reason: requireString(body, "reason"),
    });
    return { revoked };
  });
}
