import { conflictRoute } from "@/app/api/conflict-check/_lib/route";
import { confirmDisclosures } from "@/engines/conflict-check/interestService";

export const dynamic = "force-dynamic";

/** Confirm your list is current (c97 §4.1.5). */
export async function POST(req: Request) {
  return conflictRoute("POST /api/conflict-check/interests/confirm", req, ({ tx, tenantId, access }) => confirmDisclosures(tx, { tenantId, access }));
}
