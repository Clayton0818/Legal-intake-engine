import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ATTORNEY_ONLY,
  can,
  CAPABILITY_ELIGIBLE_ROLES,
  permissionsFor,
  PERMISSIONS,
  ROLE_PERMISSIONS,
  ROLES,
  validateCapabilityGrant,
} from "./rbac";
import { extractSessionToken, resolveAuthConfig } from "./config";
import { base64UrlEncode, checkClaims, decodeJwt, JwtError, verifyJwt } from "./jwt";
import { AuthError, ClerkAuthProvider, DevAuthProvider } from "./providers";
import { actorFor, buildPrincipal, devPrincipal } from "./principal";
import { classifyPath, decideMiddleware, normalizeFrameAncestors } from "./middlewarePolicy";
import { getAuthProvider, setAuthProviderForTests } from "./request";
import {
  InMemoryApprovalSource,
  PendingApprovalError,
  resetApprovalStateForTests,
  setApprovalSource,
  setBlockedActionSink,
  refreshApprovals,
} from "@/compliance/approvals";
import { PLATFORM_GATES } from "@/engines/platform/gates";

const TENANT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";

describe("rbac", () => {
  it("every role maps only to known permissions", () => {
    for (const r of ROLES) for (const p of ROLE_PERMISSIONS[r]) expect(PERMISSIONS).toContain(p);
  });

  it("only attorneys hold attorney-only permissions, whatever the grants", () => {
    for (const role of ROLES) {
      const perms = permissionsFor({ role, capabilities: ["conflicts_attorney", "bookkeeper"] });
      for (const p of ATTORNEY_ONLY) expect(perms.has(p)).toBe(role === "attorney");
    }
  });

  it("conflicts_attorney adds conflicts.clear for an attorney only", () => {
    expect(can({ role: "attorney", capabilities: [] }, "conflicts.clear")).toBe(false);
    expect(can({ role: "attorney", capabilities: ["conflicts_attorney"] }, "conflicts.clear")).toBe(true);
    expect(can({ role: "intake_staff", capabilities: ["conflicts_attorney"] }, "conflicts.clear")).toBe(false);
  });

  it("bookkeeper records trust entries but never approves disbursements", () => {
    const bk = { role: "intake_staff" as const, capabilities: ["bookkeeper" as const] };
    expect(can(bk, "trust.record")).toBe(true);
    expect(can(bk, "trust.approve_disbursement")).toBe(false);
    expect(can({ role: "read_only", capabilities: ["bookkeeper"] }, "trust.record")).toBe(false);
  });

  it("disabled users have no permissions; integration_service cannot write matters", () => {
    expect(permissionsFor({ role: "firm_admin", capabilities: [], status: "disabled" }).size).toBe(0);
    expect(can({ role: "integration_service", capabilities: [] }, "matters.write")).toBe(false);
  });

  it("validates capability grants", () => {
    const admin = { userId: USER, role: "firm_admin" as const, capabilities: [] };
    const ok = validateCapabilityGrant({
      granter: admin,
      grantee: { userId: "u2", role: "attorney", status: "active" },
      capability: "conflicts_attorney",
      reason: "Designated conflicts lawyer",
    });
    expect(ok).toEqual([]);
    expect(
      validateCapabilityGrant({ granter: admin, grantee: { userId: "u2", role: "intake_staff", status: "active" }, capability: "conflicts_attorney", reason: "x" })
    ).toHaveLength(1);
    expect(
      validateCapabilityGrant({ granter: admin, grantee: { userId: USER, role: "firm_admin", status: "active" }, capability: "bookkeeper", reason: "x" })
    ).toContain("Users cannot grant capabilities to themselves.");
    expect(
      validateCapabilityGrant({ granter: { userId: "a", role: "attorney", capabilities: [] }, grantee: { userId: "b", role: "attorney", status: "active" }, capability: "bookkeeper", reason: "" })
    ).toHaveLength(2);
    expect(validateCapabilityGrant({ granter: admin, grantee: { userId: "b", role: "attorney", status: "active" }, capability: "root", reason: "x" })).toEqual([
      "Unknown capability 'root'.",
    ]);
    expect(CAPABILITY_ELIGIBLE_ROLES.conflicts_attorney).toEqual(["attorney"]);
  });
});

