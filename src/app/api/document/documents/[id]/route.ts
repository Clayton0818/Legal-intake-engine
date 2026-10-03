import { documentRoute } from "@/app/api/document/_lib/route";
import { assertUuidParam } from "@/engines/document/http";
import { getDocumentDetail } from "@/engines/document/store/service";

export const dynamic = "force-dynamic";

/** c84 — one version's details and the file's version history. Logged as 'view'. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return documentRoute("GET /api/document/documents/[id]", (c) => getDocumentDetail(c.tx, c, assertUuidParam(id, "document id")));
}
