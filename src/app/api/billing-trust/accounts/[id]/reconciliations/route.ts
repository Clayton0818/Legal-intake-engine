import { trustRoute } from "@/app/api/billing-trust/_lib/route";
import { parseManualMatches, readBody, reqPeriod } from "@/engines/billing-trust/http";
import { listReconciliations, prepareReconciliation } from "@/engines/billing-trust/reconciliationService";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** Every reconciliation ever prepared for the account (kept, never deleted). */
export async function GET(_req: Request, { params }: Params) {
  const { id } = await params;
  return trustRoute("GET /api/billing-trust/accounts/:id/reconciliations", ({ tx, tenantId }) => listReconciliations(tx, tenantId, id));
}

/** Prepare the month's three-way reconciliation (works while rules are pending). Body: { period, manualMatches? }. */
export async function POST(req: Request, { params }: Params) {
  const { id } = await params;
  return trustRoute(
    "POST /api/billing-trust/accounts/:id/reconciliations",
    async ({ svc }) => {
      const body = await readBody(req);
      const { reconciliation, report } = await prepareReconciliation(svc, {
        trustAccountId: id,
        period: reqPeriod(body, "period"),
        manualMatches: parseManualMatches(body.manualMatches),
      });
      return { id: reconciliation.id, status: reconciliation.status, reportHash: reconciliation.reportHash, report };
    },
    { status: 201 }
  );
}
