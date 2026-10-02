import { conflictRoute } from "@/app/api/conflict-check/_lib/route";
import { checkInquiry, checkMatter, validateInquiryParties } from "@/engines/conflict-check/sync";
import { directiveMessage } from "@/engines/conflict-check/checks";
import { optString, parseInquiryParties, readBody, reqUuid, uuidList } from "@/engines/conflict-check/http";
import { ConflictError } from "@/engines/conflict-check/util";

export const dynamic = "force-dynamic";

/**
 * Run a conflict check.
 *  - { intakeSessionId, parties[], roleSought? }: the intake flow names the prospect and the other
 *    parties; every named party is indexed (c56) and checked (any active firm user, e.g. intake staff).
 *  - { matterId }: re-check every current party of a matter (conflicts role).
 * The response carries the outcome, gate and the c3 intake directive (next step, scheduling, and the
 * approval-gated message for the caller) — hit details stay with the conflicts role.
 */
export async function POST(req: Request) {
  return conflictRoute("POST /api/conflict-check/checks", req, async ({ tx, tenantId, access }) => {
    const body = await readBody(req);
    if (body.matterId !== undefined) {
      const { check, gate, directive } = await checkMatter(tx, { tenantId, matterId: reqUuid(body, "matterId"), access });
      return { checkId: check.id, outcome: check.outcome, status: check.status, gate, directive };
    }
    const parties = parseInquiryParties(body.parties);
    const errors = validateInquiryParties(parties);
    if (errors.length > 0) throw new ConflictError("The inquiry parties are not valid.", 422, errors);
    const { check, gate, partyIds, directive } = await checkInquiry(tx, {
      tenantId,
      intakeSessionId: reqUuid(body, "intakeSessionId"),
      parties,
      roleSought: optString(body, "roleSought"),
      spokeWithUserIds: uuidList(body, "spokeWithUserIds"),
      by: { type: "user", userId: access.userId },
    });
    const callerMessage = await directiveMessage(tx, tenantId, directive);
    return { checkId: check.id, outcome: check.outcome, status: check.status, gate, partyIds, directive, callerMessage };
  }, { status: 201 });
}
