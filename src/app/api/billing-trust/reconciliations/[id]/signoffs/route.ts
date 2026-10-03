import { trustRoute } from "@/app/api/billing-trust/_lib/route";
import { optString, readBody, reqSignoffRole } from "@/engines/billing-trust/http";
import { signOffReconciliation } from "@/engines/billing-trust/reconciliationService";

export const dynamic = "force-dynamic";

/**
 * Sign off a balanced reconciliation as 'bookkeeper' (owner/bookkeeper) or
 * 'lawyer' (attorney). Gated on rules.trust_accounting (423 while pending).
 * The month closes when every required sign-off is in. Body: { role, note? }.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return trustRoute(
    "POST /api/billing-trust/reconciliations/:id/signoffs",
    async ({ svc }) => {
      const body = await readBody(req);
      return signOffReconciliation(svc, { reconciliationId: id, role: reqSignoffRole(body, "role"), note: optString(body, "note") });
    },
    { status: 201 }
  );
}
