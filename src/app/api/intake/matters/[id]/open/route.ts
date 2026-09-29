// c68 — the gate panel, gate evidence, the Open matter action and hand-off retries.
import { tenantRoute, HttpError } from "@/tenancy/route";
import { getOpenGatePanel, openMatter, recordGateEvidence, reportPaymentReversal, retryHandoff, type EvidenceInput } from "@/engines/intake/opening/service";
import { oneOf, optionalStr, readJson, requireActingStaff, requireActingUserId, str, uuid } from "../../../_lib/http";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return tenantRoute("GET /api/intake/matters/[id]/open", async ({ tx, tenantId }) => {
    await requireActingStaff(tx, tenantId, req);
    return getOpenGatePanel(tx, tenantId, uuid(id, "matter id"));
  });
}

function evidenceFrom(body: Record<string, unknown>): EvidenceInput {
  const gate = oneOf(body.gate, ["engagement_signed", "fee_arrangement", "first_payment"] as const, "gate");
  const note = optionalStr(body, "note") ?? undefined;
  if (gate === "engagement_signed") return { gate, documentId: uuid(body.documentId, "documentId"), note };
  if (gate === "fee_arrangement") {
    if (!body.fee || typeof body.fee !== "object") throw new HttpError(400, "'fee' is required.");
    return { gate, fee: body.fee as EvidenceInput extends { fee: infer F } ? F : never, note };
  }
  return {
    gate,
    kind: oneOf(body.kind, ["processor_settled", "staff_attestation"] as const, "kind"),
    paymentRef: optionalStr(body, "paymentRef") ?? undefined,
    amountCents: Number(body.amountCents),
    note,
  };
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return tenantRoute("POST /api/intake/matters/[id]/open", async ({ tx, tenantId }) => {
    const matterId = uuid(id, "matter id");
    const body = await readJson(req);
    const userId = requireActingUserId(req);
    switch (oneOf(body.action, ["evidence", "open", "retry_handoff", "payment_reversal"] as const, "action")) {
      case "evidence":
        return recordGateEvidence(tx, { tenantId, matterId, userId, evidence: evidenceFrom(body) });
      case "open":
        return openMatter(tx, { tenantId, matterId, userId });
      case "retry_handoff":
        return retryHandoff(tx, { tenantId, matterId, userId, item: str(body, "item") });
      case "payment_reversal":
        await reportPaymentReversal(tx, { tenantId, matterId, userId, reason: str(body, "reason") });
        return { ok: true };
    }
  });
}
