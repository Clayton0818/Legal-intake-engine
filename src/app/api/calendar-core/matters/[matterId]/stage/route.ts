import { coreRoute } from "@/app/api/calendar-core/_lib/route";
import { getLifecycle, moveStage, startLifecycle } from "@/engines/calendar-core/templates/stageService";
import { isPracticeAreaId } from "@/core";
import { assertUuidParam, oneOf, optString, readBody, reqString } from "@/engines/calendar-core/http";
import { invalid } from "@/engines/calendar-core/errors";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ matterId: string }> }) {
  const { matterId } = await params;
  return coreRoute("GET /api/calendar-core/matters/[matterId]/stage", ({ tx, tenantId }) => getLifecycle(tx, tenantId, assertUuidParam(matterId, "matter id")));
}

/** { action: 'start', practiceArea? } or { action: 'move', toStageKey, reason? (required when moving back) }. */
export async function POST(req: Request, { params }: { params: Promise<{ matterId: string }> }) {
  const { matterId } = await params;
  return coreRoute(
    "POST /api/calendar-core/matters/[matterId]/stage",
    async ({ tx, tenantId, staff }) => {
      const body = await readBody(req);
      const id = assertUuidParam(matterId, "matter id");
      if (oneOf(body, "action", ["start", "move"] as const) === "start") {
        const area = optString(body, "practiceArea");
        if (area && !isPracticeAreaId(area)) throw invalid(`Unknown practice area '${area}'.`);
        return startLifecycle(tx, { tenantId, staff, matterId: id, practiceArea: area && isPracticeAreaId(area) ? area : undefined });
      }
      return moveStage(tx, { tenantId, staff, matterId: id, toStageKey: reqString(body, "toStageKey"), reason: optString(body, "reason") });
    },
    { permission: "matters.write" }
  );
}
