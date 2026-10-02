// Shared plumbing for tenant-scoped API routes (src/app/api/<slug>/**):
//
//   export const dynamic = "force-dynamic";
//   export async function GET() {
//     return tenantRoute("GET /api/document/checklist", ({ tx, tenantId }) => listChecklist(tx, tenantId));
//   }
//
// - resolves the tenant from the request's session (src/auth/request.ts,
//   c34): the vendor's signed tenant claim, or DEV_TENANT_ID in dev mode —
//   routes do not change; handlers that need the caller's identity or a
//   permission call requirePrincipal(tx, tenantId, "<permission>");
// - imports withTenant() lazily, so `next build` never needs DATABASE_URL;
// - loads compliance approvals (fail safe) before the handler runs;
// - maps a PendingApprovalError to HTTP 423 with the visible placeholder, so
//   a gated action is visibly blocked rather than silently skipped.

import type { TenantTx } from "./withTenant";
import { PendingApprovalError } from "@/compliance/approvals";

export interface TenantRouteContext {
  tx: TenantTx;
  tenantId: string;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** Pure: turn an error from a route handler into a JSON response. */
export function errorResponse(label: string, err: unknown): Response {
  if (err instanceof PendingApprovalError) {
    return Response.json(
      { error: "pending_approval", gate: err.gateKey, pendingReviewers: err.pendingReviewers, message: err.placeholder },
      { status: 423 }
    );
  }
  if (err instanceof HttpError) return Response.json({ error: err.message }, { status: err.status });
  console.error(`[${label}] failed:`, err);
  return Response.json({ error: "Something went wrong." }, { status: 500 });
}

export async function tenantRoute<T>(
  label: string,
  handler: (ctx: TenantRouteContext) => Promise<T>,
  opts: { status?: number } = {}
): Promise<Response> {
  try {
    const { resolveRequestTenantId } = await import("@/auth/request");
    const tenantId = await resolveRequestTenantId();
    const [{ withTenant }, { ensureServerApprovals }] = await Promise.all([
      import("./withTenant"),
      import("@/compliance/server"),
    ]);
    await ensureServerApprovals();
    const body = await withTenant(tenantId, (tx) => handler({ tx, tenantId }));
    return Response.json(body ?? null, { status: opts.status ?? 200 });
  } catch (err) {
    return errorResponse(label, err);
  }
}
