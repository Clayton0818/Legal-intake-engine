import { coreRoute } from "@/app/api/calendar-core/_lib/route";
import { cancelRun } from "@/engines/calendar-core/templates/taskListService";
import { assertUuidParam, readBody, reqString } from "@/engines/calendar-core/http";

export const dynamic = "force-dynamic";

/** Cancel a task-list run with a logged reason: { reason }. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return coreRoute(
    "POST /api/calendar-core/task-list-runs/[id]/cancel",
    async ({ tx, tenantId, staff }) => cancelRun(tx, { tenantId, staff, runId: assertUuidParam(id, "run id"), reason: reqString(await readBody(req), "reason") }),
    { permission: "calendar.write" }
  );
}
