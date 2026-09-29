// c73 — the firm's case-acceptance rules (versioned) and the draft test panel.
import { tenantRoute, HttpError } from "@/tenancy/route";
import { getCurrentRuleSet, saveRuleSet, testDraftRules } from "@/engines/intake/acceptance/service";
import type { FitRule } from "@/engines/intake/acceptance/rules";
import { readJson, requireActingStaff, requireActingUserId } from "../../_lib/http";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return tenantRoute("GET /api/intake/acceptance/rules", async ({ tx, tenantId }) => {
    await requireActingStaff(tx, tenantId, req);
    return getCurrentRuleSet(tx, tenantId);
  });
}

export async function PUT(req: Request) {
  return tenantRoute("PUT /api/intake/acceptance/rules", async ({ tx, tenantId }) => {
    const body = await readJson(req);
    if (!Array.isArray(body.rules)) throw new HttpError(400, "'rules' must be an array.");
    if (typeof body.expectedVersion !== "number") throw new HttpError(400, "'expectedVersion' is required.");
    return saveRuleSet(tx, { tenantId, byUserId: requireActingUserId(req), rules: body.rules as FitRule[], expectedVersion: body.expectedVersion });
  });
}

/** Test draft rules against the last 50 inquiries (nothing is sent). */
export async function POST(req: Request) {
  return tenantRoute("POST /api/intake/acceptance/rules", async ({ tx, tenantId }) => {
    const body = await readJson(req);
    if (!Array.isArray(body.rules)) throw new HttpError(400, "'rules' must be an array.");
    return testDraftRules(tx, { tenantId, byUserId: requireActingUserId(req), rules: body.rules as FitRule[] });
  });
}
