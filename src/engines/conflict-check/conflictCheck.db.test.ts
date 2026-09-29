// End-to-end check of the Conflict-check engine against a REAL Postgres.
//
// Skipped when DATABASE_URL is unset (src/tenancy/testing.ts), and skipped
// until the integration migration has created this engine's tables. Runs in
// ONE transaction that is rolled back, so nothing is left behind.

import { afterEach, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { describeWithDb, loadDb } from "@/tenancy/testing";
import type { TenantTx } from "@/tenancy/withTenant";
import { firmConfigVersions, firms, intakeSessions, matterParties, matters, parties, users } from "@/db/schema";
import { InMemoryApprovalSource, resetApprovalStateForTests, setApprovals, setBlockedActionSink } from "@/compliance/approvals";
import { normalizeName } from "@/core";
import { grantConflictsRole, loadAccess } from "./access";
import { checkConflictGate, getGate } from "./checks";
import { approveWaiver, recordDecision, recordWaiverEvent } from "./decisionService";
import { CONFLICT_COPY_GATES } from "./gates";
import { listLog, openQueue } from "./logService";
import { checkInquiry } from "./sync";
import { ConflictError } from "./util";

class Rollback extends Error {}

afterEach(() => resetApprovalStateForTests());

describeWithDb("conflict-check engine against Postgres", () => {
  it("indexes an inquiry, finds a former client on the other side, and keeps the gate closed until every consent is signed", async (ctx) => {
    const { rawDb } = await loadDb();
    const probe = (await rawDb.execute(sql`select to_regclass('public.conflict_checks') as t`)) as unknown as { t: string | null }[];
    if (!probe[0]?.t) ctx.skip(); // this engine's tables are not migrated yet

    setBlockedActionSink(() => {});
    const approvals = new InMemoryApprovalSource();
    approvals.approve({ gateKey: CONFLICT_COPY_GATES.waiverTemplate.key, reviewerKind: "attorney", approvedByName: "Test Attorney" });
    setApprovals(await approvals.load());

    try {
      await rawDb.transaction(async (raw) => {
        const [firm] = await raw.insert(firms).values({ name: "Conflicts Test Firm", slug: `cc-test-${Date.now()}` }).returning({ id: firms.id });
        const tenantId = firm!.id;
        await raw.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
        const tx = raw as unknown as TenantTx;

        const [admin, atty, staff] = await tx
          .insert(users)
          .values([
            { tenantId, email: "owner@cc.example", displayName: "Owner", role: "firm_admin" },
            { tenantId, email: "atty@cc.example", displayName: "Conflicts Attorney", role: "attorney" },
            { tenantId, email: "staff@cc.example", displayName: "Intake Staff", role: "intake_staff" },
          ])
          .returning({ id: users.id });
        const adminAccess = await loadAccess(tx, tenantId, admin!.id);
        await grantConflictsRole(tx, { tenantId, userId: atty!.id, role: "conflicts_attorney", designated: true, by: adminAccess });
        const attyAccess = await loadAccess(tx, tenantId, atty!.id);
        const staffAccess = await loadAccess(tx, tenantId, staff!.id);

        // History: Jane Doe (née Miller) was our client; the file is closed.
        const [jane] = await tx
          .insert(parties)
          .values({ tenantId, fullName: "Jane Doe", normalizedName: "jane doe", aliases: ["Jane Miller"], normalizedAliases: [normalizeName("Jane Miller")] })
          .returning({ id: parties.id });
        const [oldMatter] = await tx
          .insert(matters)
          .values({ tenantId, primaryPartyId: jane!.id, stage: "closed", closedAt: new Date("2024-01-01T00:00:00Z") })
          .returning({ id: matters.id });
        await tx.insert(matterParties).values({ tenantId, matterId: oldMatter!.id, partyId: jane!.id, role: "client" });
        const [other] = await tx.insert(parties).values({ tenantId, fullName: "Carl Client", normalizedName: "carl client" }).returning({ id: parties.id });

        // A new inquiry names Jane (by her maiden name) as the other side.
        const [config] = await tx.insert(firmConfigVersions).values({ tenantId, version: 1, config: {} }).returning({ id: firmConfigVersions.id });
        const [session] = await tx.insert(intakeSessions).values({ tenantId, firmConfigVersionId: config!.id }).returning({ id: intakeSessions.id });
        const { check } = await checkInquiry(tx, {
          tenantId,
          intakeSessionId: session!.id,
          parties: [
            { role: "prospective_client", name: "Pat Prospect" },
            { role: "opposing_party", name: "Jane Miller", relationship: "spouse" },
          ],
          by: { type: "user", userId: staff!.id },
        });
        expect(check.outcome).toBe("possible");
        expect(check.assignedUserId).toBe(atty!.id);
        expect((check.hits as Array<{ partyId: string }>).some((h) => h.partyId === jane!.id)).toBe(true);

        // The gate is closed; a downstream action is refused and logged.
        const subject = { type: "intake_session" as const, id: session!.id };
        expect((await getGate(tx, tenantId, subject)).closedReason).toBe("pending_review");
        expect((await checkConflictGate(tx, { tenantId, subject, action: "scheduling" })).allowed).toBe(false);

        // Intake staff cannot decide; the queue shows the check to the conflicts attorney.
        await expect(recordDecision(tx, { tenantId, checkId: check.id, access: staffAccess, decision: { decision: "cleared", reasonCode: "not_adverse" } })).rejects.toThrow(ConflictError);
        expect((await openQueue(tx, { tenantId, access: attyAccess })).map((q) => q.checkId)).toContain(check.id);

        // Proceed with written consent from two clients.
        const decision = await recordDecision(tx, {
          tenantId,
          checkId: check.id,
          access: attyAccess,
          decision: { decision: "proceed_with_consent", reasonCode: "consent_permitted", consentPartyIds: [jane!.id, other!.id] },
        });
        expect(decision.decidedByUserId).toBe(atty!.id);
        expect((await getGate(tx, tenantId, subject)).closedReason).toBe("awaiting_consent");

        // A decision is never edited: a second plain decision is refused.
        await expect(recordDecision(tx, { tenantId, checkId: check.id, access: attyAccess, decision: { decision: "cleared", reasonCode: "not_adverse" } })).rejects.toThrow(ConflictError);

        // Both consents signed on paper and countersigned: only then does the gate open.
        const waivers = (await tx.execute(sql`select id from conflict_waivers where check_id = ${check.id} order by created_at`)) as unknown as { id: string }[];
        expect(waivers).toHaveLength(2);
        const docIds: string[] = [];
        for (const [i, w] of waivers.entries()) {
          const [doc] = (await tx.execute(
            sql`insert into documents (tenant_id, matter_id, document_type, storage_key) values (${tenantId}, ${oldMatter!.id}, 'conflict_waiver', ${`test/${i}`}) returning id`
          )) as unknown as { id: string }[];
          docIds.push(doc!.id);
          await approveWaiver(tx, { tenantId, waiverId: w.id, access: attyAccess });
        }
        await recordWaiverEvent(tx, { tenantId, waiverId: waivers[0]!.id, event: "signed", by: attyAccess, signedOutsidePlatform: true, documentId: docIds[0] });
        await recordWaiverEvent(tx, { tenantId, waiverId: waivers[0]!.id, event: "countersigned", by: attyAccess });
        expect((await getGate(tx, tenantId, subject)).state).toBe("closed");
        await recordWaiverEvent(tx, { tenantId, waiverId: waivers[1]!.id, event: "signed", by: attyAccess, signedOutsidePlatform: true, documentId: docIds[1] });
        await recordWaiverEvent(tx, { tenantId, waiverId: waivers[1]!.id, event: "countersigned", by: attyAccess });
        expect((await getGate(tx, tenantId, subject)).state).toBe("open");

        // The log has the record; the firm admin (no conflicts role) sees it without names.
        const adminLog = await listLog(tx, { tenantId, access: adminAccess });
        expect(JSON.stringify(adminLog)).not.toContain("Jane");
        const attyLog = await listLog(tx, { tenantId, access: attyAccess });
        expect(attyLog[0]?.waivers.every((w) => w.signedAt !== null)).toBe(true);

        throw new Rollback();
      });
    } catch (err) {
      if (!(err instanceof Rollback)) throw err;
    }
  });
});
