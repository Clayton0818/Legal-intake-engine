import { documentRoute } from "@/app/api/document/_lib/route";
import { readJson, str } from "@/engines/document/http";
import { createFolderTemplate, listFolderTemplates } from "@/engines/document/folders/service";
import { DEFAULT_FOLDER_TEMPLATE, REQUIRED_FOLDER_KEYS } from "@/engines/document/folders/template";

export const dynamic = "force-dynamic";

/** c84 — the firm's folder templates, plus the product default and the keys every template must keep. */
export async function GET() {
  return documentRoute("GET /api/document/folder-templates", async (c) => ({
    templates: await listFolderTemplates(c.tx, c.tenantId),
    productDefault: DEFAULT_FOLDER_TEMPLATE,
    requiredKeys: REQUIRED_FOLDER_KEYS,
  }));
}

/** c84 — save a DRAFT template: { name, practiceArea|null, folders: [{ key, name, defaultPrivilegeTag?, children? }] }. */
export async function POST(req: Request) {
  return documentRoute(
    "POST /api/document/folder-templates",
    async (c) => {
      const body = await readJson(req);
      return createFolderTemplate(c.tx, c.tenantId, c.viewer, {
        name: str(body, "name", { required: true, max: 200 })!,
        practiceArea: str(body, "practiceArea"),
        folders: body.folders,
      });
    },
    { status: 201 }
  );
}
