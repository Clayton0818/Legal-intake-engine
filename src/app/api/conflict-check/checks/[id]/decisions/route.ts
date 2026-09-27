import { conflictRoute } from "@/app/api/conflict-check/_lib/route";
import { recordDecision } from "@/engines/conflict-check/decisionService";
import { DECISIONS } from "@/engines/conflict-check/types";
import { assertUuidParam, oneOf, optBool, optString, optUuid, readBody, reqString, uuidList } from "@/engines/conflict-check/http";

export const dynamic = "force-dynamic";

/**
 * Record the conflicts attorney's decision (c59 §4.3). Only a conflicts attorney may decide; a
 * recorded decision is never edited — send `supersedesDecisionId` to correct one.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return conflictRoute("POST /api/conflict-check/checks/[id]/decisions", req, async ({ tx, tenantId, access }) => {
    const body = await readBody(req);
    const row = await recordDecision(tx, {
      tenantId,
      checkId: assertUuidParam(id, "check id"),
      access,
      decision: {
        decision: oneOf(body, "decision", DECISIONS),
        reasonCode: reqString(body, "reasonCode"),
        reasonText: optString(body, "reasonText"),
        consentPartyIds: uuidList(body, "consentPartyIds"),
        screenedUserIds: uuidList(body, "screenedUserIds"),
        overrideRuleTable: optBool(body, "overrideRuleTable"),
        supersedesDecisionId: optUuid(body, "supersedesDecisionId"),
      },
    });
    return { decision: row };
  }, { status: 201, capability: "decide" });
}
