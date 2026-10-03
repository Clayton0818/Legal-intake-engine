import { coreRoute } from "@/app/api/calendar-core/_lib/route";
import { listTemplates, saveTemplateDraft, seedFamilyLawTaskListDrafts } from "@/engines/calendar-core/templates/taskListService";
import type { TaskTemplateItem } from "@/engines/calendar-core/templates/taskLists";
import { requireTemplateManager } from "@/engines/calendar-core/actors";
import { invalid } from "@/engines/calendar-core/errors";
import { optString, readBody, reqString } from "@/engines/calendar-core/http";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const area = new URL(req.url).searchParams.get("practiceArea") ?? undefined;
  return coreRoute("GET /api/calendar-core/task-lists", async ({ tx, tenantId }) => ({ templates: await listTemplates(tx, tenantId, { practiceArea: area }) }));
}

/**
 * c94 — save a task list as a new DRAFT version: { key, name, practiceArea, triggerStageKey?, items[] },
 * or { action: 'seed_family_drafts' } to add the DRAFT Family Law defaults. Activate with POST …/[id].
 */
export async function POST(req: Request) {
  return coreRoute(
    "POST /api/calendar-core/task-lists",
    async ({ tx, tenantId, staff }) => {
      const body = await readBody(req);
      if (body.action === "seed_family_drafts") {
        requireTemplateManager(staff);
        return { seeded: await seedFamilyLawTaskListDrafts(tx, tenantId, staff) };
      }
      if (!Array.isArray(body.items)) throw invalid("'items' must be a list.");
      const template = await saveTemplateDraft(tx, {
        tenantId,
        staff,
        template: {
          key: reqString(body, "key"),
          name: reqString(body, "name"),
          practiceArea: reqString(body, "practiceArea"),
          triggerStageKey: optString(body, "triggerStageKey"),
          items: body.items as TaskTemplateItem[],
        },
      });
      return { template };
    },
    { permission: "calendar.write", status: 201 }
  );
}
