import { trustRoute } from "@/app/api/billing-trust/_lib/route";
import { optCents, optString, readBody } from "@/engines/billing-trust/http";
import { getAccountRegister, getTrustAccount, listSubledgers, updateTrustAccount } from "@/engines/billing-trust/ledgerService";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** The account book: account, client-matter sub-ledgers and the full register with running balance. */
export async function GET(_req: Request, { params }: Params) {
  const { id } = await params;
  return trustRoute("GET /api/billing-trust/accounts/:id", async ({ tx, tenantId }) => ({
    account: await getTrustAccount(tx, tenantId, id),
    subledgers: await listSubledgers(tx, tenantId, id),
    register: await getAccountRegister(tx, tenantId, id),
  }));
}

/** Rename, or change the firm's bank-fee cushion cap (usable only once the cushion rule is approved). */
export async function PATCH(req: Request, { params }: Params) {
  const { id } = await params;
  return trustRoute("PATCH /api/billing-trust/accounts/:id", async ({ svc }) => {
    const body = await readBody(req);
    return updateTrustAccount(svc, id, {
      name: optString(body, "name"),
      ...(body.bankFeeCushionCapCents !== undefined ? { bankFeeCushionCapCents: optCents(body, "bankFeeCushionCapCents") } : {}),
    });
  });
}
