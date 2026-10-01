import { conflictRoute } from "@/app/api/conflict-check/_lib/route";
import { addDisclosure, listMyDisclosures } from "@/engines/conflict-check/interestService";
import { optString, readBody, reqString } from "@/engines/conflict-check/http";

export const dynamic = "force-dynamic";

/** Your own private disclosure list (c97), with the attorney-reviewed instructions. */
export async function GET(req: Request) {
  return conflictRoute("GET /api/conflict-check/interests", req, ({ tx, tenantId, access }) => listMyDisclosures(tx, { tenantId, access }));
}

/** Add an interest to your own list; it is checked at once and any hit goes only to the conflicts attorney. */
export async function POST(req: Request) {
  return conflictRoute("POST /api/conflict-check/interests", req, async ({ tx, tenantId, access }) => {
    const body = await readBody(req);
    const ids = (body.identifiers && typeof body.identifiers === "object" ? body.identifiers : {}) as Record<string, unknown>;
    const identifiers = Object.fromEntries(Object.entries(ids).filter((e): e is [string, string] => typeof e[1] === "string"));
    const { disclosure } = await addDisclosure(tx, {
      tenantId,
      access,
      disclosure: {
        interestType: reqString(body, "interestType"),
        name: reqString(body, "name"),
        relationship: reqString(body, "relationship"),
        identifiers,
        startsOn: optString(body, "startsOn"),
        endsOn: optString(body, "endsOn"),
      },
    });
    // The lawyer is told only that it was saved.
    return { id: disclosure.id, saved: true };
  }, { status: 201 });
}
