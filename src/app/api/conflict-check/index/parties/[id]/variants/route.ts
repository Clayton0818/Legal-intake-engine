import { conflictRoute } from "@/app/api/conflict-check/_lib/route";
import { addNameVariant } from "@/engines/conflict-check/partyIndex";
import { NAME_TYPES } from "@/engines/conflict-check/types";
import { assertUuidParam, oneOf, readBody, reqString } from "@/engines/conflict-check/http";

export const dynamic = "force-dynamic";

/** Add an alias, former, maiden, married, business or d/b/a name (c56 rule 6). */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return conflictRoute("POST /api/conflict-check/index/parties/[id]/variants", req, async ({ tx, tenantId, access }) => {
    const body = await readBody(req);
    const added = await addNameVariant(tx, { tenantId, partyId: assertUuidParam(id, "party id"), name: reqString(body, "name"), type: oneOf(body, "type", NAME_TYPES), access });
    return { added };
  }, { status: 201, capability: "index.edit" });
}
