// Route wrapper for the Billing & trust API. Builds on the shared tenantRoute()
// (tenant from the signed-in session, lazy withTenant, approvals loaded fail-safe)
// and adds:
//  - the acting user from the shared c34 session (requirePrincipal); the
//    synthetic dev principal has no users row, so it cannot act on trust money;
//  - the minimal trust-role check (src/engines/billing-trust/access.ts);
//  - handled errors (pending approval → 423, role → 403, rule refusal → 4xx)
//    returned as responses INSIDE the transaction, so the audit row for a
//    blocked, denied or refused attempt is committed rather than rolled back;
//  - bigint-safe JSON (amounts are serialised as strings of cents).

import { HttpError, tenantRoute, type TenantRouteContext } from "@/tenancy/route";
import type { TrustAction } from "@/engines/billing-trust/access";
import { mapHandledError, type MappedError } from "@/engines/billing-trust/http";
import { requireTrustActor, type TrustServiceContext } from "@/engines/billing-trust/ledgerService";
import { jsonSafe } from "@/engines/billing-trust/money";

export interface TrustRouteContext extends TenantRouteContext {
  userId: string;
  svc: TrustServiceContext;
}

type Envelope = { ok: true; value: unknown } | { ok: false; error: MappedError };

export async function trustRoute<T>(
  label: string,
  handler: (ctx: TrustRouteContext) => Promise<T>,
  opts: { status?: number; require?: TrustAction } = {}
): Promise<Response> {
  const res = await tenantRoute(label, async ({ tx, tenantId }): Promise<Envelope> => {
    const { requirePrincipal } = await import("@/auth/request");
    const me = await requirePrincipal(tx, tenantId);
    if (!me.userId) throw new HttpError(403, "Trust records need a real signed-in user (set DEV_USER_ID in dev mode).");
    const svc: TrustServiceContext = { tx, tenantId, actorUserId: me.userId };
    try {
      await requireTrustActor(svc, opts.require ?? "read", label);
      return { ok: true, value: jsonSafe((await handler({ tx, tenantId, userId: me.userId, svc })) ?? null) };
    } catch (err) {
      const mapped = mapHandledError(err);
      if (!mapped) throw err;
      return { ok: false, error: mapped };
    }
  });
  if (res.status !== 200) return res;
  const envelope = (await res.json()) as Envelope;
  if (!envelope.ok) return Response.json(envelope.error.body, { status: envelope.error.status });
  return Response.json(envelope.value, { status: opts.status ?? 200 });
}

/** Turn a { filename, format, content } JSON response into a file download. */
export async function downloadResponse(json: Response): Promise<Response> {
  if (json.status !== 200) return json;
  const body = (await json.json()) as { filename?: string; content?: string; format?: string };
  if (typeof body.content !== "string") return Response.json({ error: "Nothing to export." }, { status: 404 });
  return new Response(body.content, {
    status: 200,
    headers: {
      "content-type": body.format === "json" ? "application/json; charset=utf-8" : "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${body.filename ?? "export"}"`,
      "cache-control": "no-store",
    },
  });
}
