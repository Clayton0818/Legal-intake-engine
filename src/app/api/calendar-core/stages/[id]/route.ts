import { coreRoute } from "@/app/api/calendar-core/_lib/route";
import { activateDefinition } from "@/engines/calendar-core/templates/stageService";
import { assertUuidParam, oneOf, readBody } from "@/engines/calendar-core/http";

export const dynamic = "force-dynamic";

/** { action: 'activate' } — a lawyer or firm admin activates a reviewed draft lifecycle. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return coreRoute(
    "POST /api/calendar-core/stages/[id]",
    async ({ tx, tenantId, staff }) => {
      oneOf(await readBody(req), "action", ["activate"] as const);
      return { definition: await activateDefinition(tx, { tenantId, staff, definitionId: assertUuidParam(id, "definition id") }) };
    },
    { permission: "calendar.write" }
  );
}
