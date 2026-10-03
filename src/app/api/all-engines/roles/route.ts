import { allEnginesRoute } from "@/app/api/all-engines/_lib/route";
import { readBody, reqString, reqUuid } from "@/engines/all-engines/common/body";
import { grantRole, listRoleHolders, revokeRole } from "@/engines/all-engines/permissions/service";

export const dynamic = "force-dynamic";

/** Every staff user with their roles (permissions.manage). */
export async function GET() {
  return allEnginesRoute("GET /api/all-engines/roles", ({ tx, tenantId, staff }) => listRoleHolders(tx, tenantId, staff));
}

/** Assign a role: { userId, role, reason }. Logged. */
export async function POST(req: Request) {
  return allEnginesRoute(
    "POST /api/all-engines/roles",
    async ({ tx, tenantId, staff }) => {
      const body = await readBody(req);
      return grantRole(tx, { tenantId, by: staff, userId: reqUuid(body, "userId"), role: reqString(body, "role"), reason: reqString(body, "reason") });
    },
    { status: 201 }
  );
}

/** Remove an assigned role: { userId, role, reason }. History is kept. */
export async function DELETE(req: Request) {
  return allEnginesRoute("DELETE /api/all-engines/roles", async ({ tx, tenantId, staff }) => {
    const body = await readBody(req);
    return revokeRole(tx, { tenantId, by: staff, userId: reqUuid(body, "userId"), role: reqString(body, "role"), reason: reqString(body, "reason") });
  });
}
