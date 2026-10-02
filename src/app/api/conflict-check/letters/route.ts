import { conflictRoute } from "@/app/api/conflict-check/_lib/route";
import { canApproveLetters, listLetters, startNonEngagementLetter } from "@/engines/conflict-check/letterService";
import { DECLINE_TYPES } from "@/engines/conflict-check/letters";
import { oneOf, optString, optUuid, readBody, reqUuid } from "@/engines/conflict-check/http";
import { ConflictError } from "@/engines/conflict-check/util";

export const dynamic = "force-dynamic";

/** Non-engagement letters (lawyers and the conflicts role). ?status=awaiting_approval,approved */
export async function GET(req: Request) {
  const statuses = (new URL(req.url).searchParams.get("status") ?? "").split(",").filter(Boolean);
  return conflictRoute("GET /api/conflict-check/letters", req, ({ tx, tenantId, access }) => listLetters(tx, tenantId, access, statuses));
}

/**
 * Start the letter workflow when an inquiry is declined (c62 §4.1). Conflict declines start it
 * automatically from the decision; this is for the firm's other decline reasons.
 */
export async function POST(req: Request) {
  return conflictRoute("POST /api/conflict-check/letters", req, async ({ tx, tenantId, access }) => {
    if (!canApproveLetters(access)) throw new ConflictError("Only a lawyer can start a non-engagement letter.", 403);
    const body = await readBody(req);
    const declineType = oneOf(body, "declineType", DECLINE_TYPES);
    if (declineType === "conflict") throw new ConflictError("Conflict declines start from the conflicts attorney's decision.", 422);
    return startNonEngagementLetter(tx, {
      tenantId,
      prospectPartyId: reqUuid(body, "prospectPartyId"),
      declineType,
      intakeSessionId: optUuid(body, "intakeSessionId"),
      matterId: optUuid(body, "matterId"),
      practiceArea: optString(body, "practiceArea"),
      reviewingUserId: access.userId,
      by: { type: "user", userId: access.userId },
    });
  }, { status: 201 });
}
