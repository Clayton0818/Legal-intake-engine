import { documentRoute } from "@/app/api/document/_lib/route";
import { assertUuidParam, bool, readJson, str } from "@/engines/document/http";
import { updateFolder } from "@/engines/document/folders/service";

export const dynamic = "force-dynamic";

/** c84 — rename or archive a folder: { name?, archived? }. Folders are never deleted. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return documentRoute("PATCH /api/document/folders/[id]", async (c) => {
    const body = await readJson(req);
    return updateFolder(c.tx, c.tenantId, c.viewer, c.access, assertUuidParam(id, "folder id"), {
      name: str(body, "name", { max: 200 }) ?? undefined,
      archived: bool(body, "archived"),
    });
  });
}
