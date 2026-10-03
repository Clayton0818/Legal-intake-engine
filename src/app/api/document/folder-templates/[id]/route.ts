import { documentRoute } from "@/app/api/document/_lib/route";
import { assertUuidParam, readJson, str } from "@/engines/document/http";
import { activateFolderTemplate, retireFolderTemplate } from "@/engines/document/folders/service";
import { DocumentError } from "@/engines/document/errors";

export const dynamic = "force-dynamic";

/** c84 — { action: "activate" | "retire" }. Activating retires the previous active template for that practice area. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return documentRoute("POST /api/document/folder-templates/[id]", async (c) => {
    const action = str(await readJson(req), "action", { required: true });
    const templateId = assertUuidParam(id, "template id");
    if (action === "activate") return activateFolderTemplate(c.tx, c.tenantId, c.viewer, templateId);
    if (action === "retire") return retireFolderTemplate(c.tx, c.tenantId, c.viewer, templateId);
    throw new DocumentError("action must be 'activate' or 'retire'.", 422);
  });
}
