// c38 — widget public keys and origin allowlists. Pure (node:crypto only).
//
// Key format:  wk_<tenant id, 32 hex, no dashes>_<32-char base64url secret>
// The key is NOT a secret — it sits in the firm's page source. It lets the
// server find the tenant without any cross-tenant lookup (the tenant id is in
// the key) and then the embed row by the secret's hash under RLS. The real
// control is the origin allowlist (plus the browser-enforced CSP
// frame-ancestors on the frame, set by src/middleware.ts).

import { createHash, randomBytes } from "node:crypto";

const KEY_RE = /^wk_([0-9a-f]{32})_([A-Za-z0-9_-]{32})$/;

export interface ParsedWidgetKey {
  tenantId: string;
  secret: string;
}

export function formatTenantId(hex32: string): string {
  return `${hex32.slice(0, 8)}-${hex32.slice(8, 12)}-${hex32.slice(12, 16)}-${hex32.slice(16, 20)}-${hex32.slice(20)}`;
}

export function parseWidgetKey(key: string | null | undefined): ParsedWidgetKey | null {
  const m = KEY_RE.exec((key ?? "").trim());
  if (!m) return null;
  return { tenantId: formatTenantId(m[1]!), secret: m[2]! };
}

export function hashWidgetSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/** A fresh key for a tenant. Returns the plaintext key (shown once) and the hash to store. */
export function generateWidgetKey(tenantId: string, random: (n: number) => Buffer = randomBytes): { key: string; keyHash: string } {
  const hex = tenantId.replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error("generateWidgetKey: tenantId must be a UUID.");
  const secret = random(24).toString("base64url");
  return { key: `wk_${hex}_${secret}`, keyHash: hashWidgetSecret(secret) };
}

/**
 * Pure: normalise an allowlist entry. Accepts 'https://firm.com',
 * 'https://*.firm.com' (one wildcard label), optional port, and
 * http://localhost for testing. Returns null for anything else.
 */
export function normalizeAllowedOrigin(entry: string): string | null {
  const e = entry.trim().toLowerCase().replace(/\/+$/, "");
  if (/^https:\/\/(\*\.)?([a-z0-9-]+\.)+[a-z0-9-]+(:\d{1,5})?$/.test(e)) return e;
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(e)) return e;
  return null;
}

export function validateAllowedOrigins(entries: readonly string[]): { origins: string[]; invalid: string[] } {
  const origins: string[] = [];
  const invalid: string[] = [];
  for (const raw of entries) {
    if (!raw.trim()) continue;
    const n = normalizeAllowedOrigin(raw);
    if (n) {
      if (!origins.includes(n)) origins.push(n);
    } else invalid.push(raw);
  }
  return { origins, invalid };
}

/** Pure: is `origin` covered by the allowlist? A wildcard matches exactly one extra label, never the bare domain. */
export function originAllowed(origin: string | null | undefined, allowed: readonly string[]): boolean {
  if (!origin) return false;
  let o: URL;
  try {
    o = new URL(origin);
  } catch {
    return false;
  }
  const originStr = `${o.protocol}//${o.host}`.toLowerCase();
  for (const entry of allowed) {
    if (!entry.includes("*")) {
      if (entry === originStr) return true;
      continue;
    }
    const m = /^(https?):\/\/\*\.([^/:]+)(:\d+)?$/.exec(entry);
    if (!m) continue;
    const [, scheme, base, port] = m;
    if (`${o.protocol}` !== `${scheme}:`) continue;
    if ((port ?? "") !== (o.port ? `:${o.port}` : "")) continue;
    const host = o.hostname.toLowerCase();
    const suffix = `.${base}`;
    if (host.endsWith(suffix) && !host.slice(0, -suffix.length).includes(".") && host.length > suffix.length) return true;
  }
  return false;
}
