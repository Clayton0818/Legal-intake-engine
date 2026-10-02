import { conflictRoute } from "@/app/api/conflict-check/_lib/route";
import { undoMerge } from "@/engines/conflict-check/partyIndex";
import { assertUuidParam, readBody, reqString } from "@/engines/conflict-check/http";

export const dynamic = "force-dynamic";

/** Undo a merge: both records and every link come back exactly (nothing was moved or deleted). */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return conflictRoute("POST /api/conflict-check/index/merges/[id]/undo", req, async ({ tx, tenantId, access }) => {
    const body = await readBody(req);
    return undoMerge(tx, { tenantId, mergeId: assertUuidParam(id, "merge id"), reason: reqString(body, "reason"), access });
  }, { capability: "index.edit" });
}
