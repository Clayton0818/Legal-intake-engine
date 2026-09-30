// c34 — minimal RS256 JWT verification on WebCrypto (Node 20+ and the edge
// runtime both provide crypto.subtle), so the vendor adapter needs no SDK
// dependency. We VERIFY vendor-issued tokens; we never issue our own
// (ADR-0001 D8: never roll our own auth).

export class JwtError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "JwtError";
  }
}

export interface JwtHeader {
  alg: string;
  kid?: string;
  typ?: string;
}

export type JwtClaims = Record<string, unknown> & {
  sub?: string;
  iss?: string;
  aud?: string | string[];
  azp?: string;
  exp?: number;
  nbf?: number;
  iat?: number;
  sid?: string;
};

export interface VerifyOptions {
  /** Resolve the verification key for a kid (JWKS lookup). */
  getKey(kid: string | undefined): Promise<CryptoKey | null>;
  issuer: string;
  audience?: string;
  /** Allowed `azp` values (Clerk's authorized parties). Empty = not checked. */
  authorizedParties?: readonly string[];
  now?: Date;
  clockSkewSeconds?: number;
}

export function base64UrlDecode(input: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(input)) throw new JwtError("malformed", "Token is not base64url.");
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((input.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function parseJson<T>(bytes: Uint8Array, what: string): T {
  try {
    const v = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
    return v as T;
  } catch {
    throw new JwtError("malformed", `Token ${what} is not a JSON object.`);
  }
}

/** Split and decode WITHOUT verifying (used only to read the header's kid). Pure. */
export function decodeJwt(token: string): { header: JwtHeader; claims: JwtClaims; signingInput: string; signature: Uint8Array } {
  const parts = token.split(".");
  if (parts.length !== 3) throw new JwtError("malformed", "Token must have three parts.");
  const [h, p, s] = parts as [string, string, string];
  return {
    header: parseJson<JwtHeader>(base64UrlDecode(h), "header"),
    claims: parseJson<JwtClaims>(base64UrlDecode(p), "payload"),
    signingInput: `${h}.${p}`,
    signature: base64UrlDecode(s),
  };
}

/** Pure: time/issuer/audience/azp checks on already-verified claims. */
export function checkClaims(claims: JwtClaims, opts: Omit<VerifyOptions, "getKey">): void {
  const now = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  const skew = opts.clockSkewSeconds ?? 5;
  if (typeof claims.exp !== "number") throw new JwtError("no_exp", "Token has no expiry.");
  if (now > claims.exp + skew) throw new JwtError("expired", "Session has expired.");
  if (typeof claims.nbf === "number" && now + skew < claims.nbf) throw new JwtError("not_yet_valid", "Token is not valid yet.");
  if (claims.iss !== opts.issuer) throw new JwtError("bad_issuer", "Token issuer is not trusted.");
  if (opts.audience !== undefined) {
    const aud = Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : [];
    if (!aud.includes(opts.audience)) throw new JwtError("bad_audience", "Token audience does not match.");
  }
  if (opts.authorizedParties && opts.authorizedParties.length > 0) {
    if (!claims.azp || !opts.authorizedParties.includes(claims.azp)) {
      throw new JwtError("bad_azp", "Token was issued for a different origin.");
    }
  }
  if (typeof claims.sub !== "string" || !claims.sub) throw new JwtError("no_sub", "Token has no subject.");
}

/** Verify an RS256 JWT. Throws JwtError on any problem; never returns unverified claims. */
export async function verifyJwt(token: string, opts: VerifyOptions): Promise<JwtClaims> {
  const { header, claims, signingInput, signature } = decodeJwt(token);
  if (header.alg !== "RS256") throw new JwtError("bad_alg", `Unsupported token algorithm '${header.alg}'.`);
  const key = await opts.getKey(header.kid);
  if (!key) throw new JwtError("unknown_key", "Token signing key is not recognised.");
  const ok = await crypto.subtle.verify(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    signature as unknown as ArrayBuffer,
    new TextEncoder().encode(signingInput)
  );
  if (!ok) throw new JwtError("bad_signature", "Token signature is invalid.");
  checkClaims(claims, opts);
  return claims;
}

export async function importRsaJwk(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
}
