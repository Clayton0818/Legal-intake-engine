import { coreRoute } from "@/app/api/calendar-core/_lib/route";
import { importExampleRuleSet, importFromProvider, listRuleSets, saveRuleSetDraft } from "@/engines/calendar-core/deadlines/service";
import type { DeadlineRuleSetConfig } from "@/engines/calendar-core/deadlines/ruleSets";
import { invalid } from "@/engines/calendar-core/errors";
import { optString, readBody, reqString } from "@/engines/calendar-core/http";

export const dynamic = "force-dynamic";

export async function GET() {
  return coreRoute("GET /api/calendar-core/deadline-rules", async ({ tx, tenantId }) => ({ ruleSets: await listRuleSets(tx, tenantId) }));
}

/**
 * Save a rule set as a new DRAFT version: { key, name, jurisdiction, court?, config },
 * or { action: 'import_example' } (the unverified example), or
 * { action: 'import_provider', providerKey, key } (gated: rules.calendar-core.licensed_rules_provider).
 * Drafts are never used until a lawyer approves them (POST …/[id] { action: 'approve', note }).
 */
export async function POST(req: Request) {
  return coreRoute(
    "POST /api/calendar-core/deadline-rules",
    async ({ tx, tenantId, staff }) => {
      const body = await readBody(req);
      if (body.action === "import_example") return { ruleSet: await importExampleRuleSet(tx, { tenantId, staff }) };
      if (body.action === "import_provider") {
        return { ruleSet: await importFromProvider(tx, { tenantId, staff, providerKey: reqString(body, "providerKey"), key: reqString(body, "key") }) };
      }
      if (!body.config || typeof body.config !== "object") throw invalid("'config' is required.");
      const ruleSet = await saveRuleSetDraft(tx, {
        tenantId,
        staff,
        key: reqString(body, "key"),
        name: reqString(body, "name"),
        jurisdiction: reqString(body, "jurisdiction"),
        court: optString(body, "court"),
        config: body.config as DeadlineRuleSetConfig,
      });
      return { ruleSet };
    },
    { permission: "calendar.write", status: 201 }
  );
}
