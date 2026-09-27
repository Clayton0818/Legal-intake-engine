// End-to-end check of the shared core against a REAL Postgres: tasks, flags,
// the internal/client boundary, the notification outbox and the audit trail.
//
// Skipped when DATABASE_URL is unset (see src/tenancy/testing.ts), and also
// skipped until the integration migration has created the foundation tables.
// Everything runs inside ONE transaction that is rolled back at the end, so
// nothing is left behind (audit_events is append-only for app_runtime, so
// deleting afterwards would not be possible).

import { it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { describeWithDb, loadDb } from "@/tenancy/testing";
import type { TenantTx } from "@/tenancy/withTenant";
import { firms, matters, parties, users } from "@/db/schema";
import { isPlaceholder } from "@/compliance/approvals";
import { completeTask, createTask, listClientTasks } from "./tasks";
import { listClientFlags, listInternalFlags, raiseFlag } from "./flags";
import { drainNotificationOutbox, StubProvider } from "./notify";
import { listAuditTrail } from "./audit";
import { toBusinessCalendar, DEFAULT_FIRM_SETTINGS } from "./firmSettings";

class Rollback extends Error {}

describeWithDb("case-management foundation against Postgres", () => {
  it("tasks, flags, outbox and audit round-trip inside one rolled-back transaction", async (ctx) => {
    const { rawDb } = await loadDb();
    const probe = (await rawDb.execute(sql`select to_regclass('public.notification_outbox') as t`)) as unknown as {
      t: string | null;
    }[];
    if (!probe[0]?.t) ctx.skip(); // foundation tables not migrated yet

    try {
      await rawDb.transaction(async (raw) => {
        const [firm] = await raw
          .insert(firms)
          .values({ name: "Foundation Test Firm", slug: `foundation-test-${Date.now()}` })
          .returning({ id: firms.id });
        const tenantId = firm!.id;
        await raw.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
        const tx = raw as unknown as TenantTx;

        const [lawyer] = await tx
          .insert(users)
          .values({ tenantId, email: "lawyer@foundation.example", displayName: "Lee Lawyer", role: "attorney" })
          .returning({ id: users.id });
        const [client] = await tx
          .insert(parties)
          .values({
            tenantId,
            fullName: "Ana Client",
            normalizedName: "ana client",
            email: "shared@home.example",
            dvSensitive: true,
            safeContact: { safeEmail: "safe@ana.example" },
          })
          .returning({ id: parties.id });
        const [matter] = await tx.insert(matters).values({ tenantId, primaryPartyId: client!.id }).returning({ id: matters.id });
        const calendar = toBusinessCalendar(DEFAULT_FIRM_SETTINGS);

        // An internal task, overdue, flagged internally.
        const task = await createTask(
          tx,
          {
            tenantId,
            kind: "core.test_reply",
            title: "Reply to Ana",
            owner: { type: "user", userId: lawyer!.id },
            due: { hours: 1, clock: "real", from: new Date(Date.now() - 3 * 3_600_000) },
            matterId: matter!.id,
          },
          { calendar }
        );
        const first = await raiseFlag(tx, {
          tenantId,
          type: "task.overdue",
          severity: "warning",
          audience: "internal",
          title: "Reply to Ana is overdue",
          taskId: task.id,
          matterId: matter!.id,
          recipients: { userIds: [lawyer!.id] },
          dedupeKey: `task.overdue:${task.id}`,
        });
        expect(first.created).toBe(true);
        const again = await raiseFlag(tx, {
          tenantId,
          type: "task.overdue",
          severity: "warning",
          audience: "internal",
          title: "Reply to Ana is overdue",
          taskId: task.id,
          recipients: { userIds: [lawyer!.id] },
          dedupeKey: `task.overdue:${task.id}`,
        });
        expect(again).toEqual({ flag: first.flag, created: false });

        // A client-side flag and a client task.
        const both = await raiseFlag(tx, {
          tenantId,
          type: "document.missing",
          severity: "info",
          audience: "both",
          title: "Ana has not uploaded her pay stubs",
          matterId: matter!.id,
          recipients: { userIds: [lawyer!.id], partyIds: [client!.id] },
        });
        await createTask(
          tx,
          {
            tenantId,
            kind: "document.upload_request",
            title: "Upload your last two pay stubs",
            owner: { type: "client", partyId: client!.id },
            visibility: "client",
            due: { hours: 48, clock: "business" },
            matterId: matter!.id,
          },
          { calendar }
        );

        // The client sees only the client-side flag, as a placeholder until the wording is approved.
        const clientFlags = await listClientFlags(tx, tenantId, client!.id);
        expect(clientFlags.map((f) => f.id)).toEqual([both.flag.id]);
        expect(isPlaceholder(clientFlags[0]!.message)).toBe(true);
        expect(JSON.stringify(clientFlags)).not.toContain("pay stubs");
        const clientTasks = await listClientTasks(tx, tenantId, client!.id);
        expect(clientTasks.map((t) => t.kind)).toEqual(["document.upload_request"]);

        // Nothing is sent while the vendor gate is pending: every email row is HELD.
        const drained = await drainNotificationOutbox(tx, tenantId, { providers: { email: new StubProvider(), sms: new StubProvider() } });
        expect(drained.sent).toBe(0);
        expect(drained.held).toBeGreaterThan(0);

        // Completing the task resolves its flag, with a logged reason.
        await completeTask(tx, { tenantId, taskId: task.id, by: { type: "user", userId: lawyer!.id } });
        const open = await listInternalFlags(tx, tenantId);
        expect(open.map((f) => f.id)).not.toContain(first.flag.id);
        const trail = await listAuditTrail(tx, tenantId, { entityType: "task", entityId: task.id });
        expect(trail.map((a) => a.action)).toEqual(expect.arrayContaining(["task.created", "task.completed"]));

        throw new Rollback();
      });
    } catch (err) {
      if (!(err instanceof Rollback)) throw err;
    }
  });
});
