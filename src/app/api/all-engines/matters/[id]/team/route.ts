import { allEnginesRoute } from "@/app/api/all-engines/_lib/route";
import { isUuid, optString, readBody, reqString, reqUuid } from "@/engines/all-engines/common/body";
import { AllEnginesError } from "@/engines/all-engines/common/errors";
import { addTeamMember, removeTeamMember } from "@/engines/all-engines/permissions/service";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** Add someone to the matter team: { userId, roleOnMatter?, reason? }. Logged. */
export async function POST(req: Request, { params }: Params) {
  const { id } = await params;
  return allEnginesRoute("POST /api/all-engines/matters/:id/team", async ({ tx, tenantId, staff }) => {
    if (!isUuid(id)) throw new AllEnginesError("Invalid matter id.", 400);
    const body = await readBody(req);
    return addTeamMember(tx, { tenantId, by: staff, matterId: id, userId: reqUuid(body, "userId"), roleOnMatter: optString(body, "roleOnMatter"), reason: optString(body, "reason") });
  });
}

/** Remove someone from the team: { userId, reason }. Logged. */
export async function DELETE(req: Request, { params }: Params) {
  const { id } = await params;
  return allEnginesRoute("DELETE /api/all-engines/matters/:id/team", async ({ tx, tenantId, staff }) => {
    if (!isUuid(id)) throw new AllEnginesError("Invalid matter id.", 400);
    const body = await readBody(req);
    return removeTeamMember(tx, { tenantId, by: staff, matterId: id, userId: reqUuid(body, "userId"), reason: reqString(body, "reason") });
  });
}
