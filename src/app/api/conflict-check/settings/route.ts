import { conflictRoute } from "@/app/api/conflict-check/_lib/route";
import { confirmHistoryImport, getConflictSettings, updateConflictSettings } from "@/engines/conflict-check/settingsService";
import { optBool, optString, readBody } from "@/engines/conflict-check/http";
import { ConflictError } from "@/engines/conflict-check/util";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return conflictRoute("GET /api/conflict-check/settings", req, ({ tx, tenantId, access }) => getConflictSettings(tx, tenantId, access));
}

/** Change the engine's firm settings (firm admin). Unknown keys are refused. */
export async function PATCH(req: Request) {
  return conflictRoute("PATCH /api/conflict-check/settings", req, async ({ tx, tenantId, access }) =>
    updateConflictSettings(tx, { tenantId, patch: await readBody(req), access })
  );
}

/**
 * { action: "confirm_history_import", noPriorHistory?, attestation? }: the firm's history import (c96)
 * is complete (conflicts attorney). Needs a committed import or a written no-history attestation.
 */
export async function POST(req: Request) {
  return conflictRoute("POST /api/conflict-check/settings", req, async ({ tx, tenantId, access }) => {
    const body = await readBody(req);
    if (body.action !== "confirm_history_import") throw new ConflictError("Unknown action.", 422);
    return confirmHistoryImport(tx, { tenantId, access, noPriorHistory: optBool(body, "noPriorHistory"), attestation: optString(body, "attestation") });
  });
}
