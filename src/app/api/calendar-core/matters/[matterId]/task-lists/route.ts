import { coreRoute } from "@/app/api/calendar-core/_lib/route";
import { listRunsForMatter, startRun } from "@/engines/calendar-core/templates/taskListService";
import { assertUuidParam, readBody, reqString } from "@/engines/calendar-core/http";
import { conflict } from "@/engines/calendar-core/errors";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ matterId: string }> }) {
  const { matterId } = await params;
  return coreRoute("GET /api/calendar-core/matters/[matterId]/task-lists", async ({ tx, tenantId }) => ({
    runs: await listRunsForMatter(tx, tenantId, assertUuidParam(matterId, "matter id")),
  }));
}

/** Run an active task list on the matter by hand: { templateKey }. */
export async function POST(req: Request, { params }: { params: Promise<{ matterId: string }> }) {
  const { matterId } = await params;
  return coreRoute(
    "POST /api/calendar-core/matters/[matterId]/task-lists",
    async ({ tx, tenantId, staff }) => {
      const run = await startRun(tx, { tenantId, staff, matterId: assertUuidParam(matterId, "matter id"), templateKey: reqString(await readBody(req), "templateKey") });
      if (!run) throw conflict("This task list already ran for this stage change.");
      return { run };
    },
    { permission: "calendar.write", status: 201 }
  );
}
