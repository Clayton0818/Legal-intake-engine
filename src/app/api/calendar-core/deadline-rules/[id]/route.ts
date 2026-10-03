import { coreRoute } from "@/app/api/calendar-core/_lib/route";
import { approveRuleSet, getRuleSet, retireRuleSet } from "@/engines/calendar-core/deadlines/service";
import { assertUuidParam, oneOf, readBody, reqString } from "@/engines/calendar-core/http";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return coreRoute("GET /api/calendar-core/deadline-rules/[id]", ({ tx, tenantId }) => getRuleSet(tx, tenantId, assertUuidParam(id, "rule set id")));
}

/** { action: 'approve', note } (a lawyer, after checking the current rules) or { action: 'retire' }. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return coreRoute(
    "POST /api/calendar-core/deadline-rules/[id]",
    async ({ tx, tenantId, staff }) => {
      const body = await readBody(req);
      const ruleSetId = assertUuidParam(id, "rule set id");
      const action = oneOf(body, "action", ["approve", "retire"] as const);
      if (action === "approve") return { ruleSet: await approveRuleSet(tx, { tenantId, staff, ruleSetId, note: reqString(body, "note") }) };
      return { ruleSet: await retireRuleSet(tx, { tenantId, staff, ruleSetId }) };
    },
    { permission: "calendar.write" }
  );
}
