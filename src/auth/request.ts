// c34 — request-level auth for route handlers and server components.
//
//   const tenantId = await resolveRequestTenantId();          // tenantRoute uses this
//   const me = await requirePrincipal(tx, tenantId, "ops.view");
//
// Dev mode (today's flow): tenant = DEV_TENANT_ID, principal = DEV_USER_ID's
// user or the synthetic dev firm_admin. Clerk mode: the vendor call is gated
// on 'auth.vendor' — while that gate is pending every request gets HTTP 423
// with the visible placeholder (fail safe: nobody is let in unverified).
// None mode: HTTP 401.

import { requireApproval } from "@/compliance/approvals";
import { HttpError } from "@/tenancy/route";
import type { TenantTx } from "@/tenancy/withTenant";
import { PLATFORM_GATES } from "@/engines/platform/gates";
import { resolveAuthConfig, type Env } from "./config";
import { AuthError, ClerkAuthProvider, clerkConfigFromEnv, DevAuthProvider } from "./providers";
import { ForbiddenError, can, type Permission } from "./rbac";
import type { AuthProvider, AuthRequest, Principal, VerifiedIdentity } from "./types";

let providerOverride: AuthProvider | null = null;
let cached: { key: string; provider: AuthProvider } | null = null;

/** Tests / future wiring: force a specific provider. Pass null to reset. */
export function setAuthProviderForTests(p: AuthProvider | null): void {
  providerOverride = p;
  cached = null;
}

/**
 * The provider for this deployment. For the vendor this calls
 * requireApproval('auth.vendor') EVERY time, so revoking the gate takes
 * effect on the next approvals refresh.
 */
export function getAuthProvider(env: Env = process.env): AuthProvider {
  if (providerOverride) return providerOverride;
  const config = resolveAuthConfig(env);
  if (config.mode === "none") throw new AuthError(401, `Staff sign-in is not configured: ${config.reason}`, "auth_not_configured");
  if (config.mode === "clerk") {
    requireApproval(PLATFORM_GATES.authVendor.key, { action: "auth.authenticate" });
  }
  const key = `${config.mode}:${env.DEV_TENANT_ID ?? ""}:${env.DEV_USER_ID ?? ""}:${env.CLERK_ISSUER ?? ""}`;
  if (cached?.key === key) return cached.provider;
  const provider = config.mode === "clerk" ? new ClerkAuthProvider(clerkConfigFromEnv(env)) : new DevAuthProvider(env);
  cached = { key, provider };
  return provider;
}

async function nextRequest(): Promise<AuthRequest> {
  const { headers, cookies } = await import("next/headers");
  const [h, c] = await Promise.all([headers(), cookies()]);
  return { header: (n) => h.get(n), cookie: (n) => c.get(n)?.value };
}

function toHttp(err: unknown): unknown {
  if (err instanceof AuthError) return new HttpError(err.status, err.message);
  if (err instanceof ForbiddenError) return new HttpError(403, err.message);
  return err;
}

/** Verify the request's credential. `req` defaults to the current Next request. */
export async function authenticateRequest(req?: AuthRequest, env: Env = process.env): Promise<VerifiedIdentity> {
  try {
    if (resolveAuthConfig(env).mode === "clerk" && !providerOverride) {
      // Approvals must be fresh before the gate check (tenantRoute loads them
      // only after the tenant is known).
      const { ensureServerApprovals } = await import("@/compliance/server");
      await ensureServerApprovals();
    }
    const provider = getAuthProvider(env);
    const identity = await provider.authenticate(req ?? (await nextRequest()));
    if (!identity) throw new AuthError(401, "Please sign in.");
    return identity;
  } catch (err) {
    throw toHttp(err);
  }
}

/** The tenant for this request (replaces getDevTenantId() in tenantRoute). */
export async function resolveRequestTenantId(req?: AuthRequest): Promise<string> {
  return (await authenticateRequest(req)).tenantId;
}

/**
 * Resolve the Principal inside an already-open tenant transaction and
 * (optionally) require a permission. Throws HttpError 401/403.
 */
export async function requirePrincipal(
  tx: TenantTx,
  tenantId: string,
  permission?: Permission,
  req?: AuthRequest
): Promise<Principal> {
  const identity = await authenticateRequest(req);
  if (identity.tenantId !== tenantId) throw new HttpError(403, "This session belongs to a different firm.");
  try {
    const { loadPrincipal } = await import("./session");
    const principal = await loadPrincipal(tx, identity);
    if (permission && !can(principal, permission)) throw new ForbiddenError(permission);
    return principal;
  } catch (err) {
    throw toHttp(err);
  }
}
