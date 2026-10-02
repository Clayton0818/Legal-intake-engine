import { conflictRoute } from "@/app/api/conflict-check/_lib/route";
import { disclosureStatus } from "@/engines/conflict-check/interestService";

export const dynamic = "force-dynamic";

/** Firm admin view: count and last confirmation per lawyer, never the contents. */
export async function GET(req: Request) {
  return conflictRoute("GET /api/conflict-check/interests/status", req, ({ tx, tenantId, access }) => disclosureStatus(tx, { tenantId, access }), {
    capability: "health.view",
  });
}
