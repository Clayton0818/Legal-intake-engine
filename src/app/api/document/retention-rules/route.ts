import { documentRoute } from "@/app/api/document/_lib/route";
import { readJson, str } from "@/engines/document/http";
import { listRetentionRules, setRetentionRule } from "@/engines/document/retention/service";
import { DocumentError } from "@/engines/document/errors";

export const dynamic = "force-dynamic";

/** c84/c90 — the firm's own retention periods (the product ships none). */
export async function GET() {
  return documentRoute("GET /api/document/retention-rules", (c) => listRetentionRules(c.tx, c.tenantId));
}

/** { practiceArea|null, documentType|null, retainYearsAfterClose, basis } — replaces the live rule for that scope. */
export async function POST(req: Request) {
  return documentRoute(
    "POST /api/document/retention-rules",
    async (c) => {
      const body = await readJson(req);
      const years = body.retainYearsAfterClose;
      if (typeof years !== "number") throw new DocumentError("'retainYearsAfterClose' must be a number.", 422);
      return setRetentionRule(c.tx, c.tenantId, c.viewer, {
        practiceArea: str(body, "practiceArea"),
        documentType: str(body, "documentType"),
        retainYearsAfterClose: years,
        basis: str(body, "basis", { required: true, max: 1000 })!,
      });
    },
    { status: 201 }
  );
}
