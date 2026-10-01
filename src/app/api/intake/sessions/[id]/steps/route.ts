// c65/c66/c69 — the steps of one intake session, one action per request.
import { tenantRoute, HttpError } from "@/tenancy/route";
import {
  acknowledgeDisclosures,
  markInterrupted,
  recordCaseDetails,
  recordConflictMinimum,
  recordConsent,
  releaseUnsolicitedDetails,
} from "@/engines/intake/channels/service";
import { confirmSafeContact } from "@/engines/intake/emergency/service";
import { stopFollowUps } from "@/engines/intake/followUp/service";
import { closeAsNotAnInquiry, recordContactAttempt, recordHumanContact } from "@/engines/intake/speedToLead/service";
import { actingUserId, bool, oneOf, optionalStr, readJson, requireActingUserId, str, stringArray, uuid } from "../../../_lib/http";

export const dynamic = "force-dynamic";

const ACTIONS = [
  "acknowledge_disclosures",
  "consent",
  "conflict_minimum",
  "case_details",
  "safe_contact",
  "release_unsolicited_details",
  "human_contact",
  "contact_attempt",
  "not_an_inquiry",
  "interrupted",
  "stop_follow_ups",
] as const;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return tenantRoute("POST /api/intake/sessions/[id]/steps", async ({ tx, tenantId }) => {
    const intakeSessionId = uuid(id, "session id");
    const body = await readJson(req);
    const action = oneOf(body.action, ACTIONS, "action");
    const staffUserId = actingUserId(req);
    switch (action) {
      case "acknowledge_disclosures":
        await acknowledgeDisclosures(tx, { tenantId, intakeSessionId, staffUserId });
        return { ok: true };
      case "consent":
        await recordConsent(tx, { tenantId, intakeSessionId, consentType: oneOf(body.consentType, ["sms", "recording"] as const, "consentType"), given: bool(body, "given"), staffUserId });
        return { ok: true };
      case "conflict_minimum":
        await recordConflictMinimum(tx, {
          tenantId,
          intakeSessionId,
          fullName: str(body, "fullName"),
          otherPartyNames: stringArray(body, "otherPartyNames", true),
          email: optionalStr(body, "email"),
          phone: optionalStr(body, "phone"),
          staffUserId,
        });
        return { ok: true };
      case "case_details": {
        const answers = body.answers;
        if (!answers || typeof answers !== "object" || Array.isArray(answers)) throw new HttpError(400, "'answers' must be an object.");
        return recordCaseDetails(tx, { tenantId, intakeSessionId, answers: answers as Record<string, unknown>, staffUserId });
      }
      case "safe_contact":
        await confirmSafeContact(tx, {
          tenantId,
          intakeSessionId,
          safeEmail: optionalStr(body, "safeEmail"),
          safePhone: optionalStr(body, "safePhone"),
          emailUnsafe: body.emailUnsafe === true,
          smsUnsafe: body.smsUnsafe === true,
          voicemailAllowed: typeof body.voicemailAllowed === "boolean" ? body.voicemailAllowed : undefined,
          recordedByUserId: staffUserId,
        });
        return { ok: true };
      case "release_unsolicited_details":
        await releaseUnsolicitedDetails(tx, { tenantId, intakeSessionId, userId: requireActingUserId(req) });
        return { ok: true };
      case "human_contact":
        await recordHumanContact(tx, { tenantId, intakeSessionId, userId: requireActingUserId(req), method: oneOf(body.method, ["call_connected", "message_sent", "in_person"] as const, "method") });
        return { ok: true };
      case "contact_attempt":
        return recordContactAttempt(tx, { tenantId, intakeSessionId, userId: requireActingUserId(req), channel: oneOf(body.channel, ["phone", "sms", "email"] as const, "channel"), note: optionalStr(body, "note") ?? undefined });
      case "not_an_inquiry":
        await closeAsNotAnInquiry(tx, { tenantId, intakeSessionId, userId: requireActingUserId(req), reason: str(body, "reason") });
        return { ok: true };
      case "interrupted":
        await markInterrupted(tx, { tenantId, intakeSessionId });
        return { ok: true };
      case "stop_follow_ups":
        // Staff record a stop request the person made by phone or in person (c70).
        requireActingUserId(req);
        await stopFollowUps(tx, { tenantId, intakeSessionId, channel: "staff", kind: "staff_recorded" });
        return { ok: true };
    }
  });
}
