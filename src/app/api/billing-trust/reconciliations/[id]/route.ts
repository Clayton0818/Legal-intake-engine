import { trustRoute } from "@/app/api/billing-trust/_lib/route";
import { getReconciliation } from "@/engines/billing-trust/reconciliationService";

export const dynamic = "force-dynamic";

/** The stored worksheet, its sign-offs, whether it closed the month, and whether it is still intact (hash). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return trustRoute("GET /api/billing-trust/reconciliations/:id", ({ tx, tenantId }) => getReconciliation(tx, tenantId, id));
}
