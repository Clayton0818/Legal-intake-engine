import { trustRoute } from "@/app/api/billing-trust/_lib/route";
import { optString, optUuid, readBody, reqCents, reqPeriod } from "@/engines/billing-trust/http";
import { importStatement, importStatementCsv, listStatements } from "@/engines/billing-trust/reconciliationService";
import { parseStatementLines } from "@/engines/billing-trust/statementIo";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  const { id } = await params;
  return trustRoute("GET /api/billing-trust/accounts/:id/statements", ({ tx, tenantId }) => listStatements(tx, tenantId, id));
}

/**
 * Record the month's bank statement (owner/bookkeeper): { period, openingBalanceCents,
 * closingBalanceCents, lines: [{ postedOn, amountCents, description, reference?, kind? }] }
 * or the bank's CSV as { period, openingBalanceCents, closingBalanceCents, csv }.
 * A correction supersedes the earlier statement (supersedesStatementId).
 */
export async function POST(req: Request, { params }: Params) {
  const { id } = await params;
  return trustRoute(
    "POST /api/billing-trust/accounts/:id/statements",
    async ({ svc }) => {
      const body = await readBody(req);
      const common = {
        trustAccountId: id,
        period: reqPeriod(body, "period"),
        openingBalance: reqCents(body, "openingBalanceCents"),
        closingBalance: reqCents(body, "closingBalanceCents"),
        note: optString(body, "note"),
        supersedesStatementId: optUuid(body, "supersedesStatementId"),
      };
      if (typeof body.csv === "string") return importStatementCsv(svc, { ...common, csv: body.csv });
      return importStatement(svc, { ...common, lines: parseStatementLines(body.lines ?? []), source: "manual" });
    },
    { status: 201 }
  );
}
