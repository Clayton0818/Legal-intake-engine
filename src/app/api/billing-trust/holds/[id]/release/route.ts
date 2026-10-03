import { trustRoute } from "@/app/api/billing-trust/_lib/route";
import { readBody, reqString } from "@/engines/billing-trust/http";
import { releaseHold } from "@/engines/billing-trust/ledgerService";

export const dynamic = "force-dynamic";

/** Release a disputed-funds hold once the dispute is resolved. Body: { reason }. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return trustRoute("POST /api/billing-trust/holds/:id/release", async ({ svc }) => {
    const body = await readBody(req);
    return releaseHold(svc, id, reqString(body, "reason"));
  });
}
