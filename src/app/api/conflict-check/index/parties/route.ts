import { conflictRoute } from "@/app/api/conflict-check/_lib/route";
import { indexParty, searchIndex } from "@/engines/conflict-check/partyIndex";
import { INDEX_ROLES, NAME_TYPES, type NameType } from "@/engines/conflict-check/types";
import { oneOf, optBool, optString, optUuid, readBody, reqString } from "@/engines/conflict-check/http";
import { ConflictError } from "@/engines/conflict-check/util";

export const dynamic = "force-dynamic";

const PARTY_ROLES = [
  "caller", "opposing_party", "co_party", "client", "opposing_counsel", "child", "related_party",
  "witness", "expert", "guardian_ad_litem", "court", "other",
] as const;

/** Search the party index by name (conflicts role only, c56 rule 3). Searches are logged. */
export async function GET(req: Request) {
  return conflictRoute(
    "GET /api/conflict-check/index/parties",
    req,
    ({ tx, tenantId, access }) => searchIndex(tx, { tenantId, query: new URL(req.url).searchParams.get("q") ?? "", access }),
    { capability: "index.search" }
  );
}

/**
 * Add a party to the index by hand (conflicts role), optionally linked to a matter or an intake
 * session. Parties added to matters by other engines are indexed automatically by the worker.
 */
export async function POST(req: Request) {
  return conflictRoute("POST /api/conflict-check/index/parties", req, async ({ tx, tenantId, access }) => {
    const body = await readBody(req);
    const matterId = optUuid(body, "matterId");
    const intakeSessionId = optUuid(body, "intakeSessionId");
    if (matterId && intakeSessionId) throw new ConflictError("Link to a matter or an intake session, not both.", 422);
    const variantsRaw = Array.isArray(body.variants) ? body.variants : [];
    const variants = variantsRaw.map((v) => {
      const o = (v ?? {}) as Record<string, unknown>;
      if (typeof o.name !== "string" || !(NAME_TYPES as readonly string[]).includes(String(o.type))) {
        throw new ConflictError("Each name variant needs a name and a type.", 422);
      }
      return { name: o.name, type: o.type as NameType };
    });
    return indexParty(tx, {
      tenantId,
      name: reqString(body, "name"),
      kind: body.kind === "organization" ? "organization" : "person",
      dateOfBirth: optString(body, "dateOfBirth"),
      email: optString(body, "email"),
      phone: optString(body, "phone"),
      variants,
      source: "manual",
      reusePartyId: optUuid(body, "reusePartyId"),
      link: matterId
        ? { type: "matter", matterId, role: oneOf(body, "role", PARTY_ROLES), relationship: optString(body, "relationship"), isAdverse: optBool(body, "isAdverse") ?? null }
        : intakeSessionId
          ? { type: "inquiry", intakeSessionId, role: oneOf(body, "role", INDEX_ROLES), relationship: optString(body, "relationship") }
          : undefined,
      by: access,
    });
  }, { status: 201, capability: "index.edit" });
}