describe("auth config", () => {
  it("keeps today's DEV_TENANT_ID flow as dev mode", () => {
    expect(resolveAuthConfig({ DEV_TENANT_ID: TENANT }).mode).toBe("dev");
    expect(resolveAuthConfig({ DEV_TENANT_ID: TENANT, NODE_ENV: "production" })).toMatchObject({ mode: "dev", insecure: true });
  });
  it("fails safe to none", () => {
    expect(resolveAuthConfig({}).mode).toBe("none");
    expect(resolveAuthConfig({ AUTH_PROVIDER: "dev" }).mode).toBe("none");
    expect(resolveAuthConfig({ AUTH_PROVIDER: "magic", DEV_TENANT_ID: TENANT }).mode).toBe("none");
    expect(resolveAuthConfig({ AUTH_PROVIDER: "clerk", DEV_TENANT_ID: TENANT }).mode).toBe("clerk");
  });
  it("extracts bearer tokens before the session cookie", () => {
    const req = (h: Record<string, string>, c: Record<string, string>) => ({ header: (n: string) => h[n], cookie: (n: string) => c[n] });
    expect(extractSessionToken(req({ authorization: "Bearer abc" }, { __session: "def" }))).toBe("abc");
    expect(extractSessionToken(req({}, { __session: "def" }))).toBe("def");
    expect(extractSessionToken(req({ authorization: "Basic x" }, {}))).toBeNull();
  });
});

// --- JWT with a real RSA key -------------------------------------------------

const ISSUER = "https://clerk.example.test";
let keyPair: CryptoKeyPair;
let publicJwk: JsonWebKey & { kid: string };

async function sign(claims: Record<string, unknown>, header: Record<string, unknown> = { alg: "RS256", kid: "k1" }) {
  const enc = (o: unknown) => base64UrlEncode(new TextEncoder().encode(JSON.stringify(o)));
  const input = `${enc(header)}.${enc(claims)}`;
  const sig = await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, keyPair.privateKey, new TextEncoder().encode(input));
  return `${input}.${base64UrlEncode(new Uint8Array(sig))}`;
}

const NOW = new Date("2026-09-30T15:00:00Z");
const nowSec = Math.floor(NOW.getTime() / 1000);

beforeEach(async () => {
  if (keyPair) return;
  keyPair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair;
  publicJwk = { ...(await crypto.subtle.exportKey("jwk", keyPair.publicKey)), kid: "k1" };
});

describe("jwt", () => {
  it("verifies a good token and rejects tampering", async () => {
    const claims = { sub: "user_1", iss: ISSUER, exp: nowSec + 60, tenant_id: TENANT };
    const token = await sign(claims);
    const getKey = async () => keyPair.publicKey;
    await expect(verifyJwt(token, { getKey, issuer: ISSUER, now: NOW })).resolves.toMatchObject({ sub: "user_1" });

    const [h, , s] = token.split(".");
    const forged = `${h}.${base64UrlEncode(new TextEncoder().encode(JSON.stringify({ ...claims, tenant_id: "other" })))}.${s}`;
    await expect(verifyJwt(forged, { getKey, issuer: ISSUER, now: NOW })).rejects.toMatchObject({ code: "bad_signature" });
  });

  it("rejects alg none / HS256 and unknown keys", async () => {
    const t = await sign({ sub: "x", iss: ISSUER, exp: nowSec + 60 }, { alg: "HS256", kid: "k1" });
    await expect(verifyJwt(t, { getKey: async () => keyPair.publicKey, issuer: ISSUER, now: NOW })).rejects.toMatchObject({ code: "bad_alg" });
    const t2 = await sign({ sub: "x", iss: ISSUER, exp: nowSec + 60 });
    await expect(verifyJwt(t2, { getKey: async () => null, issuer: ISSUER, now: NOW })).rejects.toMatchObject({ code: "unknown_key" });
    expect(() => decodeJwt("a.b")).toThrow(JwtError);
  });

  it("checks expiry, nbf, issuer, azp", () => {
    const base = { sub: "x", iss: ISSUER, exp: nowSec + 60 };
    expect(() => checkClaims({ ...base, exp: nowSec - 10 }, { issuer: ISSUER, now: NOW })).toThrow(/expired/);
    expect(() => checkClaims({ ...base, nbf: nowSec + 60 }, { issuer: ISSUER, now: NOW })).toThrow(/not valid yet/);
    expect(() => checkClaims({ ...base, iss: "https://evil" }, { issuer: ISSUER, now: NOW })).toThrow(/issuer/);
    expect(() => checkClaims({ ...base, azp: "https://evil" }, { issuer: ISSUER, now: NOW, authorizedParties: ["https://app"] })).toThrow(/origin/);
    expect(() => checkClaims({ iss: ISSUER, exp: nowSec + 60 }, { issuer: ISSUER, now: NOW })).toThrow(/subject/);
  });
});

