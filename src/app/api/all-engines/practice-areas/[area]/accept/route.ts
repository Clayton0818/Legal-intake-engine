import { allEnginesRoute } from "@/app/api/all-engines/_lib/route";
import { optString, readBody, reqString } from "@/engines/all-engines/common/body";
import { acceptPackUpdate } from "@/engines/all-engines/practiceAreas/service";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ area: string }> };

/** Accept the reviewed pack version: { version, contentHash, notes? }. Refused if the pack changed since review. Logged. */
export async function POST(req: Request, { params }: Params) {
  const { area } = await params;
  return allEnginesRoute("POST /api/all-engines/practice-areas/:area/accept", async ({ tx, tenantId, staff }) => {
    const body = await readBody(req);
    return acceptPackUpdate(tx, { tenantId, by: staff, area, version: reqString(body, "version"), contentHash: reqString(body, "contentHash"), notes: optString(body, "notes") });
  });
}
