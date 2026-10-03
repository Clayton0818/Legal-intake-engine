import { allEnginesRoute } from "@/app/api/all-engines/_lib/route";
import { AllEnginesError } from "@/engines/all-engines/common/errors";
import { listAccessChanges, type AccessChange } from "@/engines/all-engines/permissions/service";

export const dynamic = "force-dynamic";

const AREAS = ["permissions", "roles", "matter_access", "practice_areas", "packs"] as const;

/** The append-only change log (?area=…&limit=…). permissions.manage or audit.view. */
export async function GET(req: Request) {
  return allEnginesRoute("GET /api/all-engines/permissions/log", async ({ tx, tenantId, staff }) => {
    const url = new URL(req.url);
    const area = url.searchParams.get("area");
    if (area && !(AREAS as readonly string[]).includes(area)) throw new AllEnginesError("Unknown area.");
    const limit = Number(url.searchParams.get("limit") ?? 100);
    return listAccessChanges(tx, tenantId, staff, { area: (area as AccessChange["area"]) ?? undefined, limit: Number.isFinite(limit) ? limit : 100 });
  });
}
