// c34 — which auth mode this deployment runs in. Pure and edge-safe (it is
// imported by src/middleware.ts), so it must not import the database, the
// schema or anything Node-only.
//
//   AUTH_PROVIDER=clerk  real vendor sessions (gated on 'auth.vendor')
//   AUTH_PROVIDER=dev    today's DEV_TENANT_ID stand-in (no real identity!)
//   AUTH_PROVIDER=none   every staff request is refused
//   unset                'dev' when DEV_TENANT_ID is set (keeps today's flow
//                        working unchanged), otherwise 'none' (fail safe).

export type AuthMode = "dev" | "clerk" | "none";

export interface AuthConfig {
  mode: AuthMode;
  /** Dev mode in a production build: allowed (today's staging uses it) but loudly marked. */
  insecure: boolean;
  /** Human-readable explanation, for logs and the 401 body. */
  reason: string;
}

export type Env = Readonly<Record<string, string | undefined>>;

export function resolveAuthConfig(env: Env): AuthConfig {
  const explicit = env.AUTH_PROVIDER?.trim().toLowerCase();
  const production = env.NODE_ENV === "production";

  if (explicit === "clerk") return { mode: "clerk", insecure: false, reason: "AUTH_PROVIDER=clerk" };
  if (explicit === "none") return { mode: "none", insecure: false, reason: "AUTH_PROVIDER=none" };
  if (explicit && explicit !== "dev") {
    return { mode: "none", insecure: false, reason: `Unknown AUTH_PROVIDER '${explicit}' — refusing all staff requests.` };
  }
  if (!env.DEV_TENANT_ID) {
    return {
      mode: "none",
      insecure: false,
      reason: explicit === "dev" ? "AUTH_PROVIDER=dev but DEV_TENANT_ID is not set." : "No AUTH_PROVIDER and no DEV_TENANT_ID.",
    };
  }
  return {
    mode: "dev",
    insecure: production,
    reason: explicit === "dev" ? "AUTH_PROVIDER=dev" : "DEV_TENANT_ID stand-in (no AUTH_PROVIDER set)",
  };
}

/** Clerk keeps its session JWT in this cookie on the app's own domain. */
export const SESSION_COOKIE = "__session";

/** Pure: pull a bearer token or session cookie from a request. */
export function extractSessionToken(req: {
  header(name: string): string | null | undefined;
  cookie(name: string): string | null | undefined;
}): string | null {
  const auth = req.header("authorization");
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m?.[1]) return m[1].trim();
  }
  const c = req.cookie(SESSION_COOKIE);
  return c && c.trim() ? c.trim() : null;
}
