import { trustRoute } from "@/app/api/billing-trust/_lib/route";
import { readBody, reqPeriod } from "@/engines/billing-trust/http";
import { pullStatementFromFeed } from "@/engines/billing-trust/reconciliationService";

export const dynamic = "force-dynamic";

/** Pull the month's statement from the bank-feed vendor. Gated (423 while pending); the shipped adapter is a stub. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return trustRoute("POST /api/billing-trust/accounts/:id/statements/feed", async ({ svc }) => {
    const body = await readBody(req);
    return pullStatementFromFeed(svc, id, reqPeriod(body, "period"));
  });
}
