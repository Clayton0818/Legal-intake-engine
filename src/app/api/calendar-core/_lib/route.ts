// Route wrapper for the calendar-core API. Builds on the shared tenantRoute()
// (tenant, lazy withTenant, approvals loaded fail-safe) and adds:
//  - the signed-in staff member (requirePrincipal + a permission), with the
//    role re-read from the firm's users row by the engine (loadStaff);
//  - handled errors (pending approval → 423, engine errors → 4xx) answered
//    INSIDE the transaction, so audit rows of blocked attempts are kept.

import { HttpError, tenantRoute, type TenantRouteContext } from "@/tenancy/route";
import { requirePrincipal } from "@/auth/request";
import type { Permission } from "@/auth/rbac";
import { auditBlocked } from "@/core";
import { PendingApprovalError } from "@/compliance/approvals";
import { loadStaff, type Staff } from "@/engines/calendar-core/actors";
import { mapHandledError, type MappedError } from "@/engines/calendar-core/http";
import { ENGINE } from "@/engines/calendar-core/settings";

export interface CoreRouteContext extends TenantRouteContext {
  staff: Staff;
}

type Envelope = { ok: true; value: unknown } | { ok: false; error: MappedError };

export async function coreRoute<T>(
  label: string,
  handler: (ctx: CoreRouteContext) => Promise<T>,
  opts: { permission?: Permission; status?: number } = {}
): Promise<Response> {
  const res = await tenantRoute(label, async ({ tx, tenantId }): Promise<Envelope> => {
    const me = await requirePrincipal(tx, tenantId, opts.permission ?? "calendar.read");
    if (!me.userId) throw new HttpError(403, "Set DEV_USER_ID to a real user: calendar actions are recorded against a person.");
    try {
      const staff = await loadStaff(tx, tenantId, me.userId);
      return { ok: true, value: (await handler({ tx, tenantId, staff })) ?? null };
    } catch (err) {
      const mapped = mapHandledError(err);
      if (!mapped) throw err;
      if (err instanceof PendingApprovalError) {
        await auditBlocked(tx, err, { tenantId, engine: ENGINE, actor: { type: "user", userId: me.userId }, payload: { route: label } });
      }
      return { ok: false, error: mapped };
    }
  });
  if (res.status !== 200) return res;
  const envelope = (await res.json()) as Envelope;
  if (!envelope.ok) return Response.json(envelope.error.body, { status: envelope.error.status });
  return Response.json(envelope.value, { status: opts.status ?? 200 });
}
