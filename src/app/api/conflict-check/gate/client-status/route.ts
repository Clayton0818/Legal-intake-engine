import { conflictRoute } from "@/app/api/conflict-check/_lib/route";
import { clientConflictStatus } from "@/engines/conflict-check/checks";
import { reqUuid } from "@/engines/conflict-check/http";
import { ConflictError } from "@/engines/conflict-check/util";

export const dynamic = "force-dynamic";

/**
 * What a prospective client may be told while a review is pending (c59 §4.1.4): the
 * attorney-reviewed neutral message (or its visible placeholder). Never a name, another matter or
 * an overdue status.
 */
export async function GET(req: Request) {
  return conflictRoute("GET /api/conflict-check/gate/client-status", req, ({ tx, tenantId }) => {
    const url = new URL(req.url);
    const type = url.searchParams.get("subjectType");
    if (type !== "intake_session" && type !== "matter") throw new ConflictError("subjectType must be intake_session or matter.", 422);
    return clientConflictStatus(tx, tenantId, { type, id: reqUuid({ id: url.searchParams.get("subjectId") }, "id") });
  });
}
