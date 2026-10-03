import { documentRoute } from "@/app/api/document/_lib/route";
import { assertUuidParam, readJson, str } from "@/engines/document/http";
import { endAccessBlock } from "@/engines/document/access/service";

export const dynamic = "force-dynamic";

/** c84/c60 — end a screen: { reason }. Rows are ended, never deleted. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return documentRoute("POST /api/document/screens/[id]", async (c) => {
    const reason = str(await readJson(req), "reason", { required: true, max: 1000 })!;
    return endAccessBlock(c.tx, c.tenantId, c.viewer, assertUuidParam(id, "screen id"), reason);
  });
}
