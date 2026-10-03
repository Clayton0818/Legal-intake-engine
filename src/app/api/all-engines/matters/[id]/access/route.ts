import { allEnginesRoute } from "@/app/api/all-engines/_lib/route";
import { isUuid, readBody, reqBool, reqString } from "@/engines/all-engines/common/body";
import { AllEnginesError } from "@/engines/all-engines/common/errors";
import { FIRM, decide } from "@/engines/all-engines/permissions/policy";
import { loadMatterRef, setMatterRestricted } from "@/engines/all-engines/permissions/service";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** Can the signed-in person open this matter, and why not? (screens are not visible here yet; see Foundation request) */
export async function GET(_req: Request, { params }: Params) {
  const { id } = await params;
  return allEnginesRoute("GET /api/all-engines/matters/:id/access", async ({ tx, tenantId, staff }) => {
    if (!isUuid(id)) throw new AllEnginesError("Invalid matter id.", 400);
    const ref = await loadMatterRef(tx, tenantId, id);
    if (!ref) throw new AllEnginesError("No such matter.", 404);
    const view = decide(staff.actor, "matters.view", { type: "matter", ...ref }, staff.config);
    const manage = decide(staff.actor, "permissions.manage", FIRM, staff.config);
    return { matterId: id, view, restricted: ref.restricted ?? false, team: view.allowed || manage.allowed ? ref.teamUserIds : undefined };
  });
}

/** Restrict / unrestrict a matter to its team: { restricted, reason }. Logged. */
export async function PUT(req: Request, { params }: Params) {
  const { id } = await params;
  return allEnginesRoute("PUT /api/all-engines/matters/:id/access", async ({ tx, tenantId, staff }) => {
    if (!isUuid(id)) throw new AllEnginesError("Invalid matter id.", 400);
    const body = await readBody(req);
    return setMatterRestricted(tx, { tenantId, by: staff, matterId: id, restricted: reqBool(body, "restricted"), reason: reqString(body, "reason") });
  });
}
