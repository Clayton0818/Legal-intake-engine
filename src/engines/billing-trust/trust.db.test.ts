// End-to-end check of the trust ledger against a REAL Postgres.
//
// Skipped when DATABASE_URL is unset (src/tenancy/testing.ts) and until the
// integration migration has created this engine's tables. If the tables exist
// but the MIGRATION NOTES triggers do not, the test FAILS: the ledger is not
// safe without them. Runs in ONE transaction that is rolled back.

import { afterEach, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { describeWithDb, loadDb } from "@/tenancy/testing";
import type { TenantTx } from "@/tenancy/withTenant";
import { firms, matters, parties, users } from "@/db/schema";
import { auditEvents } from "@/db/tables/foundation";
import {
  InMemoryApprovalSource,
  PendingApprovalError,
  resetApprovalStateForTests,
  setApprovals,
  setBlockedActionSink,
} from "@/compliance/approvals";
import { RULE_GATES } from "./gates";
import { createTrustAccount, openClientSubledger, placeHold, postTransaction } from "./ledgerService";
import { importStatement, prepareReconciliation, signOffReconciliation } from "./reconciliationService";
import { TrustRuleError } from "./types";

class Rollback extends Error {}

afterEach(() => resetApprovalStateForTests());

describeWithDb("billing-trust ledger against Postgres", () => {
  it("posts, refuses overdrafts in app AND database, reconciles, signs off and closes the month", async (ctx) => {
    const { rawDb } = await loadDb();
    const probe = (await rawDb.execute(
      sql`select to_regclass('public.trust_transactions') as t, to_regproc('public.billing_trust_entry_before_insert') as f`
    )) as unknown as { t: string | null; f: string | null }[];
    if (!probe[0]?.t) ctx.skip(); // tables not migrated yet
    expect(probe[0]?.f, "trust_ledger_entries trigger missing — see MIGRATION NOTES in src/db/tables/billing-trust.ts").toBeTruthy();

    setBlockedActionSink(() => {});
    setApprovals([]); // every gate pending

    try {
      await rawDb.transaction(async (raw) => {
        const [firm] = await raw.insert(firms).values({ name: "Trust Test Firm", slug: `bt-test-${Date.now()}` }).returning({ id: firms.id });
        const tenantId = firm!.id;
        await raw.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
        const tx = raw as unknown as TenantTx;

        const [owner, lawyer, staff] = await tx
          .insert(users)
          .values([
            { tenantId, email: "owner@bt.example", displayName: "Owner", role: "firm_admin" },
            { tenantId, email: "atty@bt.example", displayName: "Lawyer", role: "attorney" },
            { tenantId, email: "staff@bt.example", displayName: "Staff", role: "intake_staff" },
          ])
          .returning({ id: users.id });
        const [alice, bob] = await tx
          .insert(parties)
          .values([
            { tenantId, fullName: "Alice Client", normalizedName: "alice client" },
            { tenantId, fullName: "Bob Client", normalizedName: "bob client" },
          ])
          .returning({ id: parties.id });
        const [mA, mB] = await tx
          .insert(matters)
          .values([
            { tenantId, primaryPartyId: alice!.id, practiceArea: "family", stage: "retained" },
            { tenantId, primaryPartyId: bob!.id, practiceArea: "family", stage: "retained" },
          ])
          .returning({ id: matters.id });

        const as = (userId: string) => ({ tx, tenantId, actorUserId: userId, now: new Date("2026-10-02T15:00:00Z") });
        const account = await createTrustAccount(as(owner!.id), {
          name: "IOLTA",
          bankName: "Test Bank",
          accountNumberLast4: "1234",
          accountType: "iolta",
          openedOn: "2026-09-01",
        });
        const subA = await openClientSubledger(as(owner!.id), { trustAccountId: account.id, clientPartyId: alice!.id, matterId: mA!.id });
        const subB = await openClientSubledger(as(owner!.id), { trustAccountId: account.id, clientPartyId: bob!.id, matterId: mB!.id });
        await expect(openClientSubledger(as(owner!.id), { trustAccountId: account.id, clientPartyId: bob!.id, matterId: mA!.id })).rejects.toThrow(
          TrustRuleError
        );

        // Role check: intake staff may not post.
        const deposit = {
          kind: "deposit" as const,
          trustAccountId: account.id,
          effectiveDate: "2026-09-02",
          reason: "Retainer",
          fundsSource: "client" as const,
          amount: 500_000n,
          subledgerId: subA.id,
        };
        await expect(postTransaction(as(staff!.id), deposit)).rejects.toMatchObject({ code: "NOT_ALLOWED" });

        // Gate pending: blocked and audited.
        await expect(postTransaction(as(owner!.id), deposit)).rejects.toBeInstanceOf(PendingApprovalError);
        const blocked = await tx
          .select()
          .from(auditEvents)
          .where(and(eq(auditEvents.tenantId, tenantId), eq(auditEvents.action, "approval.blocked")));
        expect(blocked.length).toBeGreaterThan(0);

        // Approve the trust gate (attorney + CPA) for the rest of the test.
        const src = new InMemoryApprovalSource();
        src.approve({ gateKey: RULE_GATES.trustAccounting.key, reviewerKind: "attorney", approvedByName: "Test Attorney" });
        src.approve({ gateKey: RULE_GATES.trustAccounting.key, reviewerKind: "cpa", approvedByName: "Test CPA" });
        setApprovals(await src.load());

        const posted = await postTransaction(as(owner!.id), deposit);
        expect(posted.lines[0]!.balanceAfterCents).toBe(500_000n);
        await postTransaction(as(owner!.id), { ...deposit, subledgerId: subB.id, amount: 100_000n, effectiveDate: "2026-09-10" });

        // App refuses Alice's overdraft even though the pooled account holds enough.
        await expect(
          postTransaction(as(owner!.id), { kind: "refund", trustAccountId: account.id, effectiveDate: "2026-09-20", reason: "Refund", amount: 500_001n, subledgerId: subA.id })
        ).rejects.toMatchObject({ code: "INSUFFICIENT_FUNDS" });
        // The database refuses a direct balance edit, and edits of the journal.
        // (nested transactions are savepoints, so the failed statement does not abort the test transaction)
        await expect(raw.transaction(async (sp) => sp.execute(sql`update trust_subledgers set balance_cents = 0 where id = ${subA.id}`))).rejects.toThrow();
        await expect(
          raw.transaction(async (sp) => sp.execute(sql`update trust_transactions set reason = 'edited' where id = ${posted.transaction.id}`))
        ).rejects.toThrow();
        await expect(raw.transaction(async (sp) => sp.execute(sql`delete from trust_ledger_entries where transaction_id = ${posted.transaction.id}`))).rejects.toThrow();

        await postTransaction(as(owner!.id), {
          kind: "disbursement",
          trustAccountId: account.id,
          effectiveDate: "2026-09-20",
          reason: "Filing fee",
          counterparty: "District Clerk",
          reference: "1001",
          amount: 35_000n,
          subledgerId: subA.id,
        });
        await placeHold(as(owner!.id), { trustAccountId: account.id, subledgerId: subB.id, amount: 40_000n, reason: "Fee disputed" });
        await expect(
          postTransaction(as(owner!.id), { kind: "refund", trustAccountId: account.id, effectiveDate: "2026-09-21", reason: "Refund", amount: 60_001n, subledgerId: subB.id })
        ).rejects.toMatchObject({ code: "FUNDS_ON_HOLD" });

        await importStatement(as(owner!.id), {
          trustAccountId: account.id,
          period: "2026-09",
          openingBalance: 0n,
          closingBalance: 565_000n,
          source: "manual",
          lines: [
            { postedOn: "2026-09-03", amount: 500_000n, description: "Deposit", reference: null, kind: "deposit" },
            { postedOn: "2026-09-11", amount: 100_000n, description: "Deposit", reference: null, kind: "deposit" },
            { postedOn: "2026-09-25", amount: -35_000n, description: "Check 1001", reference: "1001", kind: "withdrawal" },
          ],
        });
        const { reconciliation, report } = await prepareReconciliation(as(owner!.id), { trustAccountId: account.id, period: "2026-09" });
        expect(report.differences).toEqual([]);
        expect(reconciliation.status).toBe("balanced");

        await expect(signOffReconciliation(as(owner!.id), { reconciliationId: reconciliation.id, role: "lawyer" })).rejects.toMatchObject({
          code: "NOT_ALLOWED",
        });
        await signOffReconciliation(as(owner!.id), { reconciliationId: reconciliation.id, role: "bookkeeper" });
        const { closed } = await signOffReconciliation(as(lawyer!.id), { reconciliationId: reconciliation.id, role: "lawyer" });
        expect(closed?.period).toBe("2026-09");

        // Nothing may now be dated in September.
        await expect(postTransaction(as(owner!.id), { ...deposit, effectiveDate: "2026-09-30" })).rejects.toMatchObject({ code: "PERIOD_CLOSED" });

        throw new Rollback();
      });
    } catch (err) {
      if (!(err instanceof Rollback)) throw err;
    }
  });
});
