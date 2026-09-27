// Route wrapper for the Conflict-check API. Builds on the shared
// tenantRoute() (tenant, lazy withTenant, approvals loaded fail-safe) and adds:
//  - the acting user and their conflicts access (see resolveActingUserId);
//  - an optional capability check that LOGS a denial (c56 acceptance 4);
//  - handled errors (pending approval → 423, access → 403, validation → 4xx)
//    returned as responses INSIDE the transaction, so the audit row for a
//    blocked or refused attempt is committed rather than rolled back.

import { tenantRoute, type TenantRouteContext } from "@/tenancy/route";
import { audit, getFirmSettings } from "@/core";
import { AccessDeniedError, checkAndLog, loadAccess, type ConflictAccess, type ConflictCapability } from "@/engines/conflict-check/access";
import { mapHandledError, resolveActingUserId, type MappedError } from "@/engines/conflict-check/http";
import { ENGINE, readConflictSettings } from "@/engines/conflict-check/settings";

export interface ConflictRouteContext extends TenantRouteContext {
  userId: string;
  access: ConflictAccess;
}

type Envelope = { ok: true; value: unknown } | { ok: false; error: MappedError };

export async function conflictRoute<T>(
  label: string,
  req: Request,
  handler: (ctx: ConflictRouteContext) => Promise<T>,
  opts: { status?: number; capability?: ConflictCapability } = {}
): Promise<Response> {
  const who = resolveActingUserId(req.headers);
  if (!who.ok) return Response.json({ error: who.error }, { status: who.status });

  const res = await tenantRoute(label, async ({ tx, tenantId }): Promise<Envelope> => {
    const settings = readConflictSettings(await getFirmSettings(tx, tenantId));
    const access = await loadAccess(tx, tenantId, who.userId, { ownerSeesPartyDetails: settings.ownerSeesPartyDetails });
    if (!access.active) {
      return { ok: false, error: { status: 403, body: { error: "Not allowed: unknown or inactive user." } } };
    }
    if (opts.capability && !(await checkAndLog(tx, tenantId, access, opts.capability, label))) {
      return { ok: false, error: { status: 403, body: { error: "Not allowed: this needs the conflicts role." } } };
    }
    try {
      return { ok: true, value: (await handler({ tx, tenantId, userId: who.userId, access })) ?? null };
    } catch (err) {
      const mapped = mapHandledError(err);
      if (!mapped) throw err;
      if (err instanceof AccessDeniedError) {
        await audit(tx, {
          tenantId,
          engine: ENGINE,
          action: "access.denied",
          entityType: "user",
          entityId: who.userId,
          actor: { type: "user", userId: who.userId },
          payload: { capability: err.capability, attempted: label },
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

/** A text/CSV download through the same wrapper. */
export async function downloadResponse(json: Response): Promise<Response> {
  if (json.status !== 200) return json;
  const body = (await json.json()) as { ready?: boolean; filename?: string; content?: string; format?: string };
  if (!body.ready || typeof body.content !== "string") return Response.json(body, { status: 202 });
  return new Response(body.content, {
    status: 200,
    headers: {
      "content-type": body.format === "json" ? "application/json; charset=utf-8" : "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${body.filename ?? "export"}"`,
      "cache-control": "no-store",
    },
  });
}
