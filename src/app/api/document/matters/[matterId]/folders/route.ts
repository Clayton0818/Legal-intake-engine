import { documentRoute } from "@/app/api/document/_lib/route";
import { assertUuidParam, readJson, str, uuidOrNull } from "@/engines/document/http";
import { createFolder, listMatterFolders, provisionMatterFolders } from "@/engines/document/folders/service";
import { decideMatter } from "@/engines/document/access/policy";
import { denyAndLog } from "@/engines/document/access/service";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ matterId: string }> };

/** c84 — the matter's folder tree (created from the firm's template on first use). */
export async function GET(_req: Request, { params }: Params) {
  const { matterId } = await params;
  return documentRoute("GET /api/document/matters/[matterId]/folders", async (c) => {
    const id = assertUuidParam(matterId, "matter id");
    const d = c.viewer.permissions.includes("documents.read") ? decideMatter(c.viewer, id, c.access) : ({ allowed: false, reason: "no_permission" } as const);
    if (!d.allowed) return denyAndLog(c.tx, { tenantId: c.tenantId, viewer: c.viewer, action: "list", matterId: id, reason: d.reason, detail: { what: "folders" } });
    const provisioned = await provisionMatterFolders(c.tx, c.tenantId, id);
    return { provisioned, folders: await listMatterFolders(c.tx, c.tenantId, id) };
  });
}

/** c84 — add a folder: { name, parentId?, defaultPrivilegeTag? }. */
export async function POST(req: Request, { params }: Params) {
  const { matterId } = await params;
  return documentRoute(
    "POST /api/document/matters/[matterId]/folders",
    async (c) => {
      const body = await readJson(req);
      return createFolder(c.tx, c.tenantId, c.viewer, c.access, {
        matterId: assertUuidParam(matterId, "matter id"),
        parentId: uuidOrNull(body, "parentId"),
        name: str(body, "name", { required: true, max: 200 })!,
        defaultPrivilegeTag: str(body, "defaultPrivilegeTag"),
      });
    },
    { status: 201 }
  );
}
