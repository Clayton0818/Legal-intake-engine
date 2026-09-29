// c73 — the firm's own referral list (no referral-fee tracking: Rule 1.04 stays with the firm's attorney).
import { tenantRoute } from "@/tenancy/route";
import { addReferralEntry, deactivateReferralEntry, listReferralDirectory } from "@/engines/intake/acceptance/service";
import { readJson, requireActingStaff, requireActingUserId, str, stringArray, uuid } from "../../_lib/http";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return tenantRoute("GET /api/intake/acceptance/referrals", async ({ tx, tenantId }) => {
    await requireActingStaff(tx, tenantId, req);
    return listReferralDirectory(tx, tenantId);
  });
}

export async function POST(req: Request) {
  return tenantRoute(
    "POST /api/intake/acceptance/referrals",
    async ({ tx, tenantId }) => {
      const body = await readJson(req);
      return addReferralEntry(tx, {
        tenantId,
        byUserId: requireActingUserId(req),
        name: str(body, "name"),
        contact: str(body, "contact"),
        practiceAreas: stringArray(body, "practiceAreas"),
        counties: stringArray(body, "counties"),
      });
    },
    { status: 201 }
  );
}

export async function DELETE(req: Request) {
  return tenantRoute("DELETE /api/intake/acceptance/referrals", async ({ tx, tenantId }) => {
    const entryId = uuid(new URL(req.url).searchParams.get("entryId"), "entryId");
    await deactivateReferralEntry(tx, { tenantId, byUserId: requireActingUserId(req), entryId });
    return { ok: true };
  });
}
