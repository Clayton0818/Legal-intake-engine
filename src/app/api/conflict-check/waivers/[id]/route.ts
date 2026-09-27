import { conflictRoute } from "@/app/api/conflict-check/_lib/route";
import { approveWaiver, recordWaiverEvent, sendWaiver } from "@/engines/conflict-check/decisionService";
import { assertUuidParam, oneOf, optBool, optDate, optUuid, readBody } from "@/engines/conflict-check/http";

export const dynamic = "force-dynamic";

const ACTIONS = ["approve", "send", "signed", "countersigned", "refused"] as const;

/**
 * Waiver workflow (c59 §4.4), conflicts attorney only:
 *  - approve: needs the attorney-approved waiver template (423 until then);
 *  - send: e-signature, gated on vendor.esignature (held with a visible reason until then);
 *  - signed / countersigned / refused: signature events. `signedOutsidePlatform: true` +
 *    `documentId` records a paper or in-person signature on an approved waiver.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return conflictRoute("POST /api/conflict-check/waivers/[id]", req, async ({ tx, tenantId, access }) => {
    const body = await readBody(req);
    const waiverId = assertUuidParam(id, "waiver id");
    const action = oneOf(body, "action", ACTIONS);
    if (action === "approve") return approveWaiver(tx, { tenantId, waiverId, documentId: optUuid(body, "documentId"), access });
    if (action === "send") return sendWaiver(tx, { tenantId, waiverId, access });
    return recordWaiverEvent(tx, {
      tenantId,
      waiverId,
      event: action,
      at: optDate(body, "at") ?? undefined,
      by: access,
      signedOutsidePlatform: optBool(body, "signedOutsidePlatform"),
      documentId: optUuid(body, "documentId"),
    });
  }, { capability: "decide" });
}
