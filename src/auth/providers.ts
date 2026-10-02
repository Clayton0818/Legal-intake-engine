// c34 — AuthProvider adapters.
//
//   DevAuthProvider   keeps today's DEV_TENANT_ID flow working. It proves
//                     nothing about who is calling; it exists so local and
//                     staging work continue while the vendor decision is open.
//   ClerkAuthProvider verifies a Clerk session JWT (RS256, JWKS) with
//                     WebCrypto — no SDK. It is only ever constructed behind
//                     the 'auth.vendor' gate (src/auth/request.ts), because
//                     picking the vendor is a founder decision and the vendor
//                     needs a DPA.
//
// Tenant resolution: the vendor token must carry a SIGNED tenant claim
// (default claim name 'tenant_id', set in Clerk's session-token template from
// the organisation's public metadata). We never look a tenant up across firms.

import { extractSessionToken, type Env } from "./config";
import { importRsaJwk, JwtError, verifyJwt } from "./jwt";
import type { AuthProvider, AuthRequest, VerifiedIdentity } from "./types";

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class AuthError extends Error {
  constructor(
    readonly status: 401 | 403,
    message: string,
    readonly code: string = status === 401 ? "unauthenticated" : "forbidden"
  ) {
    super(message);
    this.name = "AuthError";
  }
}

// ---------------------------------------------------------------------------
// Dev
// ---------------------------------------------------------------------------

export class DevAuthProvider implements AuthProvider {
  readonly name = "dev";
  readonly isDev = true;
  constructor(private readonly env: Env) {}

  async authenticate(): Promise<VerifiedIdentity> {
    const tenantId = this.env.DEV_TENANT_ID;
    if (!tenantId) throw new AuthError(401, "DEV_TENANT_ID is not set (dev auth).");
    return {
      provider: "dev",
      // A users.id when DEV_USER_ID is set (then that user's real role applies),
      // otherwise the synthetic dev principal.
      subject: this.env.DEV_USER_ID?.trim() || "dev",
      tenantId,
      email: null,
      sessionId: null,
      expiresAt: null,
    };
  }
}

// ---------------------------------------------------------------------------
// Clerk
// ---------------------------------------------------------------------------

export interface ClerkConfig {
  issuer: string;
  jwksUrl: string;
  authorizedParties: string[];
  tenantClaim: string;
}

export function clerkConfigFromEnv(env: Env): ClerkConfig {
  const issuer = env.CLERK_ISSUER?.trim().replace(/\/+$/, "");
  if (!issuer || !/^https:\/\//.test(issuer)) {
    throw new AuthError(401, "CLERK_ISSUER must be set to the https Clerk Frontend API URL.", "misconfigured");
  }
  return {
    issuer,
    jwksUrl: env.CLERK_JWKS_URL?.trim() || `${issuer}/.well-known/jwks.json`,
    authorizedParties: (env.CLERK_AUTHORIZED_PARTIES ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    tenantClaim: env.AUTH_TENANT_CLAIM?.trim() || "tenant_id",
  };
}

type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** Caches the vendor's public keys; refetches at most once a minute for an unknown kid. */
export class JwksCache {
  private keys = new Map<string, CryptoKey>();
  private fetchedAt = 0;
  constructor(
    private readonly url: string,
    private readonly fetchImpl: FetchLike,
    private readonly ttlMs = 10 * 60_000
  ) {}

  async get(kid: string | undefined, now = Date.now()): Promise<CryptoKey | null> {
    if (!kid) return null;
    const stale = now - this.fetchedAt > this.ttlMs;
    const missing = !this.keys.has(kid) && now - this.fetchedAt > 60_000;
    if (stale || missing) await this.refresh(now);
    return this.keys.get(kid) ?? null;
  }

  private async refresh(now: number): Promise<void> {
    const res = await this.fetchImpl(this.url);
    if (!res.ok) throw new AuthError(401, `Could not load signing keys (HTTP ${res.status}).`, "jwks_unavailable");
    const body = (await res.json()) as { keys?: Array<JsonWebKey & { kid?: string }> };
    const next = new Map<string, CryptoKey>();
    for (const jwk of body.keys ?? []) {
      if (!jwk.kid || jwk.kty !== "RSA") continue;
      next.set(jwk.kid, await importRsaJwk(jwk));
    }
    this.keys = next;
    this.fetchedAt = now;
  }
}

export class ClerkAuthProvider implements AuthProvider {
  readonly name = "clerk";
  readonly isDev = false;
  private readonly jwks: JwksCache;

  constructor(
    private readonly config: ClerkConfig,
    fetchImpl: FetchLike = (url) => fetch(url)
  ) {
    this.jwks = new JwksCache(config.jwksUrl, fetchImpl);
  }

  async authenticate(req: AuthRequest, now = new Date()): Promise<VerifiedIdentity | null> {
    const token = extractSessionToken(req);
    if (!token) return null;
    let claims;
    try {
      claims = await verifyJwt(token, {
        getKey: (kid) => this.jwks.get(kid, now.getTime()),
        issuer: this.config.issuer,
        authorizedParties: this.config.authorizedParties,
        now,
      });
    } catch (err) {
      if (err instanceof JwtError) throw new AuthError(401, err.message, `jwt_${err.code}`);
      throw err;
    }
    const tenantId = claims[this.config.tenantClaim];
    if (typeof tenantId !== "string" || !UUID_RE.test(tenantId)) {
      throw new AuthError(403, "Your session is not linked to a firm.", "no_tenant_claim");
    }
    return {
      provider: "clerk",
      subject: claims.sub as string,
      tenantId,
      email: typeof claims.email === "string" ? claims.email : null,
      sessionId: typeof claims.sid === "string" ? claims.sid : null,
      expiresAt: typeof claims.exp === "number" ? new Date(claims.exp * 1000) : null,
    };
  }
}
