import { conflictRoute } from "@/app/api/conflict-check/_lib/route";
import { confirmSuggestion, rejectSuggestion } from "@/engines/conflict-check/partyIndex";
import { assertUuidParam, oneOf, readBody, reqString, reqUuid } from "@/engines/conflict-check/http";

export const dynamic = "force-dynamic";

/** { action: "confirm", survivorPartyId, reason } merges (undoable); { action: "reject" } remembers the pair. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return conflictRoute("POST /api/conflict-check/index/merge-suggestions/[id]", req, async ({ tx, tenantId, access }) => {
    const body = await readBody(req);
    const suggestionId = assertUuidParam(id, "suggestion id");
    if (oneOf(body, "action", ["confirm", "reject"] as const) === "reject") return rejectSuggestion(tx, { tenantId, suggestionId, access });
    return confirmSuggestion(tx, { tenantId, suggestionId, survivorPartyId: reqUuid(body, "survivorPartyId"), reason: reqString(body, "reason"), access });
  }, { capability: "index.edit" });
}
