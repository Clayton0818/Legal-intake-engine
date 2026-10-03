import { documentRoute } from "@/app/api/document/_lib/route";
import { assertUuidParam, bool, readJson, str, uuidOrNull } from "@/engines/document/http";
import { updateDocumentGroup, type GroupPatch } from "@/engines/document/store/service";
import { DocumentError } from "@/engines/document/errors";

export const dynamic = "force-dynamic";

/**
 * c84 — move / rename / tag a file: { title?, folderId?, privilegeTag?,
 * clientVisible?, legalHold?: { on, reason }, originalHeld?, archived? }.
 * New versions are uploaded through POST /api/document/matters/<id>/documents with groupId.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return documentRoute("PATCH /api/document/groups/[id]", async (c) => {
    const body = await readJson(req);
    const patch: GroupPatch = {};
    const title = str(body, "title", { max: 300 });
    if (title !== null) patch.title = title;
    if ("folderId" in body) patch.folderId = uuidOrNull(body, "folderId");
    const tag = str(body, "privilegeTag");
    if (tag !== null) patch.privilegeTag = tag;
    const cv = bool(body, "clientVisible");
    if (cv !== undefined) patch.clientVisible = cv;
    const oh = bool(body, "originalHeld");
    if (oh !== undefined) patch.originalHeld = oh;
    const ar = bool(body, "archived");
    if (ar !== undefined) patch.archived = ar;
    if (body.legalHold !== undefined) {
      const lh = body.legalHold as Record<string, unknown> | null;
      if (!lh || typeof lh !== "object" || typeof lh.on !== "boolean") throw new DocumentError("'legalHold' must be { on: boolean, reason?: string }.", 422);
      patch.legalHold = { on: lh.on, reason: typeof lh.reason === "string" ? lh.reason : null };
    }
    return updateDocumentGroup(c.tx, c, assertUuidParam(id, "document id"), patch);
  });
}
