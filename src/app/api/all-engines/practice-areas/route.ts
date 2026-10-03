import { allEnginesRoute } from "@/app/api/all-engines/_lib/route";
import { readBody, reqString, reqStringList } from "@/engines/all-engines/common/body";
import { getPracticeAreaOverview, setEnabledPracticeAreas } from "@/engines/all-engines/practiceAreas/service";

export const dynamic = "force-dynamic";

/** Every practice area: switched on?, pack version accepted vs available, changes to review (practice_areas.manage). */
export async function GET() {
  return allEnginesRoute("GET /api/all-engines/practice-areas", ({ tx, tenantId, staff }) => getPracticeAreaOverview(tx, tenantId, staff));
}

/** Set the switched-on areas: { areas: ["family", …], reason }. At least one; known packs only. Never deletes matters. Logged. */
export async function PUT(req: Request) {
  return allEnginesRoute("PUT /api/all-engines/practice-areas", async ({ tx, tenantId, staff }) => {
    const body = await readBody(req);
    return setEnabledPracticeAreas(tx, { tenantId, by: staff, areas: reqStringList(body, "areas"), reason: reqString(body, "reason") });
  });
}
