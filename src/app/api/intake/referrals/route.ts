// c65 — referrals recorded by staff; nothing is sent to the referred person by default.
import { tenantRoute } from "@/tenancy/route";
import { activateReferral, recordReferral } from "@/engines/intake/channels/service";
import { oneOf, optionalStr, optionalUuid, readJson, requireActingUserId, str, uuid } from "../_lib/http";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return tenantRoute("POST /api/intake/referrals", async ({ tx, tenantId }) => {
    const body = await readJson(req);
    const staffUserId = requireActingUserId(req);
    if (body.action === "activate") {
      await activateReferral(tx, {
        tenantId,
        intakeSessionId: uuid(body.intakeSessionId, "intakeSessionId"),
        staffUserId,
        reason: oneOf(body.reason, ["person_requested_contact", "firm_outreach"] as const, "reason"),
      });
      return { ok: true };
    }
    return recordReferral(tx, {
      tenantId,
      staffUserId,
      referredName: str(body, "referredName"),
      referredEmail: optionalStr(body, "referredEmail"),
      referredPhone: optionalStr(body, "referredPhone"),
      referrerType: oneOf(body.referrerType, ["lawyer", "client", "other"] as const, "referrerType"),
      referrerUserId: optionalUuid(body.referrerUserId, "referrerUserId"),
      referrerPartyId: optionalUuid(body.referrerPartyId, "referrerPartyId"),
      referrerName: optionalStr(body, "referrerName"),
      notes: optionalStr(body, "notes"),
    });
  });
}
