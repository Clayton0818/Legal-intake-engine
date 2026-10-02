// c65 — every message on every channel for one session (staff only; transcripts are firm-only).
import { tenantRoute } from "@/tenancy/route";
import { listSessionMessages, suggestExistingContacts } from "@/engines/intake/channels/service";
import { requireActingStaff, uuid } from "../../../_lib/http";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return tenantRoute("GET /api/intake/sessions/[id]/transcript", async ({ tx, tenantId }) => {
    await requireActingStaff(tx, tenantId, req);
    const sessionId = uuid(id, "session id");
    return { messages: await listSessionMessages(tx, tenantId, sessionId), possibleExistingContacts: await suggestExistingContacts(tx, tenantId, sessionId) };
  });
}
