import { allEnginesRoute } from "@/app/api/all-engines/_lib/route";
import { describeStaffContext } from "@/engines/all-engines/permissions/service";

export const dynamic = "force-dynamic";

/** The signed-in person's roles and effective rights (c99). */
export async function GET() {
  return allEnginesRoute("GET /api/all-engines/me", async ({ staff }) => describeStaffContext(staff));
}
