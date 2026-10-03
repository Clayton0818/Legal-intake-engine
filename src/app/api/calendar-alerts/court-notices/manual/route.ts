import { alertsRoute } from "@/app/api/calendar-alerts/_lib/route";
import { ingestCourtEmail } from "@/engines/calendar-alerts/courtNotice/service";
import { requireRole } from "@/engines/calendar-alerts/common";
import { optString, readBody, reqDateTime, reqString } from "@/engines/calendar-alerts/http";

export const dynamic = "force-dynamic";

/**
 * c64 — a lawyer or firm admin records a court notice they verified themselves (e.g. downloaded from
 * the e-filing portal): { fromAddress, subject, bodyText, receivedAt, reference? }. Alerts like any notice.
 */
export async function POST(req: Request) {
  return alertsRoute(
    "POST /api/calendar-alerts/court-notices/manual",
    async ({ tx, tenantId, staff, ctx, now }) => {
      requireRole(staff, ["attorney", "firm_admin"], "enter court notices");
      const body = await readBody(req);
      const receivedAt = reqDateTime(body, "receivedAt");
      return ingestCourtEmail(
        tx,
        ctx,
        tenantId,
        {
          externalId: `manual:${staff.userId}:${optString(body, "reference", 200) ?? receivedAt.toISOString()}`,
          source: "manual",
          sourceAccount: null,
          fromAddress: reqString(body, "fromAddress", 500),
          fromDisplayName: null,
          subject: reqString(body, "subject", 2000),
          bodyText: reqString(body, "bodyText", 500_000),
          receivedAt,
          auth: {},
          attachments: [],
        },
        now,
        { enteredBy: staff }
      );
    },
    { permission: "calendar.write", status: 201 }
  );
}
