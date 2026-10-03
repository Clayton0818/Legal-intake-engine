// End-to-end check of calendar-alerts against a REAL Postgres:
//  - c44: a Friday 17:00 question about a confirmed Monday 09:00 filing alerts
//    the lawyer at once; the held acknowledgement is never shown; a human
//    reply stops the clock and clears its flags;
//  - c45: an overdue task is flagged once, however many ticks run;
//  - c64: a trusted, authenticated court email is matched by cause number and
//    alerts the lawyer; a look-alike is stored without its body.
//
// Skipped when DATABASE_URL is unset and until the integration migration has
// created this engine's tables. Runs in ONE transaction that is rolled back.

import { afterEach, expect, it } from "vitest";
import { and, eq, isNull, sql } from "drizzle-orm";
import { describeWithDb, loadDb } from "@/tenancy/testing";
import type { TenantTx } from "@/tenancy/withTenant";
import { firms, matters, parties, users } from "@/db/schema";
import { calendarEvents, flags } from "@/db/tables/foundation";
import { clientMessages, courtCaseRefs } from "@/db/tables/calendar-alerts";
import { resetApprovalStateForTests } from "@/compliance/approvals";
import { updateEngineSettings } from "@/core/firmSettings";
import { createTask, getTask } from "@/core/tasks";
import { loadContext } from "./common";
import { ENGINE } from "./settings";
import { FLAG_TYPES } from "./kinds";
import { recordInboundMessage, recordOutboundMessage } from "./replyClock/service";
import { runOverdueScan } from "./overdue/service";
import { ingestCourtEmail } from "./courtNotice/service";

class Rollback extends Error {}
afterEach(() => resetApprovalStateForTests());

