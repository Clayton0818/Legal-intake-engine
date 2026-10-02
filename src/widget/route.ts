// c38 — server handlers for the embeddable widget, written as plain functions
// so wiring them up is a one-line re-export (the app/api paths they belong
// under are outside this group's folders — see the PR's shared requests):
//
//   // src/app/api/widget/config/route.ts
//   export { GET } from "@/widget/route";  export const dynamic = "force-dynamic";
//
// and, for per-firm intake sessions, the intake routes call
// resolveWidgetTenant(req) before falling back to the staff/dev tenant.

import { ensureServerApprovals } from "@/compliance/server";
import { resolveWidgetEmbed, tenantForWidgetKey, widgetPublicConfig } from "./embeds";

export const WIDGET_KEY_HEADER = "x-widget-key";
export const WIDGET_HOST_HEADER = "x-widget-host";

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

/** GET /api/widget/config?key=wk_…&host=https://firm.com → public notice + firm display name. */
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const key = url.searchParams.get("key");
  const host = url.searchParams.get("host");
  const tenantId = tenantForWidgetKey(key);
  if (!key || !tenantId) return json({ error: "This chat is not set up correctly." }, 404);
  try {
    const [{ withTenant }] = await Promise.all([import("@/tenancy/withTenant"), ensureServerApprovals()]);
    const result = await withTenant(tenantId, async (tx) => {
      const r = await resolveWidgetEmbed(tx, key, host, { requireOrigin: false });
      if (!r.ok) return { ok: false as const, reason: r.reason };
      return { ok: true as const, config: await widgetPublicConfig(tx, tenantId) };
    });
    if (!result.ok) {
      return json({ error: "This chat is not available on this site.", reason: result.reason }, result.reason === "origin_not_allowed" ? 403 : 404);
    }
    return json(result.config);
  } catch (err) {
    console.error("[GET /api/widget/config] failed:", err);
    return json({ error: "Something went wrong." }, 500);
  }
}

/**
 * For the intake routes: the tenant a widget request belongs to, or null when
 * the request carries no widget key (then the caller uses its normal tenant).
 * Throws when a key is present but invalid, disabled or used from an origin
 * that isn't allowlisted — never silently falls back to another tenant.
 */
export async function resolveWidgetTenant(req: Request): Promise<string | null> {
  const key = req.headers.get(WIDGET_KEY_HEADER);
  if (!key) return null;
  const tenantId = tenantForWidgetKey(key);
  if (!tenantId) throw new WidgetAccessError("bad_key");
  const { withTenant } = await import("@/tenancy/withTenant");
  const r = await withTenant(tenantId, (tx) => resolveWidgetEmbed(tx, key, req.headers.get(WIDGET_HOST_HEADER), { requireOrigin: false }));
  if (!r.ok) throw new WidgetAccessError(r.reason);
  return r.tenantId;
}

export class WidgetAccessError extends Error {
  readonly status = 403;
  constructor(readonly reason: string) {
    super(`Widget access refused (${reason}).`);
    this.name = "WidgetAccessError";
  }
}
