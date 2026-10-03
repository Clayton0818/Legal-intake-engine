import { alertsRoute } from "@/app/api/calendar-alerts/_lib/route";
import { recordProviderEvent } from "@/engines/calendar-alerts/delivery/service";
import { AlertRuleError } from "@/engines/calendar-alerts/common";
import { oneOf, optString, optUuid, readBody } from "@/engines/calendar-alerts/http";

export const dynamic = "force-dynamic";

/**
 * c51 — delivery callbacks from the email provider: { notificationId? | providerMessageId?, status, detail? }.
 * 423 until vendor.email is approved. A real provider also needs webhook-signature verification (vendor work).
 */
export async function POST(req: Request) {
  return alertsRoute(
    "POST /api/calendar-alerts/email-events",
    async ({ tx, tenantId }) => {
      const body = await readBody(req);
      const notificationId = optUuid(body, "notificationId") ?? undefined;
      const providerMessageId = optString(body, "providerMessageId", 500) ?? undefined;
      if (!notificationId && !providerMessageId) throw new AlertRuleError("Give notificationId or providerMessageId.");
      const row = await recordProviderEvent(tx, { tenantId, notificationId, providerMessageId, status: oneOf(body, "status", ["delivered", "bounced", "failed"] as const), detail: optString(body, "detail", 2000) ?? undefined });
      return { recorded: Boolean(row) };
    },
    { permission: "integration.sync" }
  );
}
