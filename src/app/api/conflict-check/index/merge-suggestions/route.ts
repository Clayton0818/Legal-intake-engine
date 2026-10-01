import { conflictRoute } from "@/app/api/conflict-check/_lib/route";
import { listMergeSuggestions } from "@/engines/conflict-check/partyIndex";

export const dynamic = "force-dynamic";

/** Likely duplicates waiting for a person to confirm or reject (never auto-merged). */
export async function GET(req: Request) {
  const status = new URL(req.url).searchParams.get("status") ?? "open";
  return conflictRoute(
    "GET /api/conflict-check/index/merge-suggestions",
    req,
    ({ tx, tenantId, access }) => listMergeSuggestions(tx, tenantId, access, ["open", "confirmed", "rejected"].includes(status) ? status : "open"),
    { capability: "index.search" }
  );
}
