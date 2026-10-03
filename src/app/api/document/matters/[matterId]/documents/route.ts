import { documentRoute } from "@/app/api/document/_lib/route";
import { assertUuidParam, readUpload } from "@/engines/document/http";
import { listMatterDocuments, uploadDocument } from "@/engines/document/store/service";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ matterId: string }> };

/** c84 — the matter's files (current versions). ?folderId=<id>|root to filter. Logged as 'list'. */
export async function GET(req: Request, { params }: Params) {
  const { matterId } = await params;
  const folder = new URL(req.url).searchParams.get("folderId");
  return documentRoute("GET /api/document/matters/[matterId]/documents", (c) =>
    listMatterDocuments(c.tx, c, assertUuidParam(matterId, "matter id"), {
      folderId: folder === null ? undefined : folder === "root" ? null : assertUuidParam(folder, "folder id"),
    })
  );
}

/**
 * c84 — upload a new file, or a new VERSION of an existing one (field
 * groupId). multipart/form-data: file, and optional groupId, folderId,
 * title, documentType, privilegeTag, sha256 (verified when given).
 */
export async function POST(req: Request, { params }: Params) {
  const { matterId } = await params;
  return documentRoute(
    "POST /api/document/matters/[matterId]/documents",
    async (c) => {
      const up = await readUpload(req, c.settings.maxUploadBytes);
      const f = up.fields;
      return uploadDocument(c.tx, c, {
        matterId: assertUuidParam(matterId, "matter id"),
        groupId: f.groupId ? assertUuidParam(f.groupId, "group id") : null,
        folderId: f.folderId ? assertUuidParam(f.folderId, "folder id") : null,
        bytes: up.bytes,
        filename: up.filename,
        declaredMimeType: up.declaredMimeType,
        expectedSha256: f.sha256 || null,
        title: f.title || null,
        documentType: f.documentType || null,
        privilegeTag: f.privilegeTag || null,
      });
    },
    { status: 201 }
  );
}
