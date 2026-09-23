// The required check ADR-0001 §D5 mandates directly: "an automated test
// that seeds two tenants, queries tenant A's data while scoped to tenant B,
// and asserts zero rows — running on every PR as a required check." This is
// that test, run against a real database (DATABASE_URL), not a mock — the
// entire point is proving the `app_runtime` role plus RLS plus the
// transaction-pooler actually behave the way §D5 assumes, not that the
// TypeScript wrapper calls the right function.
//
// Requires DATABASE_URL pointed at a real Postgres with this schema applied
// (migrations/0000_*.sql) and the app_runtime role + RLS policies in place.
// In CI (see .github/workflows/ci.yml) this runs against the staging
// Supabase project via secrets.DATABASE_URL_STAGING.

import { describe, it, expect, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { withTenant } from "./withTenant";
import { rawDb } from "./db";
import { firms, matters, parties } from "@/db/schema";
import { eq } from "drizzle-orm";

describe("cross-tenant isolation (ADR-0001 §D5 required check)", () => {
  const tenantASlug = `isolation-test-a-${Date.now()}`;
  const tenantBSlug = `isolation-test-b-${Date.now()}`;
  let tenantAId: string;
  let tenantBId: string;

  afterAll(async () => {
    // Clean up so this test doesn't leave synthetic rows behind in a shared
    // staging database on every CI run.
    //
    // These deletes MUST go through withTenant(), not rawDb directly:
    // matters/parties are RLS-protected on tenant_id, and outside a
    // withTenant() transaction `app.tenant_id` is unset, so an unscoped
    // rawDb.delete() here silently matches zero rows (RLS filters them
    // out) instead of erroring — it looks like it succeeded but leaves the
    // rows in place. The firms.id references from those tables then have
    // no ON DELETE behavior (see src/db/schema.ts), so the plain
    // rawDb.delete(firms) below throws a foreign-key violation, which
    // surfaces as this whole test failing even when both assertions above
    // passed. (This is exactly why five leftover "Isolation Test Firm"
    // pairs, and their orphaned parties/matters rows, were found sitting
    // in the staging database — every prior CI run hit this.)
    if (tenantAId) {
      await withTenant(tenantAId, async (tx) => {
        await tx.delete(matters).where(eq(matters.tenantId, tenantAId));
        await tx.delete(parties).where(eq(parties.tenantId, tenantAId));
      });
    }
    if (tenantBId) {
      await withTenant(tenantBId, async (tx) => {
        await tx.delete(matters).where(eq(matters.tenantId, tenantBId));
        await tx.delete(parties).where(eq(parties.tenantId, tenantBId));
      });
    }
    if (tenantAId) await rawDb.delete(firms).where(eq(firms.id, tenantAId));
    if (tenantBId) await rawDb.delete(firms).where(eq(firms.id, tenantBId));
  });

  it("seeds two tenants and confirms tenant B cannot see tenant A's data", async () => {
    // Seed via rawDb directly (not withTenant) since firms itself isn't
    // tenant-scoped — this mirrors how a real onboarding flow would create
    // the tenant row before any withTenant()-scoped work happens for it.
    const [firmA] = await rawDb
      .insert(firms)
      .values({ name: "Isolation Test Firm A", slug: tenantASlug })
      .returning({ id: firms.id });
    const [firmB] = await rawDb
      .insert(firms)
      .values({ name: "Isolation Test Firm B", slug: tenantBSlug })
      .returning({ id: firms.id });

    tenantAId = firmA!.id;
    tenantBId = firmB!.id;

    // Write a party + matter into tenant A's scope, via withTenant() the
    // same way real application code would.
    await withTenant(tenantAId, async (tx) => {
      const [party] = await tx
        .insert(parties)
        .values({ tenantId: tenantAId, fullName: "Synthetic Caller A", normalizedName: "synthetic caller a" })
        .returning({ id: parties.id });
      await tx.insert(matters).values({ tenantId: tenantAId, primaryPartyId: party!.id });
    });

    // The actual test: scope a query to tenant B and confirm it sees ZERO
    // of tenant A's rows, even though tenant A's rows definitely exist.
    const crossTenantResult = await withTenant(tenantBId, async (tx) => {
      return tx.select().from(matters).where(eq(matters.tenantId, tenantAId));
    });
    expect(crossTenantResult).toHaveLength(0);

    const crossTenantPartyResult = await withTenant(tenantBId, async (tx) => {
      return tx.select().from(parties).where(eq(parties.tenantId, tenantAId));
    });
    expect(crossTenantPartyResult).toHaveLength(0);

    // Sanity check the negative isn't just "everything returns zero rows" —
    // tenant A scoped to itself should see its own row.
    const ownTenantResult = await withTenant(tenantAId, async (tx) => {
      return tx.select().from(matters).where(eq(matters.tenantId, tenantAId));
    });
    expect(ownTenantResult).toHaveLength(1);
  });

  it("confirms app_runtime cannot UPDATE or DELETE intake_events (c6 §3 immutability)", async () => {
    const result = await rawDb.execute(sql`select has_table_privilege('app_runtime', 'intake_events', 'UPDATE') as can_update, has_table_privilege('app_runtime', 'intake_events', 'DELETE') as can_delete`);
    const row = (result as unknown as { can_update: boolean; can_delete: boolean }[])[0];
    expect(row?.can_update).toBe(false);
    expect(row?.can_delete).toBe(false);
  });
});
