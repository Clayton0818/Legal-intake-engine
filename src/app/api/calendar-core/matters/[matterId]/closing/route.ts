import { coreRoute } from "@/app/api/calendar-core/_lib/route";
import { abandonClosing, closingStatus, completeClosing, confirmTrustZero, startClosing } from "@/engines/calendar-core/templates/stageService";
import { assertUuidParam, oneOf, readBody, reqString } from "@/engines/calendar-core/http";

export const dynamic = "force-dynamic";

/** What still blocks closing this matter. */
export async function GET(_req: Request, { params }: { params: Promise<{ matterId: string }> }) {
  const { matterId } = await params;
  return coreRoute("GET /api/calendar-core/matters/[matterId]/closing", ({ tx, tenantId }) => closingStatus(tx, tenantId, assertUuidParam(matterId, "matter id")));
}

/**
 * Closing flow (lawyer): { action: 'start' } → { action: 'trust_zero', attestation } → { action: 'complete' };
 * or { action: 'abandon', reason }. 'complete' answers 409 with the blockers until nothing blocks it.
 */
export async function POST(req: Request, { params }: { params: Promise<{ matterId: string }> }) {
  const { matterId } = await params;
  return coreRoute(
    "POST /api/calendar-core/matters/[matterId]/closing",
    async ({ tx, tenantId, staff }) => {
      const body = await readBody(req);
      const id = assertUuidParam(matterId, "matter id");
      switch (oneOf(body, "action", ["start", "trust_zero", "complete", "abandon"] as const)) {
        case "start":
          return { closing: await startClosing(tx, { tenantId, staff, matterId: id }) };
        case "trust_zero":
          return { closing: await confirmTrustZero(tx, { tenantId, staff, matterId: id, attestation: reqString(body, "attestation") }) };
        case "complete":
          return completeClosing(tx, { tenantId, staff, matterId: id });
        case "abandon":
          return abandonClosing(tx, { tenantId, staff, matterId: id, reason: reqString(body, "reason") });
      }
    },
    { permission: "matters.write" }
  );
}
