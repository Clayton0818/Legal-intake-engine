import { conflictRoute } from "@/app/api/conflict-check/_lib/route";
import { addOrgLink } from "@/engines/conflict-check/partyIndex";
import { oneOf, readBody, reqUuid } from "@/engines/conflict-check/http";

export const dynamic = "force-dynamic";

/** Link a parent company and a subsidiary, or two affiliates (c56 rule 10). */
export async function POST(req: Request) {
  return conflictRoute("POST /api/conflict-check/index/org-links", req, async ({ tx, tenantId, access }) => {
    const body = await readBody(req);
    await addOrgLink(tx, {
      tenantId,
      parentPartyId: reqUuid(body, "parentPartyId"),
      childPartyId: reqUuid(body, "childPartyId"),
      linkType: oneOf(body, "linkType", ["parent_subsidiary", "affiliate"] as const),
      access,
    });
    return { ok: true };
  }, { status: 201, capability: "index.edit" });
}
