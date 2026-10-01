import { conflictRoute } from "@/app/api/conflict-check/_lib/route";
import { openRetentionRequest } from "@/engines/conflict-check/partyIndex";
import { optString, readBody, reqUuid } from "@/engines/conflict-check/http";

export const dynamic = "force-dynamic";

/** Record a deletion request against an index entry. Nothing is deleted automatically (c56 §4.6). */
export async function POST(req: Request) {
  return conflictRoute("POST /api/conflict-check/index/retention-requests", req, async ({ tx, tenantId, access }) => {
    const body = await readBody(req);
    return openRetentionRequest(tx, { tenantId, partyId: reqUuid(body, "partyId"), note: optString(body, "note"), by: { type: "user", userId: access.userId } });
  }, { status: 201, capability: "index.edit" });
}
