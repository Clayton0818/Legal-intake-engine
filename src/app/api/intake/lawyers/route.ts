// c48 — lawyer routing profiles and screens/blocks (admin / supervising attorney).
import { tenantRoute, HttpError } from "@/tenancy/route";
import { recordAssignmentBlock, upsertLawyerProfile } from "@/engines/intake/assignment/service";
import { bool, oneOf, optionalStr, optionalUuid, readJson, requireActingUserId, stringArray, uuid } from "../_lib/http";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return tenantRoute("POST /api/intake/lawyers", async ({ tx, tenantId }) => {
    const body = await readJson(req);
    const byUserId = requireActingUserId(req);
    const action = oneOf(body.action, ["profile", "block"] as const, "action");
    if (action === "profile") {
      if (typeof body.seniority !== "number") throw new HttpError(400, "'seniority' (1–5) is required.");
      return upsertLawyerProfile(tx, {
        tenantId,
        byUserId,
        userId: uuid(body.userId, "userId"),
        practiceAreas: stringArray(body, "practiceAreas", true),
        languages: stringArray(body, "languages", true),
        counties: stringArray(body, "counties"),
        seniority: body.seniority,
        weeklyNewMatterCap: typeof body.weeklyNewMatterCap === "number" ? body.weeklyNewMatterCap : null,
        acceptsNewMatters: body.acceptsNewMatters === undefined ? true : bool(body, "acceptsNewMatters"),
      });
    }
    return recordAssignmentBlock(tx, {
      tenantId,
      byUserId,
      userId: uuid(body.userId, "userId"),
      matterId: optionalUuid(body.matterId, "matterId"),
      partyId: optionalUuid(body.partyId, "partyId"),
      reason: oneOf(body.reason, ["screened", "restricted", "other"] as const, "reason"),
      note: optionalStr(body, "note") ?? undefined,
    });
  });
}
