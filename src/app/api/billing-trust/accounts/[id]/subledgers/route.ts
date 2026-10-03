import { trustRoute } from "@/app/api/billing-trust/_lib/route";
import { readBody, reqUuid } from "@/engines/billing-trust/http";
import { openClientSubledger, openCushionSubledger } from "@/engines/billing-trust/ledgerService";

export const dynamic = "force-dynamic";

/** Open a client-matter ledger ({ clientPartyId, matterId }) or the firm cushion ledger ({ kind: 'firm_cushion' }). */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return trustRoute(
    "POST /api/billing-trust/accounts/:id/subledgers",
    async ({ svc }) => {
      const body = await readBody(req);
      if (body.kind === "firm_cushion") return openCushionSubledger(svc, id);
      return openClientSubledger(svc, { trustAccountId: id, clientPartyId: reqUuid(body, "clientPartyId"), matterId: reqUuid(body, "matterId") });
    },
    { status: 201 }
  );
}
