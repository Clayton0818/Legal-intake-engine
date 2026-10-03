import { trustRoute } from "@/app/api/billing-trust/_lib/route";
import { optString, readBody, reqDate } from "@/engines/billing-trust/http";
import { postTransaction } from "@/engines/billing-trust/ledgerService";

export const dynamic = "force-dynamic";

/** Correct an entry with an exact reversing entry (entries are never edited). Gated like any posting. Body: { effectiveDate, reason, memo? }. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string; txId: string }> }) {
  const { id, txId } = await params;
  return trustRoute(
    "POST /api/billing-trust/accounts/:id/transactions/:txId/reverse",
    async ({ svc }) => {
      const body = await readBody(req);
      return postTransaction(svc, {
        kind: "reversal",
        trustAccountId: id,
        reversesTransactionId: txId,
        effectiveDate: reqDate(body, "effectiveDate"),
        reason: typeof body.reason === "string" ? body.reason : "",
        memo: optString(body, "memo"),
      });
    },
    { status: 201 }
  );
}
