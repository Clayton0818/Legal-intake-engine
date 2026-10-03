import { alertsRoute } from "@/app/api/calendar-alerts/_lib/route";
import { requireApproval } from "@/compliance/approvals";
import { ingestCourtEmail } from "@/engines/calendar-alerts/courtNotice/service";
import { gateForSource } from "@/engines/calendar-alerts/courtNotice/source";
import { oneOf, parseInboundCourtEmail, readBody } from "@/engines/calendar-alerts/http";

export const dynamic = "force-dynamic";

/**
 * c64 — push endpoint for a mailbox / e-filing ADAPTER (integration account). Refused with 423 until the
 * source's shared vendor gate is approved (vendor.mailbox_access / vendor.efiling): no vendor is wired yet.
 * Body: { source: 'mailbox'|'efiling', externalId, fromAddress, fromDisplayName?, subject, bodyText,
 * receivedAt, auth: { spf, dkim, dkimDomain, dmarc }, attachments?: [...] }.
 */
export async function POST(req: Request) {
  return alertsRoute(
    "POST /api/calendar-alerts/court-notices/inbound",
    async ({ tx, tenantId, ctx, now }) => {
      const body = await readBody(req);
      const source = oneOf(body, "source", ["mailbox", "efiling"] as const);
      requireApproval(gateForSource(source)!, { action: "calendar-alerts.court_mail_push", tenantId });
      const r = await ingestCourtEmail(tx, ctx, tenantId, { ...parseInboundCourtEmail(body), source }, now);
      // Never echo the content back; ignored mail is not stored at all.
      return { stored: r.stored, classification: r.classification, duplicate: r.duplicate, noticeId: r.notice?.id ?? null };
    },
    { permission: "integration.sync" }
  );
}
