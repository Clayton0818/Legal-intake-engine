// c65 — one entry point for every channel adapter (web chat/form, phone, inbox, SMS, staff-entered).
import { tenantRoute } from "@/tenancy/route";
import { receiveInbound } from "@/engines/intake/channels/service";
import { INTAKE_CHANNELS } from "@/engines/intake/channels/records";
import { actingUserId, oneOf, optionalStr, optionalUuid, readJson } from "../_lib/http";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return tenantRoute("POST /api/intake/inbound", async ({ tx, tenantId }) => {
    const body = await readJson(req);
    const from = (body.from && typeof body.from === "object" ? body.from : {}) as Record<string, unknown>;
    const language = optionalStr(body, "language");
    return receiveInbound(tx, {
      tenantId,
      channel: oneOf(body.channel, INTAKE_CHANNELS, "channel"),
      externalThreadId: optionalStr(body, "externalThreadId"),
      intakeSessionId: optionalUuid(body.intakeSessionId, "intakeSessionId"),
      from: {
        name: typeof from.name === "string" ? from.name : null,
        email: typeof from.email === "string" ? from.email : null,
        phone: typeof from.phone === "string" ? from.phone : null,
      },
      text: optionalStr(body, "text"),
      language: language === "es" ? "es" : language === "en" ? "en" : null,
      staffUserId: actingUserId(req),
    });
  });
}
