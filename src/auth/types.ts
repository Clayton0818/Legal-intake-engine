// c34 — shared auth types. No runtime imports beyond RBAC types.

import type { Capability, Permission, Role } from "./rbac";

/** Minimal view of an incoming request that every provider can work with. */
export interface AuthRequest {
  header(name: string): string | null | undefined;
  cookie(name: string): string | null | undefined;
}

/**
 * What a provider proves about a request: WHO (provider + subject) and WHICH
 * FIRM (a tenant claim the vendor signed). It says nothing about roles; those
 * come from our own users / user_capabilities tables, under RLS.
 */
export interface VerifiedIdentity {
  provider: string;
  subject: string;
  tenantId: string;
  email?: string | null;
  sessionId?: string | null;
  expiresAt?: Date | null;
}

export interface AuthProvider {
  readonly name: string;
  /** True for the dev provider: no real proof of identity. */
  readonly isDev: boolean;
  /** Returns null when the request carries no credential at all; throws AuthError when it carries a bad one. */
  authenticate(req: AuthRequest, now?: Date): Promise<VerifiedIdentity | null>;
}

/** The resolved, authorised staff member behind a request. */
export interface Principal {
  tenantId: string;
  /** null only for the synthetic dev principal (no users row). */
  userId: string | null;
  role: Role;
  capabilities: Capability[];
  permissions: Permission[];
  displayName: string;
  email: string | null;
  provider: string;
  subject: string;
  isDev: boolean;
}
