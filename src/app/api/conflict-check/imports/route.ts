import { conflictRoute } from "@/app/api/conflict-check/_lib/route";
import { listImports, validateImport } from "@/engines/conflict-check/importService";
import { optString, readBody, reqString } from "@/engines/conflict-check/http";
import { ConflictError } from "@/engines/conflict-check/util";

export const dynamic = "force-dynamic";

/** Imports so far (counts only; firm admin or conflicts role). */
export async function GET(req: Request) {
  return conflictRoute("GET /api/conflict-check/imports", req, ({ tx, tenantId, access }) => listImports(tx, tenantId, access));
}

/**
 * c96 step 1 — upload and validate a CSV of the firm's history:
 * { filename, csv, columnMap? } (columnMap: source header → field, for unusual exports).
 * Nothing reaches the party index until the import is committed.
 */
export async function POST(req: Request) {
  return conflictRoute(
    "POST /api/conflict-check/imports",
    req,
    async ({ tx, tenantId, access }) => {
      const body = await readBody(req);
      const map = body.columnMap;
      if (map !== undefined && (typeof map !== "object" || map === null || Array.isArray(map) || !Object.values(map).every((v) => typeof v === "string"))) {
        throw new ConflictError("'columnMap' must map header names to field names.", 422);
      }
      return validateImport(tx, {
        tenantId,
        filename: optString(body, "filename") ?? "import.csv",
        csv: reqString(body, "csv"),
        columnMap: map as Record<string, string> | undefined,
        access,
      });
    },
    { status: 201, capability: "index.edit" }
  );
}
