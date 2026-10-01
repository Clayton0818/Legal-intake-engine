import { conflictRoute } from "@/app/api/conflict-check/_lib/route";
import { getLogRecord } from "@/engines/conflict-check/logService";
import { assertUuidParam } from "@/engines/conflict-check/http";

export const dynamic = "force-dynamic";

/** One full log record; every view is logged (c63 rule 5). */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return conflictRoute(
    "GET /api/conflict-check/log/[id]",
    req,
    ({ tx, tenantId, access }) => getLogRecord(tx, { tenantId, checkId: assertUuidParam(id, "check id"), access }),
    { capability: "log.view" }
  );
}
