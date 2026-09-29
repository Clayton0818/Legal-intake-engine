// End-to-end: c96 import → c57 near-miss hit on imported history → c3 role
// evaluation → c58 reopen and periodic re-check, against a REAL Postgres.
//
// Skipped when DATABASE_URL is unset (src/tenancy/testing.ts) and until this
// engine's tables are migrated. Runs in ONE transaction that is rolled back.

import { afterEach, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { describeWithDb, loadDb } from "@/tenancy/testing";
import type { TenantTx } from "@/tenancy/withTenant";
import { firmConfigVersions, firms, intakeSessions, matterParties, matters, parties, scheduledTasks, users } from "@/db/schema";
import { conflictChecks, conflictSyncState } from "@/db/tables/conflict-check";
import { InMemoryApprovalSource, resetApprovalStateForTests, setApprovals, setBlockedActionSink } from "@/compliance/approvals";
import { RULE_GATES } from "@/compliance/gates";
import { grantConflictsRole, loadAccess } from "./access";
import { commitImport, validateImport } from "./importService";
import { confirmHistoryImport } from "./settingsService";
import { checkInquiry, syncMatterParties } from "./sync";
import { detectReopenedMatters, runPeriodicRecheck } from "./triggers";
import type { ConflictHit } from "./types";
import { ConflictError } from "./util";
import type { RoleEvaluation } from "./coreCheck";

class Rollback extends Error {}

afterEach(() => resetApprovalStateForTests());

describeWithDb("conflict-check import and automatic triggers against Postgres", () => {
  it("imports history, catches a near-miss against it, and re-checks on reopen and periodically", async (ctx) => {
    const { rawDb } = await loadDb();
    const probe = (await rawDb.execute(sql`select to_regclass('public.conflict_import_batches') as t`)) as unknown as { t: string | null }[];
    if (!probe[0]?.t) ctx.skip();
    setBlockedActionSink(() => {});

    try {
      await rawDb.transaction(async (raw) => {
        const [firm] = await raw.insert(firms).values({ name: "Import Test Firm", slug: `cc-imp-${Date.now()}` }).returning({ id: firms.id });
        const tenantId = firm!.id;
        await raw.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
        const tx = raw as unknown as TenantTx;
        const now = new Date("2026-10-05T15:00:00Z");

        const [admin, atty] = await tx
          .insert(users)
          .values([
            { tenantId, email: "owner@imp.example", displayName: "Owner", role: "firm_admin" },
            { tenantId, email: "atty@imp.example", displayName: "Conflicts Attorney", role: "attorney" },
          ])
          .returning({ id: users.id });
        await grantConflictsRole(tx, { tenantId, userId: atty!.id, role: "conflicts_attorney", designated: true, by: await loadAccess(tx, tenantId, admin!.id) });
        const attyAccess = await loadAccess(tx, tenantId, atty!.id);

        // c96: confirming before any import (and without an attestation) is refused.
        await expect(confirmHistoryImport(tx, { tenantId, access: attyAccess })).rejects.toThrow(ConflictError);

        const csv = [
          "Contact Type,Full Name,DOB,Matter Number,Status,Maiden Name",
          "client,Roberto Gonzalez,1979-03-02,OLD-1,closed,",
          "declined_consultation,Maria Garcia Lopez,,OLD-2,,",
          "client,,1980-01-01,OLD-3,closed,",
        ].join("\n");
        const preview = await validateImport(tx, { tenantId, filename: "history.csv", csv, access: attyAccess, now });
        expect(preview.summary).toMatchObject({ totalRows: 3, validRows: 2, errorRows: 1 });
        expect(preview.problems.find((p) => p.lineNumber === 4)?.errors[0]).toContain("Name");
        const report = await commitImport(tx, { tenantId, batchId: preview.batch.id, access: attyAccess, now });
        expect(report.batch).toMatchObject({ status: "committed", partiesCreated: 2, mattersCreated: 2 });
        await expect(commitImport(tx, { tenantId, batchId: preview.batch.id, access: attyAccess })).rejects.toThrow(ConflictError);
        await expect(validateImport(tx, { tenantId, filename: "again.csv", csv, access: attyAccess })).rejects.toThrow(ConflictError);
        await confirmHistoryImport(tx, { tenantId, access: attyAccess, now });

        // c57 + c3: "Beto Gonzales" (nickname + spelling) on the other side hits the imported former client.
        const approvals = new InMemoryApprovalSource();
        approvals.approve({ gateKey: RULE_GATES.conflictRules.key, reviewerKind: "attorney", approvedByName: "Test Attorney" });
        setApprovals(await approvals.load());
        const [config] = await tx.insert(firmConfigVersions).values({ tenantId, version: 1, config: {} }).returning({ id: firmConfigVersions.id });
        const [session] = await tx.insert(intakeSessions).values({ tenantId, firmConfigVersionId: config!.id }).returning({ id: intakeSessions.id });
        const res = await checkInquiry(tx, {
          tenantId,
          intakeSessionId: session!.id,
          parties: [
            { role: "prospective_client", name: "Pat Newcaller" },
            { role: "opposing_party", name: "Beto Gonzales", dateOfBirth: "1979-03-02" },
          ],
          now,
        });
        const hits = res.check.hits as ConflictHit[];
        const imported = hits.find((h) => h.displayName === "Roberto Gonzalez");
        expect(imported?.involvements.some((i) => i.imported && i.externalRef === "OLD-1")).toBe(true);
        expect(imported?.evidence?.length).toBeGreaterThan(0);
        const evaluation = res.check.roleEvaluation as unknown as RoleEvaluation;
        expect(evaluation.applied).toBe(true);
        expect(evaluation.findings.map((f) => f.condition)).toContain("prior_representation_of_opposing_party");
        // A near-miss is never certain enough for 'definite': it goes to the attorney as 'possible'.
        expect(evaluation.barred).toBe(false);
        expect(res.check.outcome).toBe("possible");
        expect(res.directive).toMatchObject({ next: "escalate_conflict", scheduling: "callback_only" });

        // The same person named exactly (with date of birth) is 'definite' once rules.conflicts is approved.
        const [sessionB] = await tx.insert(intakeSessions).values({ tenantId, firmConfigVersionId: config!.id }).returning({ id: intakeSessions.id });
        const exact = await checkInquiry(tx, {
          tenantId,
          intakeSessionId: sessionB!.id,
          parties: [
            { role: "prospective_client", name: "Pat Othercaller" },
            { role: "opposing_party", name: "Roberto Gonzalez", dateOfBirth: "1979-03-02" },
          ],
          now,
        });
        expect(exact.check.outcome).toBe("definite");
        expect(exact.directive).toMatchObject({ next: "declined_conflict", scheduling: "blocked" });

        // c58 (3): a closed matter that is reopened is checked again.
        const [client] = await tx.insert(parties).values({ tenantId, fullName: "Carla Client", normalizedName: "carla client" }).returning({ id: parties.id });
        const [m] = await tx
          .insert(matters)
          .values({ tenantId, primaryPartyId: client!.id, stage: "closed", closedAt: new Date("2025-01-01T00:00:00Z") })
          .returning({ id: matters.id });
        await tx.insert(matterParties).values({ tenantId, matterId: m!.id, partyId: client!.id, role: "client" });
        await syncMatterParties(tx, tenantId, now); // baselines the sync state
        expect((await detectReopenedMatters(tx, tenantId, now)).reopened).toBe(0);
        await tx.update(matters).set({ stage: "retained", closedAt: null }).where(eq(matters.id, m!.id));
        expect(await detectReopenedMatters(tx, tenantId, now)).toMatchObject({ reopened: 1, checks: 1 });
        const reopenedChecks = await tx.select().from(conflictChecks).where(and(eq(conflictChecks.matterId, m!.id), eq(conflictChecks.trigger, "reopened")));
        expect(reopenedChecks).toHaveLength(1);

        // c58 (5): the first periodic run baselines; a later look-alike party triggers a re-check.
        expect((await runPeriodicRecheck(tx, tenantId, now)).baselined).toBe(true);
        // Rows in this transaction carry the real transaction time; move the cursor before it.
        await tx.update(conflictSyncState).set({ recheckCursor: new Date(Date.now() - 3_600_000) }).where(eq(conflictSyncState.tenantId, tenantId));
        const later = new Date(now.getTime() + 3_600_000);
        const [session2] = await tx.insert(intakeSessions).values({ tenantId, firmConfigVersionId: config!.id }).returning({ id: intakeSessions.id });
        await checkInquiry(tx, { tenantId, intakeSessionId: session2!.id, parties: [{ role: "prospective_client", name: "Carla Klient" }], now: later });
        const summary = await runPeriodicRecheck(tx, tenantId, later);
        expect(summary.newParties).toBeGreaterThan(0);
        expect(summary.mattersRechecked).toBe(1);
        const pending = await tx
          .select()
          .from(scheduledTasks)
          .where(and(eq(scheduledTasks.tenantId, tenantId), eq(scheduledTasks.taskType, "conflict-check.periodic_recheck")));
        expect(pending.length).toBeGreaterThanOrEqual(2);

        throw new Rollback();
      });
    } catch (err) {
      if (!(err instanceof Rollback)) throw err;
    }
  });
});
