// End-to-end check of calendar-core against a REAL Postgres: a lawyer enters
// a limitation date, the daily scan flags it, the entering lawyer cannot
// verify it, a second lawyer verifies it blind, and the calendar event is
// confirmed. Then a staff calendar entry waits for a lawyer.
//
// Skipped when DATABASE_URL is unset and until the integration migration has
// created this engine's tables. Runs in ONE transaction that is rolled back.

import { afterEach, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { describeWithDb, loadDb } from "@/tenancy/testing";
import type { TenantTx } from "@/tenancy/withTenant";
import { firms, matters, parties, users } from "@/db/schema";
import { calendarEvents, flags } from "@/db/tables/foundation";
import { resetApprovalStateForTests } from "@/compliance/approvals";
import { loadStaff } from "./actors";
import { enterLimitationDate, runLimitationScan, verifyLimitationDate } from "./limitations/service";
import { confirmEvent, createEvent } from "./calendar/service";
import { CalendarCoreError } from "./errors";

class Rollback extends Error {}
afterEach(() => resetApprovalStateForTests());

describeWithDb("calendar-core against Postgres", () => {
  it("limitation date: entered, flagged daily, verified independently, calendared", async (ctx) => {
    const { rawDb } = await loadDb();
    const probe = (await rawDb.execute(sql`select to_regclass('public.limitation_dates') as t`)) as unknown as { t: string | null }[];
    if (!probe[0]?.t) ctx.skip();

    try {
      await rawDb.transaction(async (raw) => {
        const [firm] = await raw.insert(firms).values({ name: "Calendar Test Firm", slug: `cal-test-${Date.now()}` }).returning({ id: firms.id });
        const tenantId = firm!.id;
        await raw.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
        const tx = raw as unknown as TenantTx;
        const [a] = await tx.insert(users).values({ tenantId, email: "a@cal.example", displayName: "Ada Lawyer", role: "attorney" }).returning({ id: users.id });
        const [b] = await tx.insert(users).values({ tenantId, email: "b@cal.example", displayName: "Ben Lawyer", role: "attorney" }).returning({ id: users.id });
        const [s] = await tx.insert(users).values({ tenantId, email: "s@cal.example", displayName: "Sam Staff", role: "intake_staff" }).returning({ id: users.id });
        const [p] = await tx.insert(parties).values({ tenantId, fullName: "Cli Ent", normalizedName: "cli ent" }).returning({ id: parties.id });
        const [m] = await tx.insert(matters).values({ tenantId, primaryPartyId: p!.id, practiceArea: "family", stage: "retained", assignedUserId: a!.id }).returning({ id: matters.id });
        const lawyerA = await loadStaff(tx, tenantId, a!.id);
        const lawyerB = await loadStaff(tx, tenantId, b!.id);
        const staff = await loadStaff(tx, tenantId, s!.id);
        const now = new Date("2026-10-05T15:00:00Z");

        // Staff cannot enter a limitation date.
        await expect(enterLimitationDate(tx, { tenantId, staff, matterId: m!.id, claimDescription: "x", limitationDate: "2027-01-01", now })).rejects.toBeInstanceOf(CalendarCoreError);

        const { limitation } = await enterLimitationDate(tx, { tenantId, staff: lawyerA, matterId: m!.id, claimDescription: "Tort claim", limitationDate: "2026-10-30", now });
        expect(limitation.status).toBe("unverified");

        const scan = await runLimitationScan(tx, tenantId, now);
        expect(scan.unverifiedFlags).toBe(1);
        expect(scan.reminders).toBe(1); // 25 days left → the 30-day reminder only
        // Same day again: no duplicates.
        expect((await runLimitationScan(tx, tenantId, now)).unverifiedFlags).toBe(0);

        await expect(verifyLimitationDate(tx, { tenantId, staff: lawyerA, limitationId: limitation.id, verifierDate: "2026-10-30", now })).rejects.toThrow(/second person/);
        const ok = await verifyLimitationDate(tx, { tenantId, staff: lawyerB, limitationId: limitation.id, verifierDate: "2026-10-30", now });
        expect(ok.status).toBe("verified");
        const [ev] = await tx.select().from(calendarEvents).where(eq(calendarEvents.id, limitation.calendarEventId!));
        expect(ev!.status).toBe("confirmed");
        expect(ev!.confirmedByUserId).toBe(a!.id);
        const open = await tx.select().from(flags).where(and(eq(flags.tenantId, tenantId), eq(flags.type, "calendar-core.limitation_unverified"), sql`${flags.resolvedAt} is null`));
        expect(open).toHaveLength(0);

        // A staff entry waits for a lawyer; staff cannot confirm it.
        const hearing = await createEvent(tx, { tenantId, staff, draft: { matterId: m!.id, eventType: "hearing", title: "Temporary orders", startsAt: new Date("2026-10-20T15:00:00Z") }, confirmNow: true, now });
        expect(hearing.status).toBe("proposed");
        await expect(confirmEvent(tx, { tenantId, staff, eventId: hearing.id, now })).rejects.toThrow(/lawyer/);
        expect((await confirmEvent(tx, { tenantId, staff: lawyerB, eventId: hearing.id, now })).status).toBe("confirmed");

        throw new Rollback();
      });
    } catch (err) {
      if (!(err instanceof Rollback)) throw err;
    }
  });
});
