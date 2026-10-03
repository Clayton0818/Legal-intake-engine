// Server-side loader for the All-engines admin pages: resolves the signed-in
// staff member (c34) into a c99 policy context inside one tenant transaction.
// Pages are read-only; every change goes through /api/all-engines/**.

import type { TenantTx } from "@/tenancy/withTenant";
import type { StaffContext } from "@/engines/all-engines/permissions/service";

export async function withStaff<T>(
  label: string,
  fn: (ctx: { tx: TenantTx; tenantId: string; staff: StaffContext }) => Promise<T>
): Promise<{ data: T | null; error: string | null }> {
  try {
    const [{ resolveRequestTenantId, requirePrincipal }, { withTenant }, { ensureServerApprovals }, { loadStaffContext }, { PermissionDeniedError }] =
      await Promise.all([
        import("@/auth/request"),
        import("@/tenancy/withTenant"),
        import("@/compliance/server"),
        import("@/engines/all-engines/permissions/service"),
        import("@/engines/all-engines/permissions/policy"),
      ]);
    await ensureServerApprovals();
    const tenantId = await resolveRequestTenantId();
    try {
      const data = await withTenant(tenantId, async (tx) => {
        const p = await requirePrincipal(tx, tenantId);
        const staff = await loadStaffContext(tx, tenantId, { userId: p.userId, role: p.role, capabilities: p.capabilities });
        return fn({ tx, tenantId, staff });
      });
      return { data, error: null };
    } catch (err) {
      if (err instanceof PermissionDeniedError) return { data: null, error: "You do not have permission to see this page." };
      throw err;
    }
  } catch (err) {
    console.error(`[admin/all-engines/${label}] failed to load:`, err);
    return { data: null, error: "Could not load this page." };
  }
}