describe("providers", () => {
  const fakeFetch = async () => ({ ok: true, status: 200, json: async () => ({ keys: [publicJwk] }) });
  const cfg = { issuer: ISSUER, jwksUrl: `${ISSUER}/.well-known/jwks.json`, authorizedParties: [], tenantClaim: "tenant_id" };
  const reqWith = (token?: string) => ({ header: (n: string) => (n === "authorization" && token ? `Bearer ${token}` : null), cookie: () => null });

  it("clerk: identity carries the signed tenant claim", async () => {
    const p = new ClerkAuthProvider(cfg, fakeFetch);
    const token = await sign({ sub: "user_1", iss: ISSUER, exp: nowSec + 60, tenant_id: TENANT, sid: "sess_1" });
    await expect(p.authenticate(reqWith(token), NOW)).resolves.toMatchObject({ provider: "clerk", subject: "user_1", tenantId: TENANT, sessionId: "sess_1" });
    await expect(p.authenticate(reqWith(), NOW)).resolves.toBeNull();
  });

  it("clerk: a token without a UUID tenant claim is forbidden; a bad one is 401", async () => {
    const p = new ClerkAuthProvider(cfg, fakeFetch);
    const noTenant = await sign({ sub: "user_1", iss: ISSUER, exp: nowSec + 60 });
    await expect(p.authenticate(reqWith(noTenant), NOW)).rejects.toMatchObject({ status: 403, code: "no_tenant_claim" });
    const expired = await sign({ sub: "user_1", iss: ISSUER, exp: nowSec - 100, tenant_id: TENANT });
    await expect(p.authenticate(reqWith(expired), NOW)).rejects.toMatchObject({ status: 401 });
  });

  it("dev provider returns DEV_TENANT_ID", async () => {
    await expect(new DevAuthProvider({ DEV_TENANT_ID: TENANT }).authenticate()).resolves.toMatchObject({ tenantId: TENANT, subject: "dev" });
    await expect(new DevAuthProvider({}).authenticate()).rejects.toBeInstanceOf(AuthError);
  });
});

describe("principal", () => {
  const identity = { provider: "clerk", subject: "user_1", tenantId: TENANT };
  const user = { id: USER, tenantId: TENANT, email: "a@firm.test", displayName: "A", role: "attorney" as const, status: "active" };

  it("builds permissions from role + capabilities, ignoring unknown capabilities", () => {
    const p = buildPrincipal({ identity, user, capabilities: ["conflicts_attorney", "nonsense"] });
    expect(p.capabilities).toEqual(["conflicts_attorney"]);
    expect(p.permissions).toContain("conflicts.clear");
    expect(actorFor(p)).toEqual({ type: "user", userId: USER });
  });

  it("refuses disabled users and cross-tenant rows", () => {
    expect(() => buildPrincipal({ identity, user: { ...user, status: "disabled" }, capabilities: [] })).toThrow(/disabled/);
    expect(() => buildPrincipal({ identity, user: { ...user, tenantId: "x" }, capabilities: [] })).toThrow(/different firm/);
  });

  it("synthetic dev principal defaults to firm_admin and logs as system", () => {
    const p = devPrincipal({ provider: "dev", subject: "dev", tenantId: TENANT }, { DEV_ROLE: "nope", DEV_CAPABILITIES: "bookkeeper, bogus" });
    expect(p.role).toBe("firm_admin");
    expect(p.capabilities).toEqual(["bookkeeper"]);
    expect(p.isDev).toBe(true);
    expect(actorFor(p)).toEqual({ type: "system" });
    expect(devPrincipal({ provider: "dev", subject: "dev", tenantId: TENANT }, { DEV_ROLE: "read_only" }).permissions).not.toContain("matters.write");
  });
});

