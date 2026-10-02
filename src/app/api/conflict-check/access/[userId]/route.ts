import { conflictRoute } from "@/app/api/conflict-check/_lib/route";
import { can } from "@/engines/conflict-check/access";
import { matterAccessFor } from "@/engines/conflict-check/lateralService";
import { assertUuidParam } from "@/engines/conflict-check/http";
import { ConflictError } from "@/engines/conflict-check/util";

export const dynamic = "force-dynamic";

/**
 * Which matters a user may open as far as conflicts are concerned: the lateral-hire restriction
 * (c61 rule 3) and screens (c60). For other engines until a shared permission layer exists.
 */
export async function GET(req: Request, { params }: { params: Promise<{ userId: string }> }) {
  const { userId } = await params;
  return conflictRoute("GET /api/conflict-check/access/[userId]", req, ({ tx, tenantId, access }) => {
    const target = assertUuidParam(userId, "user id");
    if (target !== access.userId && !can(access, "lateral.manage") && !can(access, "log.view")) throw new ConflictError("Not allowed.", 403);
    return matterAccessFor(tx, tenantId, target);
  });
}
