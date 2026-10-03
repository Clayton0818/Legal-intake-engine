// Route wrapper for the Document API (c84). Same steps as the shared
// tenantRoute() — tenant from the session (c34), lazy withTenant(),
// approvals loaded fail-safe — plus:
//  - the signed-in staff member as a DocumentViewer, with their screens and
//    matter scope loaded once (access/service.ts loadAccess);
//  - handled errors (denied, blocked by a pending gate, validation) answered
//    INSIDE the transaction, so the access-log / audit rows for the refused
//    attempt are committed instead of rolled back;
//  - handlers may return a binary Response (downloads).

import { errorResponse, HttpError } from "@/tenancy/route";
import type { TenantTx } from "@/tenancy/withTenant";
import { PendingApprovalError } from "@/compliance/approvals";
import { auditBlocked } from "@/core";
import type { StaffViewer } from "@/engines/document/access/policy";
import { loadAccess, type LoadedAccess } from "@/engines/document/access/service";
import { mapHandledError, type MappedError } from "@/engines/document/http";
import { ENGINE } from "@/engines/document/settings";

export interface DocumentRouteContext extends LoadedAccess {
  tx: TenantTx;
  tenantId: string;
  viewer: StaffViewer;
}

type Envelope = { ok: true; value: unknown } | { ok: false; error: MappedError };

export async function documentRoute(
  label: string,
  handler: (ctx: DocumentRouteContext) => Promise<unknown>,
  opts: { status?: number } = {}
): Promise<Response> {
  try {
    const { resolveRequestTenantId, requirePrincipal } = await import("@/auth/request");
    const tenantId = await resolveRequestTenantId();
    const [{ withTenant }, { ensureServerApprovals }] = await Promise.all([import("@/tenancy/withTenant"), import("@/compliance/server")]);
    await ensureServerApprovals();
    const envelope = await withTenant(tenantId, async (tx): Promise<Envelope> => {
      const principal = await requirePrincipal(tx, tenantId);
      const viewer: StaffViewer = { kind: "staff", userId: principal.userId, role: principal.role, permissions: principal.permissions };
      const loaded = await loadAccess(tx, tenantId, viewer);
      try {
        return { ok: true, value: await handler({ tx, tenantId, viewer, ...loaded }) };
      } catch (err) {
        const mapped = mapHandledError(err);
        if (!mapped) throw err;
        if (err instanceof PendingApprovalError) {
          await auditBlocked(tx, err, {
            tenantId,
            engine: ENGINE,
            actor: viewer.userId ? { type: "user", userId: viewer.userId } : { type: "system" },
            payload: { route: label },
          });
        }
        return { ok: false, error: mapped };
      }
    });
    if (!envelope.ok) return Response.json(envelope.error.body, { status: envelope.error.status });
    if (envelope.value instanceof Response) return envelope.value;
    return Response.json(envelope.value ?? null, { status: opts.status ?? 200 });
  } catch (err) {
    return errorResponse(label, err);
  }
}

export { HttpError };
