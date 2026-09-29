import { conflictRoute } from "@/app/api/conflict-check/_lib/route";
import { commitImport, discardImport, getImportReport } from "@/engines/conflict-check/importService";
import { assertUuidParam, oneOf, readBody } from "@/engines/conflict-check/http";

export const dynamic = "force-dynamic";

/** What was imported and what failed (row reasons for the conflicts role only). */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return conflictRoute("GET /api/conflict-check/imports/[id]", req, ({ tx, tenantId, access }) =>
    getImportReport(tx, { tenantId, batchId: assertUuidParam(id, "import id"), access })
  );
}

const ACTIONS = ["commit", "discard"] as const;

/** c96 step 2 — { action: "commit" } writes the valid rows to the party index; "discard" drops the upload. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return conflictRoute(
    "POST /api/conflict-check/imports/[id]",
    req,
    async ({ tx, tenantId, access }) => {
      const body = await readBody(req);
      const batchId = assertUuidParam(id, "import id");
      return oneOf(body, "action", ACTIONS) === "commit"
        ? commitImport(tx, { tenantId, batchId, access })
        : discardImport(tx, { tenantId, batchId, access });
    },
    { capability: "index.edit" }
  );
}
