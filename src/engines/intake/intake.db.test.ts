// End-to-end check of the intake engine against a REAL Postgres: an inquiry
// arrives, disclosures, conflict minimum, a clear conflict result, case
// details, fit rules, and the matter-open gates.
//
// Skipped when DATABASE_URL is unset (src/tenancy/testing.ts) and until the
// integration migration has created the intake tables. Everything runs in ONE
// transaction that is rolled back at the end.

import { afterEach, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { describeWithDb, loadDb } from "@/tenancy/testing";
import type { TenantTx } from "@/tenancy/withTenant";
import { conflictCheckResults, firmConfigVersions, firms, users } from "@/db/schema";
import { resetApprovalStateForTests } from "@/compliance/approvals";
import { receiveInbound, acknowledgeDisclosures, recordConflictMinimum, recordCaseDetails } from "./channels/service";
import { evaluateFit } from "./acceptance/service";
import { ensureProspectiveMatter } from "./common/matters";
import { getOpenGatePanel, openMatter } from "./opening/service";
import { IntakeRuleError } from "./common/errors";

class Rollback extends Error {}

afterEach(() => resetApprovalStateForTests());

describeWithDb("intake engine against Postgres", () => {
  it("runs an inquiry from first message to the matter-open gate panel", async (ctx) => {
    const { rawDb } = await loadDb();
    const probe = (await rawDb.execute(sql`select to_regclass('public.intake_session_state') as t`)) as unknown as { t: string | null }[];
    if (!probe[0]?.t) ctx.skip(); // intake tables not migrated yet

    try {
      await rawDb.transaction(async (raw) => {
        const [firm] = await raw.insert(firms).values({ name: "Intake Test Firm", slug: `intake-test-${Date.now()}` }).returning({ id: firms.id });
        const tenantId = firm!.id;
        await raw.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
        const tx = raw as unknown as TenantTx;
        const [config] = await tx.insert(firmConfigVersions).values({ tenantId, version: 1, config: {} }).returning({ id: firmConfigVersions.id });
        const [lawyer] = await tx.insert(users).values({ tenantId, email: "lee@intake.example", displayName: "Lee Lawyer", role: "attorney" }).returning({ id: users.id });

        const now = new Date("2026-10-05T15:00:00Z"); // Monday 10:00 Chicago
        const first = await receiveInbound(tx, { tenantId, channel: "web_chat", from: { name: "Ana Lopez", email: "ana@example.com" }, text: "I need help with a divorce", now });
        expect(first.isNewSession).toBe(true);
        expect(first.replies.map((r) => r.kind)).toEqual(["channel_disclosure", "ai_acknowledgement"]);
        // Wording is pending review: the page shows the visible placeholder.
        expect(first.replies[0]!.text).toMatch(/PENDING ATTORNEY REVIEW/);
        expect(first.caseDetails.locked).toBe(true);

        const sessionId = first.intakeSessionId;
        await acknowledgeDisclosures(tx, { tenantId, intakeSessionId: sessionId, now });
        await recordConflictMinimum(tx, { tenantId, intakeSessionId: sessionId, fullName: "Ana Lopez", otherPartyNames: ["Bo Lopez"], now });
        await expect(recordCaseDetails(tx, { tenantId, intakeSessionId: sessionId, answers: { county: "Travis" } })).rejects.toBeInstanceOf(IntakeRuleError);

        // The conflict-check engine records a clear result (intake never decides it).
        await tx.insert(conflictCheckResults).values({ tenantId, intakeSessionId: sessionId, roleSought: "client", outcome: "clear", matchedSources: {}, firmConfigVersionId: config!.id });
        await recordCaseDetails(tx, { tenantId, intakeSessionId: sessionId, answers: { county: "Travis" } });

        const fit = await evaluateFit(tx, { tenantId, intakeSessionId: sessionId, now });
        // No classifier output yet: practice area unknown → a lawyer decides (never auto-declined).
        expect(fit.decision.outcome).toBe("borderline");

        const matter = await ensureProspectiveMatter(tx, tenantId, sessionId, now);
        const panel = await getOpenGatePanel(tx, tenantId, matter.id);
        expect(panel.canOpen).toBe(false);
        expect(panel.outstanding.map((o) => o.gate)).toEqual(expect.arrayContaining(["engagement_signed", "fee_arrangement"]));
        // The open action is itself gated until an attorney approves the gate list.
        await expect(openMatter(tx, { tenantId, matterId: matter.id, userId: lawyer!.id, now })).rejects.toMatchObject({ gateKey: "rules.intake.matter_open_gates" });

        throw new Rollback();
      });
    } catch (err) {
      if (!(err instanceof Rollback)) throw err;
    }
  });
});
