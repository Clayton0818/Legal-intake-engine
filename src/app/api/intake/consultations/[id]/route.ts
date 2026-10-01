// c67 — confirm, reschedule, cancel, no-show, outcome, hold for one consultation.
import { tenantRoute } from "@/tenancy/route";
import {
  cancelConsultation,
  confirmBooking,
  markNoShow,
  putConsultationOnHold,
  recordConsultOutcome,
  rescheduleConsultation,
} from "@/engines/intake/booking/service";
import { CONSULT_OUTCOMES } from "@/engines/intake/booking/slots";
import { actingUserId, date, oneOf, optionalStr, optionalUuid, readJson, requireActingUserId, str, uuid } from "../../_lib/http";

export const dynamic = "force-dynamic";

const ACTIONS = ["confirm", "cancel", "reschedule", "no_show", "outcome", "hold"] as const;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return tenantRoute("POST /api/intake/consultations/[id]", async ({ tx, tenantId }) => {
    const consultationId = uuid(id, "consultation id");
    const body = await readJson(req);
    const byUserId = actingUserId(req);
    // Client self-service identifies the booking party; a one-time-code check is still to come (see PR gaps).
    const clientPartyId = optionalUuid(body.clientPartyId, "clientPartyId");
    switch (oneOf(body.action, ACTIONS, "action")) {
      case "confirm":
        return confirmBooking(tx, { tenantId, consultationId, byUserId });
      case "cancel":
        return cancelConsultation(tx, { tenantId, consultationId, byUserId, clientPartyId, reason: optionalStr(body, "reason") });
      case "reschedule":
        return rescheduleConsultation(tx, {
          tenantId,
          consultationId,
          startsAt: date(body, "startsAt"),
          format: body.format === undefined ? undefined : oneOf(body.format, ["video", "phone", "in_person"] as const, "format"),
          lawyerUserId: optionalUuid(body.lawyerUserId, "lawyerUserId") ?? undefined,
          byUserId,
          clientPartyId,
          reason: optionalStr(body, "reason"),
        });
      case "no_show":
        return markNoShow(tx, { tenantId, consultationId, userId: requireActingUserId(req) });
      case "outcome":
        return recordConsultOutcome(tx, { tenantId, consultationId, userId: requireActingUserId(req), outcome: oneOf(body.outcome, CONSULT_OUTCOMES, "outcome"), note: optionalStr(body, "note") });
      case "hold":
        return putConsultationOnHold(tx, { tenantId, consultationId, userId: requireActingUserId(req), reason: str(body, "reason") });
    }
  });
}
