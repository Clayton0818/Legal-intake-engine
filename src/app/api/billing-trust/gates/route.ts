import { trustRoute } from "@/app/api/billing-trust/_lib/route";
import { gateStatus } from "@/compliance/approvals";
import { TRUST_DEPENDENCY_GATE_KEYS } from "@/engines/billing-trust/gates";
import { trustRuleValues } from "@/engines/billing-trust/rules";

export const dynamic = "force-dynamic";

/** What the trust ledger is waiting on: every gate's review status, and the (proposed or approved) rule values. */
export async function GET() {
  return trustRoute("GET /api/billing-trust/gates", async () => ({
    gates: TRUST_DEPENDENCY_GATE_KEYS.map((key) => {
      const s = gateStatus(key);
      return { key, description: s.gate.description, approved: s.approved, pendingReviewers: s.pendingReviewers };
    }),
    ruleValues: trustRuleValues(),
  }));
}