describe("middleware policy", () => {
  const dev = resolveAuthConfig({ DEV_TENANT_ID: TENANT });
  const clerk = resolveAuthConfig({ AUTH_PROVIDER: "clerk" });
  const none = resolveAuthConfig({});

  it("classifies paths", () => {
    expect(classifyPath("/admin")).toBe("staff_page");
    expect(classifyPath("/admin/ops")).toBe("staff_page");
    expect(classifyPath("/administrator")).toBe("public");
    expect(classifyPath("/api/ops/attention")).toBe("staff_api");
    expect(classifyPath("/api/intake/sessions")).toBe("public");
    expect(classifyPath("/chat")).toBe("public");
    expect(classifyPath("/widget/frame.html")).toBe("widget_asset");
  });

  it("dev mode lets /admin and /chat through, tagged", () => {
    expect(decideMiddleware({ pathname: "/admin", config: dev, hasCredential: false })).toEqual({ action: "next", headers: { "x-auth-mode": "dev" } });
    expect(decideMiddleware({ pathname: "/chat", config: none, hasCredential: false }).action).toBe("next");
  });

  it("none mode refuses staff surfaces; clerk mode needs a credential", () => {
    expect(decideMiddleware({ pathname: "/api/admin/matters", config: none, hasCredential: true })).toMatchObject({ action: "deny", json: true });
    expect(decideMiddleware({ pathname: "/admin", config: clerk, hasCredential: false })).toMatchObject({ action: "deny", json: false });
    expect(decideMiddleware({ pathname: "/admin", config: clerk, hasCredential: false, signInUrl: "/sign-in" })).toMatchObject({
      action: "redirect",
      location: "/sign-in?redirect_url=%2Fadmin",
    });
    expect(decideMiddleware({ pathname: "/admin", config: clerk, hasCredential: true }).action).toBe("next");
  });

  it("sets frame-ancestors on widget assets, dropping junk", () => {
    const d = decideMiddleware({ pathname: "/widget/frame.html", config: dev, hasCredential: false, frameAncestors: "https://firm.com, https://*.firm.com javascript:alert(1) *" });
    expect(d.headers["content-security-policy"]).toBe("frame-ancestors 'self' https://firm.com https://*.firm.com");
    expect(normalizeFrameAncestors(undefined)).toBe("'self'");
  });
});

describe("vendor provider is gated on auth.vendor", () => {
  afterEach(() => {
    setAuthProviderForTests(null);
    resetApprovalStateForTests();
  });

  it("throws PendingApprovalError (-> 423) until founder + DPA approve", async () => {
    resetApprovalStateForTests();
    setBlockedActionSink(() => {});
    const env = { AUTH_PROVIDER: "clerk", CLERK_ISSUER: ISSUER };
    expect(() => getAuthProvider(env)).toThrow(PendingApprovalError);

    const src = new InMemoryApprovalSource();
    for (const reviewerKind of PLATFORM_GATES.authVendor.reviewers) {
      src.approve({ gateKey: "auth.vendor", reviewerKind, approvedByName: "test", approvedAt: new Date() });
    }
    setApprovalSource(src);
    await refreshApprovals();
    expect(getAuthProvider(env).name).toBe("clerk");
  });

  it("dev and none modes need no approval", () => {
    resetApprovalStateForTests();
    expect(getAuthProvider({ DEV_TENANT_ID: TENANT }).isDev).toBe(true);
    expect(() => getAuthProvider({})).toThrow(AuthError);
  });
});
