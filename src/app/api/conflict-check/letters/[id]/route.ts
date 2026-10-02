import { conflictRoute } from "@/app/api/conflict-check/_lib/route";
import { approveLetter, canApproveLetters, recordLetterDelivery, recordPostalLetter, sendLetter } from "@/engines/conflict-check/letterService";
import { assertUuidParam, oneOf, readBody } from "@/engines/conflict-check/http";
import { ConflictError } from "@/engines/conflict-check/util";

export const dynamic = "force-dynamic";

const ACTIONS = ["approve", "send", "posted", "delivered", "bounced"] as const;

/**
 * approve: a lawyer approves the individual letter (423 until the wording is attorney-approved);
 * send: through the prospect's DV-safe channel; posted: staff mailed it; delivered/bounced: delivery report.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return conflictRoute("POST /api/conflict-check/letters/[id]", req, async ({ tx, tenantId, access }) => {
    const body = await readBody(req);
    const letterId = assertUuidParam(id, "letter id");
    const action = oneOf(body, "action", ACTIONS);
    if (action === "approve") return approveLetter(tx, { tenantId, letterId, access });
    if (action === "send") return sendLetter(tx, { tenantId, letterId, by: access });
    if (action === "posted") return recordPostalLetter(tx, { tenantId, letterId, access });
    if (!canApproveLetters(access)) throw new ConflictError("Not allowed.", 403);
    return recordLetterDelivery(tx, { tenantId, letterId, status: action });
  });
}
