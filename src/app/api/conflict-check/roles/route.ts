import { conflictRoute } from "@/app/api/conflict-check/_lib/route";
import { grantConflictsRole, listConflictAttorneys, revokeConflictsRole } from "@/engines/conflict-check/access";
import { oneOf, optBool, readBody, reqString, reqUuid } from "@/engines/conflict-check/http";

export const dynamic = "force-dynamic";

/** Who holds the conflicts-attorney role (designated first). */
export async function GET(req: Request) {
  return conflictRoute("GET /api/conflict-check/roles", req, ({ tx, tenantId }) => listConflictAttorneys(tx, tenantId), { capability: "health.view" });
}

/** Grant the conflicts role (firm admin). Designating a new conflicts attorney replaces the old one. */
export async function POST(req: Request) {
  return conflictRoute("POST /api/conflict-check/roles", req, async ({ tx, tenantId, access }) => {
    const body = await readBody(req);
    return grantConflictsRole(tx, {
      tenantId,
      userId: reqUuid(body, "userId"),
      role: oneOf(body, "role", ["conflicts_attorney", "conflicts_staff"] as const),
      designated: optBool(body, "designated"),
      backup: optBool(body, "backup"),
      by: access,
    });
  }, { status: 201, capability: "roles.manage" });
}

/** Revoke the conflicts role (firm admin), with a reason. */
export async function DELETE(req: Request) {
  return conflictRoute("DELETE /api/conflict-check/roles", req, async ({ tx, tenantId, access }) => {
    const body = await readBody(req);
    await revokeConflictsRole(tx, { tenantId, userId: reqUuid(body, "userId"), reason: reqString(body, "reason"), by: access });
    return { ok: true };
  }, { capability: "roles.manage" });
}
