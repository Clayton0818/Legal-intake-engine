import { trustRoute } from "@/app/api/billing-trust/_lib/route";
import { optAccountType, optCents, readBody, reqDate, reqString } from "@/engines/billing-trust/http";
import { createTrustAccount, listTrustAccounts } from "@/engines/billing-trust/ledgerService";

export const dynamic = "force-dynamic";

/** The firm's trust bank accounts with book balance vs Σ client ledgers. */
export async function GET() {
  return trustRoute("GET /api/billing-trust/accounts", ({ tx, tenantId }) => listTrustAccounts(tx, tenantId));
}

/** Register a trust bank account (owner/bookkeeper). Body: name, bankName, accountNumberLast4, openedOn, accountType?, bankFeeCushionCapCents?. */
export async function POST(req: Request) {
  return trustRoute(
    "POST /api/billing-trust/accounts",
    async ({ svc }) => {
      const body = await readBody(req);
      return createTrustAccount(svc, {
        name: reqString(body, "name"),
        bankName: reqString(body, "bankName"),
        accountNumberLast4: reqString(body, "accountNumberLast4"),
        accountType: optAccountType(body, "accountType"),
        openedOn: reqDate(body, "openedOn"),
        bankFeeCushionCapCents: optCents(body, "bankFeeCushionCapCents"),
      });
    },
    { status: 201 }
  );
}
