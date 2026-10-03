// c99 + c102 services against a REAL Postgres, inside ONE rolled-back
// transaction (access_change_log and audit_events are append-only).
// Skipped without DATABASE_URL, and until the integration migration has
// created this engine's tables.

import { expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { describeWithDb, loadDb } from "@/tenancy/testing";
import type { TenantTx } from "@/tenancy/withTenant";
import { firms, matters, parties, users } from "@/db/schema";
import { getFirmSettings } from "@/core/firmSettings";
import { can } from "./permissions/policy";
import {
  addTeamMember,
  getPermissionMatrix,
  grantRole,
  listAccessChanges,
  loadMatterRef,
  loadStaffContext,
  revokeRole,
  setMatterRestricted,
  setPermissionOverride,
} from "./permissions/service";
import { acceptPackUpdate, ensureDefaultPackAdoptions, getPracticeAreaOverview, setEnabledPracticeAreas } from "./practiceAreas/service";
import { activePack } from "./practiceAreas/published";

class Rollback extends Error {}

describeWithDb("all-engines services against Postgres", () => {
  it("permissions, roles, matter access and practice areas round-trip", async (ctx) => {
    const { rawDb } = await loadDb();
    const probe = (await rawDb.execute(sql`select to_regclass('public.access_change_log') as t`)) as unknown as { t: string | null }[];
    if (!probe[0]?.t) ctx.skip();

    try {
      await rawDb.transaction(async (raw) => {
        const [firm] = await raw.insert(firms).values({ name: "Perms Test Firm", slug: `perms-test-${Date.now()}` }).returning({ id: firms.id });
        const tenantId = firm!.id;
        await raw.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
        const tx = raw as unknown as TenantTx;
        const [admin, lawyer, para] = await tx
          .insert(users)
          .values([
            { tenantId, email: "a@x.example", displayName: "Ada Admin", role: "firm_admin" },
            { tenantId, email: "l@x.example", displayName: "Lee Lawyer", role: "attorney" },
            { tenantId, email: "p@x.example", displayName: "Pat Para", role: "intake_staff" },
          ])
          .returning({ id: users.id });

        // Bootstrap: the admin names the first owner.
        let adminCtx = await loadStaffContext(tx, tenantId, { userId: admin!.id, role: "firm_admin", capabilities: [] });
        await grantRole(tx, { tenantId, by: adminCtx, userId: lawyer!.id, role: "owner", reason: "Founding partner" });
        const ownerCtx = await loadStaffContext(tx, tenantId, { userId: lawyer!.id, role: "attorney", capabilities: [] });
        expect(ownerCtx.roles).toEqual(["owner", "lawyer"]);
        await expect(grantRole(tx, { tenantId, by: adminCtx, userId: admin!.id, role: "owner", reason: "x" })).rejects.toThrow();

        await grantRole(tx, { tenantId, by: ownerCtx, userId: para!.id, role: "paralegal", reason: "Promoted" });
        await expect(revokeRole(tx, { tenantId, by: ownerCtx, userId: lawyer!.id, role: "owner", reason: "x" })).rejects.toThrow(/cannot be removed/);

        // Matrix override, logged.
        const res = await setPermissionOverride(tx, { tenantId, by: ownerCtx, role: "paralegal", right: "matters.access_all", effect: "deny", reason: "Team-only paralegals" });
        expect(res.changed).toBe(true);
        adminCtx = await loadStaffContext(tx, tenantId, { userId: admin!.id, role: "firm_admin", capabilities: [] });
        expect((await getPermissionMatrix(tx, tenantId, adminCtx)).overrides).toHaveLength(1);
        await expect(setPermissionOverride(tx, { tenantId, by: adminCtx, role: "admin", right: "permissions.manage", effect: "deny", reason: "x" })).rejects.toThrow(/your own ability/);
        // Pat keeps the intake_staff base role (rights are the union of roles), so team-only must cover it too.
        await setPermissionOverride(tx, { tenantId, by: ownerCtx, role: "intake_staff", right: "matters.access_all", effect: "deny", reason: "Team-only intake staff" });

        // Matter team + restriction.
        const [client] = await tx.insert(parties).values({ tenantId, fullName: "Ana", normalizedName: "ana" }).returning({ id: parties.id });
        const [matter] = await tx.insert(matters).values({ tenantId, primaryPartyId: client!.id, assignedUserId: lawyer!.id, practiceArea: "family" }).returning({ id: matters.id });
        const paraCtx = await loadStaffContext(tx, tenantId, { userId: para!.id, role: "intake_staff", capabilities: [] });
        let ref = (await loadMatterRef(tx, tenantId, matter!.id))!;
        expect(can(paraCtx.actor, "matters.view", { type: "matter", ...ref }, paraCtx.config)).toBe(false);
        await addTeamMember(tx, { tenantId, by: ownerCtx, matterId: matter!.id, userId: para!.id });
        await setMatterRestricted(tx, { tenantId, by: ownerCtx, matterId: matter!.id, restricted: true, reason: "Staff member's own case" });
        ref = (await loadMatterRef(tx, tenantId, matter!.id))!;
        expect(can(paraCtx.actor, "matters.view", { type: "matter", ...ref }, paraCtx.config)).toBe(true);
        expect(can(adminCtx.actor, "matters.view", { type: "matter", ...ref }, adminCtx.config)).toBe(false);

        // Practice areas: default adoption, refusing an empty set, switching off keeps matters.
        expect(await ensureDefaultPackAdoptions(tx, tenantId)).toMatchObject({ adopted: ["family"], republished: true });
        expect(activePack(await getFirmSettings(tx, tenantId), "family")?.version).toBeTruthy();
        expect(await ensureDefaultPackAdoptions(tx, tenantId)).toMatchObject({ republished: false });
        await expect(setEnabledPracticeAreas(tx, { tenantId, by: ownerCtx, areas: [], reason: "x" })).rejects.toThrow();
        await expect(setEnabledPracticeAreas(tx, { tenantId, by: paraCtx, areas: ["family"], reason: "x" })).rejects.toThrow(/Not allowed/);
        const overview = await getPracticeAreaOverview(tx, tenantId, ownerCtx);
        const fam = overview.find((o) => o.id === "family")!;
        expect(fam).toMatchObject({ enabled: true, state: "current", openMatters: 1 });
        await expect(acceptPackUpdate(tx, { tenantId, by: ownerCtx, area: "family", version: fam.latestVersion!, contentHash: fam.latestContentHash! })).rejects.toThrow(/cannot be accepted/);

        const log = await listAccessChanges(tx, tenantId, ownerCtx);
        expect(log.map((l) => l.action)).toEqual(expect.arrayContaining(["role.granted", "override.set", "matter.restricted", "team.added", "pack.accepted"]));
        throw new Rollback();
      });
    } catch (err) {
      if (!(err instanceof Rollback)) throw err;
    }
  });
});
