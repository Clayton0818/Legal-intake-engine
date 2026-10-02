import { conflictRoute } from "@/app/api/conflict-check/_lib/route";
import { activateScreen } from "@/engines/conflict-check/decisionService";
import { assertUuidParam, optDate, readBody } from "@/engines/conflict-check/http";

export const dynamic = "force-dynamic";

/** Confirm a requested screen is in place, with the notice date (hand-off to c60). */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return conflictRoute("POST /api/conflict-check/screens/[id]/activate", req, async ({ tx, tenantId, access }) => {
    const body = await readBody(req);
    return activateScreen(tx, { tenantId, screenId: assertUuidParam(id, "screen id"), noticeSentAt: optDate(body, "noticeSentAt"), access });
  }, { capability: "decide" });
}
