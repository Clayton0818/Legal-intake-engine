import { documentRoute } from "@/app/api/document/_lib/route";
import { assertUuidParam } from "@/engines/document/http";
import { listAccessLog } from "@/engines/document/access/service";
import { DocumentError } from "@/engines/document/errors";

export const dynamic = "force-dynamic";

/** c84 — who viewed / downloaded / searched what. Needs audit.read. Filter by ?documentId= ?groupId= ?matterId=. */
export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  return documentRoute("GET /api/document/access-log", async (c) => {
    if (!c.viewer.permissions.includes("audit.read")) throw new DocumentError("Not allowed.", 403);
    const opt = (k: string) => {
      const v = sp.get(k);
      return v ? assertUuidParam(v, k) : undefined;
    };
    return listAccessLog(c.tx, c.tenantId, {
      documentId: opt("documentId"),
      groupId: opt("groupId"),
      matterId: opt("matterId"),
      limit: Number(sp.get("limit") ?? "200") || 200,
    });
  });
}
