import { conflictRoute } from "@/app/api/conflict-check/_lib/route";
import { getReviewPacket } from "@/engines/conflict-check/decisionService";
import { assertUuidParam } from "@/engines/conflict-check/http";

export const dynamic = "force-dynamic";

/** The conflicts attorney's review screen for one check (c59 §4.2). Every view is logged. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return conflictRoute("GET /api/conflict-check/checks/[id]", req, ({ tx, tenantId, access }) =>
    getReviewPacket(tx, { tenantId, checkId: assertUuidParam(id, "check id"), access })
  );
}
