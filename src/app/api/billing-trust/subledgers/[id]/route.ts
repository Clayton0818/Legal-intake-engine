import { trustRoute } from "@/app/api/billing-trust/_lib/route";
import { getSubledgerLedger } from "@/engines/billing-trust/ledgerService";

export const dynamic = "force-dynamic";

/** One client-matter ledger: every entry (who, when, why, invoice) with running balance, and its holds. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return trustRoute("GET /api/billing-trust/subledgers/:id", ({ tx, tenantId }) => getSubledgerLedger(tx, tenantId, id));
}
