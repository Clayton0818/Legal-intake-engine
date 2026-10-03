import { coreRoute } from "@/app/api/calendar-core/_lib/route";
import { listDefinitions, saveDefinitionDraft, seedFamilyLawStageDraft } from "@/engines/calendar-core/templates/stageService";
import type { StageDef } from "@/engines/calendar-core/templates/stages";
import { requireTemplateManager } from "@/engines/calendar-core/actors";
import { invalid } from "@/engines/calendar-core/errors";
import { readBody, reqString } from "@/engines/calendar-core/http";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const area = new URL(req.url).searchParams.get("practiceArea") ?? undefined;
  return coreRoute("GET /api/calendar-core/stages", async ({ tx, tenantId }) => ({ definitions: await listDefinitions(tx, tenantId, area) }));
}

/** c95 — save a lifecycle as a new DRAFT version: { practiceArea, name, stages[] }, or { action: 'seed_family_draft' }. */
export async function POST(req: Request) {
  return coreRoute(
    "POST /api/calendar-core/stages",
    async ({ tx, tenantId, staff }) => {
      const body = await readBody(req);
      if (body.action === "seed_family_draft") {
        requireTemplateManager(staff);
        return { seeded: await seedFamilyLawStageDraft(tx, tenantId, staff) };
      }
      if (!Array.isArray(body.stages)) throw invalid("'stages' must be a list.");
      return {
        definition: await saveDefinitionDraft(tx, { tenantId, staff, practiceArea: reqString(body, "practiceArea"), name: reqString(body, "name"), stages: body.stages as StageDef[] }),
      };
    },
    { permission: "calendar.write", status: 201 }
  );
}
