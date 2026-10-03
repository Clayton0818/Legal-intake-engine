import { trustRoute } from "@/app/api/billing-trust/_lib/route";
import { readBody, reqCents, reqString, reqUuid } from "@/engines/billing-trust/http";
import { placeHold } from "@/engines/billing-trust/ledgerService";

export const dynamic = "force-dynamic";

/** Hold disputed funds in a client ledger (excluded from what can be moved). Body: { trustAccountId, subledgerId, amountCents, reason }. */
export async function POST(req: Request) {
  return trustRoute(
    "POST /api/billing-trust/holds",
    async ({ svc }) => {
      const body = await readBody(req);
      return placeHold(svc, {
        trustAccountId: reqUuid(body, "trustAccountId"),
        subledgerId: reqUuid(body, "subledgerId"),
        amount: reqCents(body, "amountCents"),
        reason: reqString(body, "reason"),
      });
    },
    { status: 201 }
  );
}
