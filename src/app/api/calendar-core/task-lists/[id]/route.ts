import { coreRoute } from "@/app/api/calendar-core/_lib/route";
import { activateTemplate, retireTemplate } from "@/engines/calendar-core/templates/taskListService";
import { assertUuidParam, oneOf, readBody } from "@/engines/calendar-core/http";

export const dynamic = "force-dynamic";

/** { action: 'activate' | 'retire' } — lawyer or firm admin. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return coreRoute(
    "POST /api/calendar-core/task-lists/[id]",
    async ({ tx, tenantId, staff }) => {
      const action = oneOf(await readBody(req), "action", ["activate", "retire"] as const);
      const templateId = assertUuidParam(id, "template id");
      return { template: action === "activate" ? await activateTemplate(tx, { tenantId, staff, templateId }) : await retireTemplate(tx, { tenantId, staff, templateId }) };
    },
    { permission: "calendar.write" }
  );
}
