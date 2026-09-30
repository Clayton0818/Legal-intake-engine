// c34 — turning a verified identity + our own user rows into a Principal. Pure.

import type { Actor } from "@/core/audit";
import type { Env } from "./config";
import { AuthError } from "./providers";
import { CAPABILITIES, isCapability, isRole, permissionsFor, type Capability, type Role } from "./rbac";
import type { Principal, VerifiedIdentity } from "./types";

export interface PrincipalUserRow {
  id: string;
  tenantId: string;
  email: string;
  displayName: string;
  role: Role;
  status: string;
}

export function buildPrincipal(input: {
  identity: VerifiedIdentity;
  user: PrincipalUserRow;
  capabilities: readonly string[];
  isDev?: boolean;
}): Principal {
  const { identity, user } = input;
  if (user.tenantId !== identity.tenantId) {
    // Defence in depth: RLS already prevents this row from being visible.
    throw new AuthError(403, "This account belongs to a different firm.", "tenant_mismatch");
  }
  if (user.status !== "active") {
    throw new AuthError(403, user.status === "invited" ? "Your invitation has not been accepted yet." : "This account is disabled.", `user_${user.status}`);
  }
  const capabilities = [...new Set(input.capabilities.filter(isCapability))];
  const permissions = [...permissionsFor({ role: user.role, capabilities, status: user.status })].sort();
  return {
    tenantId: identity.tenantId,
    userId: user.id,
    role: user.role,
    capabilities,
    permissions,
    displayName: user.displayName,
    email: user.email,
    provider: identity.provider,
    subject: identity.subject,
    isDev: Boolean(input.isDev),
  };
}

/**
 * The synthetic dev principal used when DEV_USER_ID is not set. Role defaults
 * to firm_admin, which is exactly what today's unauthenticated /admin allows.
 * DEV_ROLE / DEV_CAPABILITIES narrow it for testing permission paths.
 */
export function devPrincipal(identity: VerifiedIdentity, env: Env): Principal {
  const role: Role = isRole(env.DEV_ROLE) ? env.DEV_ROLE : "firm_admin";
  const capabilities: Capability[] = (env.DEV_CAPABILITIES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is Capability => (CAPABILITIES as readonly string[]).includes(s));
  return {
    tenantId: identity.tenantId,
    userId: null,
    role,
    capabilities,
    permissions: [...permissionsFor({ role, capabilities })].sort(),
    displayName: "Dev user (no real authentication)",
    email: null,
    provider: "dev",
    subject: identity.subject,
    isDev: true,
  };
}

/** The audit/flag Actor for a principal. The synthetic dev principal is logged as system. */
export function actorFor(principal: Principal): Actor {
  return principal.userId ? { type: "user", userId: principal.userId } : { type: "system" };
}

/** Public-safe shape for GET /api/auth/me. */
export function describePrincipal(p: Principal) {
  return {
    tenantId: p.tenantId,
    userId: p.userId,
    displayName: p.displayName,
    email: p.email,
    role: p.role,
    capabilities: p.capabilities,
    permissions: p.permissions,
    provider: p.provider,
    devMode: p.isDev,
  };
}
