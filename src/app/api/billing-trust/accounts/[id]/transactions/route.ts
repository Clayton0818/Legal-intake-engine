import { trustRoute } from "@/app/api/billing-trust/_lib/route";
import { parseTransactionInput, readBody } from "@/engines/billing-trust/http";
import { postTransaction, previewTransaction } from "@/engines/billing-trust/ledgerService";

export const dynamic = "force-dynamic";

/**
 * Post a movement of trust money (owner/bookkeeper). Gated on
 * rules.trust_accounting: while pending this returns 423 and the attempt is
 * audited. With ?preview=1 it only validates and shows what would be posted
 * (works while pending). Amounts are whole cents: { kind, effectiveDate,
 * reason, amountCents, subledgerId, toSubledgerId?, counterparty?, reference?,
 * invoiceId?, earnedBasis?, fundsSource?, memo? }.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const preview = new URL(req.url).searchParams.get("preview") === "1";
  return trustRoute(
    `POST /api/billing-trust/accounts/:id/transactions${preview ? "?preview" : ""}`,
    async ({ svc }) => {
      const input = parseTransactionInput(await readBody(req), id);
      return preview ? previewTransaction(svc, input) : postTransaction(svc, input);
    },
    { status: preview ? 200 : 201 }
  );
}
