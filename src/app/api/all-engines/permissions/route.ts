import { allEnginesRoute } from "@/app/api/all-engines/_lib/route";
import { readBody, reqString } from "@/engines/all-engines/common/body";
import { AllEnginesError } from "@/engines/all-engines/common/errors";
import { getPermissionMatrix, setPermissionOverride } from "@/engines/all-engines/permissions/service";

export const dynamic = "force-dynamic";

/** The firm's role × right matrix (permissions.manage). */
export async function GET() {
  return allEnginesRoute("GET /api/all-engines/permissions", ({ tx, tenantId, staff }) => getPermissionMatrix(tx, tenantId, staff));
}

/** Change one cell: { role, right, effect: "grant" | "deny" | null, reason }. null resets to the default. Logged. */
export async function PUT(req: Request) {
  return allEnginesRoute("PUT /api/all-engines/permissions", async ({ tx, tenantId, staff }) => {
    const body = await readBody(req);
    const effect = body.effect ?? null;
    if (effect !== null && effect !== "grant" && effect !== "deny") throw new AllEnginesError("effect must be 'grant', 'deny' or null.");
    return setPermissionOverride(tx, { tenantId, by: staff, role: reqString(body, "role"), right: reqString(body, "right"), effect, reason: reqString(body, "reason") });
  });
}
