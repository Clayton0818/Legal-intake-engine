import { allEnginesRoute } from "@/app/api/all-engines/_lib/route";
import { AllEnginesError } from "@/engines/all-engines/common/errors";
import { FIRM, assertCan } from "@/engines/all-engines/permissions/policy";
import { getPack, packContentHash } from "@/engines/all-engines/packs/registry";
import "@/engines/all-engines/gates";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ area: string }> };

/** The product's current pack for an area, for review before accepting (staff with practice_areas.manage). */
export async function GET(_req: Request, { params }: Params) {
  const { area } = await params;
  return allEnginesRoute("GET /api/all-engines/packs/:area", async ({ staff }) => {
    assertCan(staff.actor, "practice_areas.manage", FIRM, staff.config);
    const pack = getPack(area);
    if (!pack) throw new AllEnginesError("No pack for this practice area.", 404);
    return { contentHash: packContentHash(pack), pack };
  });
}
