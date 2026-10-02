// Approval status of every gate the intake engine uses (what is still pending, and who must sign off).
import { tenantRoute } from "@/tenancy/route";
import { gateStatus } from "@/compliance/approvals";
import { INTAKE_GATE_KEYS, INTAKE_SHARED_GATE_KEYS } from "@/engines/intake/gates";
import { requireActingStaff } from "../_lib/http";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return tenantRoute("GET /api/intake/gates", async ({ tx, tenantId }) => {
    await requireActingStaff(tx, tenantId, req);
    return [...INTAKE_GATE_KEYS, ...INTAKE_SHARED_GATE_KEYS].map((key) => {
      const s = gateStatus(key);
      return { key, description: s.gate.description, cardIds: s.gate.cardIds, reviewers: s.gate.reviewers, approved: s.approved, pendingReviewers: s.pendingReviewers };
    });
  });
}
