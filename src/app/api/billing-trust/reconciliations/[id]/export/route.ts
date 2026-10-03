import { downloadResponse, trustRoute } from "@/app/api/billing-trust/_lib/route";
import { exportReconciliation } from "@/engines/billing-trust/reconciliationService";

export const dynamic = "force-dynamic";

/** Download a stored reconciliation report: ?format=csv (default) or ?format=json. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const format = new URL(req.url).searchParams.get("format") === "json" ? "json" : "csv";
  return downloadResponse(
    await trustRoute("GET /api/billing-trust/reconciliations/:id/export", ({ tx, tenantId }) => exportReconciliation(tx, tenantId, id, format))
  );
}
