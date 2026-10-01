import { conflictRoute } from "@/app/api/conflict-check/_lib/route";
import { createLateralCheck, listLateralChecks } from "@/engines/conflict-check/lateralService";
import { readBody, reqString, reqUuid } from "@/engines/conflict-check/http";
import { ConflictError } from "@/engines/conflict-check/util";

export const dynamic = "force-dynamic";

/** Lateral-hire checks (status for the firm admin; lists for the conflicts role). */
export async function GET(req: Request) {
  return conflictRoute("GET /api/conflict-check/lateral", req, ({ tx, tenantId, access }) => listLateralChecks(tx, tenantId, access));
}

/** The firm admin starts a new hire's check with their start date (c61 §4.1). */
export async function POST(req: Request) {
  return conflictRoute("POST /api/conflict-check/lateral", req, async ({ tx, tenantId, access }) => {
    const body = await readBody(req);
    const startDate = reqString(body, "startDate");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) throw new ConflictError("startDate must be YYYY-MM-DD.", 422);
    const former = Array.isArray(body.formerFirmNames) ? body.formerFirmNames.filter((x): x is string => typeof x === "string") : [];
    return createLateralCheck(tx, { tenantId, userId: reqUuid(body, "userId"), startDate, formerFirmNames: former, access });
  }, { status: 201, capability: "lateral.manage" });
}