describeWithDb("calendar-alerts against Postgres", () => {
  it("reply clock safety net, overdue scan, court email", async (ctx) => {
    const { rawDb } = await loadDb();
    const probe = (await rawDb.execute(sql`select to_regclass('public.reply_clocks') as t`)) as unknown as { t: string | null }[];
    if (!probe[0]?.t) ctx.skip();

    try {
      await rawDb.transaction(async (raw) => {
        const [firm] = await raw.insert(firms).values({ name: "Alerts Test Firm", slug: `alerts-test-${Date.now()}` }).returning({ id: firms.id });
        const tenantId = firm!.id;
        await raw.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
        const tx = raw as unknown as TenantTx;
        const [lawyer] = await tx.insert(users).values({ tenantId, email: "l@alerts.example", displayName: "Lee Lawyer", role: "attorney" }).returning({ id: users.id });
        const [admin] = await tx.insert(users).values({ tenantId, email: "a@alerts.example", displayName: "Ann Admin", role: "firm_admin" }).returning({ id: users.id });
        const [client] = await tx.insert(parties).values({ tenantId, fullName: "Maria Lopez", normalizedName: "maria lopez" }).returning({ id: parties.id });
        const [m] = await tx.insert(matters).values({ tenantId, primaryPartyId: client!.id, practiceArea: "family", stage: "retained", assignedUserId: lawyer!.id }).returning({ id: matters.id });
        const friday5pm = new Date("2026-10-02T22:00:00Z"); // Fri 17:00 CDT
        await tx.insert(calendarEvents).values({
          tenantId,
          matterId: m!.id,
          eventType: "filing_deadline",
          title: "Response due",
          startsAt: new Date("2026-10-05T14:00:00Z"), // Mon 09:00 CDT
          isDeadline: true,
          status: "confirmed",
          confirmedByUserId: lawyer!.id,
          confirmedAt: friday5pm,
        });

        // --- c44 ---
        let engine = await loadContext(tx, tenantId);
        const inbound = await recordInboundMessage(tx, engine, { tenantId, matterId: m!.id, partyId: client!.id, channel: "portal", body: "When do I have to file the response?", occurredAt: friday5pm });
        expect(inbound.clockStarted).toBe(true);
        expect(inbound.clock!.tier).toBe("deadline");
        expect(inbound.immediateFlagId).not.toBeNull();
        expect(inbound.ack!.delivered).toBe(false); // wording not approved → held
        const [ack] = await tx.select().from(clientMessages).where(eq(clientMessages.id, inbound.ack!.messageId));
        expect(ack!.deliveryState).toBe("held");

        // A follow-up joins the same clock.
        const again = await recordInboundMessage(tx, engine, { tenantId, matterId: m!.id, partyId: client!.id, channel: "portal", body: "Hello?", occurredAt: new Date(friday5pm.getTime() + 60_000) });
        expect(again.clockStarted).toBe(false);
        expect(again.clock!.id).toBe(inbound.clock!.id);

        // A human reply stops the clock; its task completes and its flags clear.
        const out = await recordOutboundMessage(tx, engine, { tenantId, matterId: m!.id, partyId: client!.id, channel: "portal", body: "I will call you now.", occurredAt: new Date(friday5pm.getTime() + 600_000), sender: { type: "user", userId: lawyer!.id } });
        expect(out.clockStopped!.status).toBe("replied");
        expect((await getTask(tx, tenantId, inbound.clock!.taskId!))!.status).toBe("done");
        const openClockFlags = await tx.select().from(flags).where(and(eq(flags.tenantId, tenantId), eq(flags.taskId, inbound.clock!.taskId!), isNull(flags.resolvedAt)));
        expect(openClockFlags).toHaveLength(0);

        // --- c45 ---
        const task = await createTask(tx, { tenantId, kind: "test.prepare_exhibits", title: "Prepare exhibits", owner: { type: "user", userId: lawyer!.id }, due: { at: new Date("2026-10-06T20:00:00Z") }, matterId: m!.id });
        const tick = new Date("2026-10-06T21:00:00Z");
        const first = await runOverdueScan(tx, engine, tenantId, tick);
        expect(first.flagged).toBeGreaterThanOrEqual(1);
        const second = await runOverdueScan(tx, engine, tenantId, tick);
        expect(second.flagged).toBe(0);
        const overdue = await tx.select().from(flags).where(and(eq(flags.tenantId, tenantId), eq(flags.taskId, task.id), isNull(flags.resolvedAt)));
        expect(overdue).toHaveLength(1);
        expect(overdue[0]!.audience).toBe("internal");

        // --- c64 ---
        await updateEngineSettings(tx, tenantId, ENGINE, { trustedCourtSenders: [{ domain: "efiletexas.gov", label: "eFileTexas", kind: "efiling" }] }, { type: "user", userId: admin!.id });
        engine = await loadContext(tx, tenantId);
        await tx.insert(courtCaseRefs).values({ tenantId, matterId: m!.id, causeNumber: "2026-CI-01234" });
        const notice = await ingestCourtEmail(
          tx,
          engine,
          tenantId,
          {
            externalId: "efile-1",
            source: "efiling",
            sourceAccount: null,
            fromAddress: "no-reply@notices.efiletexas.gov",
            fromDisplayName: "eFileTexas",
            subject: "Notification of Service — Cause No. 2026-CI-01234",
            bodyText: "A hearing is set for October 14, 2026 at 9:30 a.m. Respond within 20 days.",
            receivedAt: new Date("2026-10-03T03:00:00Z"),
            auth: { spf: "pass", dkim: "pass", dkimDomain: "efiletexas.gov", dmarc: "pass" },
            attachments: [{ filename: "order.pdf", mimeType: "application/pdf", sizeBytes: 1000, sha256: null }],
          },
          new Date("2026-10-03T03:00:00Z")
        );
        expect(notice.classification).toBe("court_verified");
        expect(notice.notice!.matterId).toBe(m!.id);
        expect(notice.notice!.alertFlagId).not.toBeNull();
        const [alert] = await tx.select().from(flags).where(eq(flags.id, notice.notice!.alertFlagId!));
        expect(alert).toMatchObject({ type: FLAG_TYPES.courtNotice, severity: "critical", audience: "internal" });
        expect(alert!.recipientPartyIds).toEqual([]);

        const fake = await ingestCourtEmail(
          tx,
          engine,
          tenantId,
          { externalId: "x-1", source: "mailbox", sourceAccount: null, fromAddress: "clerk@efi1etexas.gov", fromDisplayName: "District Clerk", subject: "Notice of hearing", bodyText: "Click here", receivedAt: new Date("2026-10-03T03:00:00Z"), auth: {}, attachments: [] },
          new Date("2026-10-03T03:00:00Z")
        );
        expect(fake.classification).toBe("possible_phishing");
        expect(fake.notice!.bodyText).toBeNull();

        throw new Rollback();
      });
    } catch (err) {
      if (!(err instanceof Rollback)) throw err;
    }
  });
});
