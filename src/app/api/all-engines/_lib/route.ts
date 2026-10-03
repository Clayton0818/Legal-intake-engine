// Route wrapper for the All-engines API. Builds on tenantRoute() (tenant,
// lazy withTenant, approvals loaded fail-safe) and adds:
//  - the signed-in staff member (c34 principal) turned into a c99 policy
//    actor, with this firm's overrides and assigned roles;
//  - handled errors (403 permission, 4xx validation, 423 pending approval)
//    returned INSIDE the transaction, so the audit row for a refused attempt
//    is committed rather than rolled back.

import { tenantRoute, type TenantRouteContext } from "@/tenancy/route";
import { audit } from "@/core/audit";
import { requirePrincipal } from "@/auth/request";
import { ENGINE, mapHandledError, type MappedError } from "@/engines/all-engines/common/errors";
import { PermissionDeniedError } from "@/engines/all-engines/permissions/policy";
import { loadStaffContext, type StaffContext } from "@/engines/all-engines/permissions/service";

export interface AllEnginesRouteContext extends TenantRouteContext {
  staff: StaffContext;
}

type Envelope = { ok: true; value: unknown } | { ok: false; error: MappedError };

export async function allEnginesRoute<T>(
  label: string,
  handler: (ctx: AllEnginesRouteContext) => Promise<T>,
  opts: { status?: number } = {}
): Promise<Response> {
  const res = await tenantRoute(label, async ({ tx, tenantId }): Promise<Envelope> => {
    const principal = await requirePrincipal(tx, tenantId);
    const staff = await loadStaffContext(tx, tenantId, { userId: principal.userId, role: principal.role, capabilities: principal.capabilities });
    try {
      return { ok: true, value: (await handler({ tx, tenantId, staff })) ?? null };
    } catch (err) {
      const mapped = mapHandledError(err);
      if (!mapped) throw err;
      if (err instanceof PermissionDeniedError) {
        await audit(tx, {
          tenantId,
          engine: ENGINE,
          action: "access.denied",
          actor: staff.auditActor,
          payload: { right: err.decision.right, reason: err.decision.reason, attempted: label },
        });
      }
      return { ok: false, error: mapped };
    }
  });
  if (res.status !== 200) return res;
  const envelope = (await res.json()) as Envelope;
  if (!envelope.ok) return Response.json(envelope.error.body, { status: envelope.error.status });
  return Response.json(envelope.value, { status: opts.status ?? 200 });
}
