import { conflictRoute } from "@/app/api/conflict-check/_lib/route";
import { getFirmSettings } from "@/core";
import { indexHealth } from "@/engines/conflict-check/partyIndex";
import { readConflictSettings } from "@/engines/conflict-check/settings";

export const dynamic = "force-dynamic";

/** Index health (counts only): what the firm owner/admin may see without the conflicts role. */
export async function GET(req: Request) {
  return conflictRoute(
    "GET /api/conflict-check/index/health",
    req,
    async ({ tx, tenantId, access }) => {
      const settings = readConflictSettings(await getFirmSettings(tx, tenantId));
      return indexHealth(tx, tenantId, access, settings.historyImportConfirmedAt);
    },
    { capability: "health.view" }
  );
}
