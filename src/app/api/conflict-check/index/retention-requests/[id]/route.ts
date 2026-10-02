import { conflictRoute } from "@/app/api/conflict-check/_lib/route";
import { decideRetentionRequest } from "@/engines/conflict-check/partyIndex";
import { assertUuidParam, oneOf, readBody, reqString } from "@/engines/conflict-check/http";

export const dynamic = "force-dynamic";

/**
 * The conflicts attorney decides a deletion request. Blocked (423, logged) until the retention
 * rule `rules.conflict-check.index_retention` is approved by an attorney.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return conflictRoute("POST /api/conflict-check/index/retention-requests/[id]", req, async ({ tx, tenantId, access }) => {
    const body = await readBody(req);
    return decideRetentionRequest(tx, {
      tenantId,
      requestId: assertUuidParam(id, "request id"),
      outcome: oneOf(body, "outcome", ["kept_minimal", "removed"] as const),
      legalBasis: reqString(body, "legalBasis"),
      access,
    });
  }, { capability: "decide" });
}
