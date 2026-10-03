import { documentRoute } from "@/app/api/document/_lib/route";
import { readJson, str, uuidOrNull } from "@/engines/document/http";
import { addAccessBlock, accessHookNames, listAccessBlocks } from "@/engines/document/access/service";
import { DocumentError } from "@/engines/document/errors";

export const dynamic = "force-dynamic";

/**
 * c84/c60 — the document engine's screens mirror (until a shared screens
 * table exists). Firm admins and attorneys only.
 */
export async function GET(req: Request) {
  const includeEnded = new URL(req.url).searchParams.get("includeEnded") === "1";
  return documentRoute("GET /api/document/screens", async (c) => {
    if (!(c.viewer.role === "firm_admin" || c.viewer.role === "attorney")) throw new DocumentError("Not allowed.", 403);
    return { sources: accessHookNames(), screens: await listAccessBlocks(c.tx, c.tenantId, { includeEnded }) };
  });
}

/** { userId, matterId, reason: 'ethical_screen'|'restricted'|'other', note?, sourceRef? } */
export async function POST(req: Request) {
  return documentRoute(
    "POST /api/document/screens",
    async (c) => {
      const body = await readJson(req);
      const userId = uuidOrNull(body, "userId");
      const matterId = uuidOrNull(body, "matterId");
      if (!userId || !matterId) throw new DocumentError("'userId' and 'matterId' are required.", 422);
      return addAccessBlock(c.tx, c.tenantId, c.viewer, {
        userId,
        matterId,
        reason: str(body, "reason", { required: true })!,
        note: str(body, "note", { max: 1000 }),
        sourceRef: str(body, "sourceRef", { max: 200 }),
        source: body.source === "sync" ? "sync" : "manual",
      });
    },
    { status: 201 }
  );
}
