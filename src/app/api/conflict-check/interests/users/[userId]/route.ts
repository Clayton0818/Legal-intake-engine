import { conflictRoute } from "@/app/api/conflict-check/_lib/route";
import { listDisclosuresOf } from "@/engines/conflict-check/interestService";
import { assertUuidParam } from "@/engines/conflict-check/http";

export const dynamic = "force-dynamic";

/** Another lawyer's list: conflicts role only; the view is logged without contents. */
export async function GET(req: Request, { params }: { params: Promise<{ userId: string }> }) {
  const { userId } = await params;
  return conflictRoute(
    "GET /api/conflict-check/interests/users/[userId]",
    req,
    ({ tx, tenantId, access }) => listDisclosuresOf(tx, { tenantId, userId: assertUuidParam(userId, "user id"), access }),
    { capability: "log.view_interests" }
  );
}
