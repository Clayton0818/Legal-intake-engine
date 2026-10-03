// Route wrapper for the calendar-alerts API. Builds on the shared tenantRoute()
// (tenant, lazy withTenant, approvals loaded fail-safe) and adds:
//  - the signed-in staff member (requirePrincipal + a permission), with the
//    role re-read from the firm's users row (loadStaff) — never trusted from
//    the request;
//  - the engine context (firm settings + this engine's settings);
//  - handled errors (pending approval → 423, rule errors → 4xx) answered
//    INSIDE the transaction, so audit rows of blocked attempts are kept.
//
// Every route here is STAFF-ONLY. Client-facing views (portal history, the
// client's own tasks) are service functions waiting for the client principal
// (c34/c11); internal flags, clocks, stalls and health are never exposed to a
// client route.

import { HttpError, tenantRoute, type TenantRouteContext } from "@/tenancy/route";
import { requirePrincipal } from "@/auth/request";
import type { Permission } from "@/auth/rbac";
import { auditBlocked } from "@/core/audit";
import { PendingApprovalError } from "@/compliance/approvals";
import { loadContext, loadStaff, type EngineContext, type Staff } from "@/engines/calendar-alerts/common";
import { mapHandledError, type MappedError } from "@/engines/calendar-alerts/http";
import { ENGINE } from "@/engines/calendar-alerts/settings";

export interface AlertsRouteContext extends TenantRouteContext {
  staff: Staff;
  ctx: EngineContext;
  now: Date;
}

type Envelope = { ok: true; value: unknown } | { ok: false; error: MappedError };

export async function alertsRoute<T>(
  label: string,
  handler: (c: AlertsRouteContext) => Promise<T>,
  opts: { permission?: Permission; status?: number } = {}
): Promise<Response> {
  const res = await tenantRoute(label, async ({ tx, tenantId }): Promise<Envelope> => {
    const me = await requirePrincipal(tx, tenantId, opts.permission ?? "ops.view");
    if (!me.userId) throw new HttpError(403, "Set DEV_USER_ID to a real user: alert actions are recorded against a person.");
    try {
      const staff = await loadStaff(tx, tenantId, me.userId);
      const ctx = await loadContext(tx, tenantId);
      return { ok: true, value: (await handler({ tx, tenantId, staff, ctx, now: new Date() })) ?? null };
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

export type RouteParams<K extends string> = { params: Promise<Record<K, string>> };
