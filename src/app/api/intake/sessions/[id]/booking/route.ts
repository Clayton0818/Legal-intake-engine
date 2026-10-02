// c67 — booking options for a session, and holding a slot.
import { tenantRoute } from "@/tenancy/route";
import { getBookingOptions, holdSlot } from "@/engines/intake/booking/service";
import { actingUserId, date, oneOf, readJson, uuid } from "../../../_lib/http";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return tenantRoute("GET /api/intake/sessions/[id]/booking", async ({ tx, tenantId }) => {
    const options = await getBookingOptions(tx, { tenantId, intakeSessionId: uuid(id, "session id") });
    if (actingUserId(req)) return options;
    // The person never learns why booking is not offered (conflicts are confidential),
    // nor anything about internal calendar problems.
    if (!options.offered) return { offered: false, message: options.message };
    return { ...options, unavailable: [] };
  });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return tenantRoute(
    "POST /api/intake/sessions/[id]/booking",
    async ({ tx, tenantId }) => {
      const body = await readJson(req);
      const row = await holdSlot(tx, {
        tenantId,
        intakeSessionId: uuid(id, "session id"),
        lawyerUserId: uuid(body.lawyerUserId, "lawyerUserId"),
        startsAt: date(body, "startsAt"),
        format: oneOf(body.format, ["video", "phone", "in_person"] as const, "format"),
        bookedByUserId: actingUserId(req),
      });
      return { consultationId: row.id, holdExpiresAt: row.holdExpiresAt, startsAt: row.startsAt, endsAt: row.endsAt, paymentStatus: row.paymentStatus };
    },
    { status: 201 }
  );
}
