import { tenantRoute } from "@/tenancy/route";
import { requirePrincipal } from "@/auth/request";
import { readJsonObject, requireString } from "@/auth/body";

export const dynamic = "force-dynamic";

// c34 — link a vendor identity (e.g. a Clerk user id) to a firm user.
// Body: { userId, provider, subject, reason }. Admin only; never automatic.
export async function POST(req: Request) {
  return tenantRoute(
    "POST /api/auth/identities",
    async ({ tx, tenantId }) => {
      const body = await readJsonObject(req);
      const by = await requirePrincipal(tx, tenantId, "users.manage");
      const { linkIdentity } = await import("@/auth/session");
      return linkIdentity(tx, {
        by,
        userId: requireString(body, "userId"),
        provider: requireString(body, "provider"),
        subject: requireString(body, "subject"),
        reason: requireString(body, "reason"),
      });
    },
    { status: 201 }
  );
}
