import { conflictRoute } from "@/app/api/conflict-check/_lib/route";
import { requestExport } from "@/engines/conflict-check/logService";
import { readBody } from "@/engines/conflict-check/http";

export const dynamic = "force-dynamic";

/**
 * Queue an export of the log for an insurer application or a bar inquiry (c63 §4.3). 'summary'
 * (counts and process) is the default; 'full' (names) is blocked until
 * rules.conflict-check.export_disclosure is attorney-approved.
 */
export async function POST(req: Request) {
  return conflictRoute("POST /api/conflict-check/exports", req, async ({ tx, tenantId, access }) => {
    const body = await readBody(req);
    const f = (body.filter && typeof body.filter === "object" ? body.filter : {}) as Record<string, unknown>;
    const str = (k: string) => (typeof f[k] === "string" ? (f[k] as string) : undefined);
    return requestExport(tx, {
      tenantId,
      access,
      filter: { from: str("from"), to: str("to"), outcome: str("outcome"), status: str("status"), trigger: str("trigger"), q: str("q") },
      format: body.format === "json" ? "json" : "csv",
      redaction: body.redaction === "full" ? "full" : body.redaction === "summary" ? "summary" : undefined,
    });
  }, { status: 202, capability: "log.export" });
}
