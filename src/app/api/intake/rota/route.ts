// c66 — the firm's on-call rota.
import { tenantRoute } from "@/tenancy/route";
import { addRotaShift, deactivateRotaShift, listRota } from "@/engines/intake/emergency/service";
import { oneOf, optionalDate, optionalStr, readJson, requireActingStaff, requireActingUserId, uuid } from "../_lib/http";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return tenantRoute("GET /api/intake/rota", async ({ tx, tenantId }) => {
    await requireActingStaff(tx, tenantId, req);
    return listRota(tx, tenantId);
  });
}

export async function POST(req: Request) {
  return tenantRoute(
    "POST /api/intake/rota",
    async ({ tx, tenantId }) => {
      const body = await readJson(req);
      return addRotaShift(tx, {
        tenantId,
        byUserId: requireActingUserId(req),
        userId: uuid(body.userId, "userId"),
        role: oneOf(body.role, ["primary", "backup", "staff"] as const, "role"),
        startsAt: optionalDate(body, "startsAt"),
        endsAt: optionalDate(body, "endsAt"),
        weekday: optionalStr(body, "weekday"),
        startTime: optionalStr(body, "startTime"),
        endTime: optionalStr(body, "endTime"),
      });
    },
    { status: 201 }
  );
}

export async function DELETE(req: Request) {
  return tenantRoute("DELETE /api/intake/rota", async ({ tx, tenantId }) => {
    const shiftId = uuid(new URL(req.url).searchParams.get("shiftId"), "shiftId");
    await deactivateRotaShift(tx, { tenantId, byUserId: requireActingUserId(req), shiftId });
    return { ok: true };
  });
}
