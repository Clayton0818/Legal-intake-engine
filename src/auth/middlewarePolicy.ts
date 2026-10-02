// c34/c38 — what src/middleware.ts does with each request. Pure and
// edge-safe: no database, no schema import.
//
// The middleware is only a COARSE first gate: in vendor mode it turns away
// staff requests that carry no session credential at all. Real verification
// (signature, tenant claim, linked active user, permissions, the auth.vendor
// approval) happens server-side in src/auth/request.ts, because the edge
// runtime can't read the approvals table.

import type { AuthConfig } from "./config";

export type PathClass = "staff_page" | "staff_api" | "widget_asset" | "public";

const STAFF_API_PREFIXES = ["/api/admin", "/api/ops", "/api/auth"];

export function classifyPath(pathname: string): PathClass {
  const p = pathname.toLowerCase();
  const under = (prefix: string) => p === prefix || p.startsWith(`${prefix}/`);
  if (STAFF_API_PREFIXES.some(under)) return "staff_api";
  if (under("/admin")) return "staff_page";
  if (under("/widget")) return "widget_asset";
  return "public";
}

export type MiddlewareDecision =
  | { action: "next"; headers: Record<string, string> }
  | { action: "deny"; status: 401; json: boolean; message: string; headers: Record<string, string> }
  | { action: "redirect"; location: string; headers: Record<string, string> };

/**
 * Pure: decide what to do with a request.
 * `frameAncestors` is the CSP frame-ancestors list for the widget frame.
 */
export function decideMiddleware(input: {
  pathname: string;
  config: AuthConfig;
  hasCredential: boolean;
  signInUrl?: string;
  frameAncestors?: string;
}): MiddlewareDecision {
  const cls = classifyPath(input.pathname);
  const modeHeader = input.config.mode === "dev" && input.config.insecure ? "dev-insecure" : input.config.mode;
  const headers: Record<string, string> = { "x-auth-mode": modeHeader };

  if (cls === "widget_asset") {
    headers["content-security-policy"] = `frame-ancestors ${normalizeFrameAncestors(input.frameAncestors)}`;
    return { action: "next", headers };
  }
  if (cls === "public") return { action: "next", headers };

  if (input.config.mode === "dev") return { action: "next", headers };

  const json = cls === "staff_api";
  if (input.config.mode === "none") {
    return { action: "deny", status: 401, json, message: "Staff sign-in is not configured for this deployment.", headers };
  }
  // clerk
  if (input.hasCredential) return { action: "next", headers };
  if (!json && input.signInUrl) {
    const sep = input.signInUrl.includes("?") ? "&" : "?";
    return {
      action: "redirect",
      location: `${input.signInUrl}${sep}redirect_url=${encodeURIComponent(input.pathname)}`,
      headers,
    };
  }
  return { action: "deny", status: 401, json, message: "Please sign in.", headers };
}

/**
 * Pure: sanitise the WIDGET_FRAME_ANCESTORS env value (space/comma separated
 * origins). Anything that isn't 'self', an https origin, or an https
 * one-level wildcard is dropped. Empty → 'self' only.
 */
export function normalizeFrameAncestors(value: string | undefined): string {
  const items = (value ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => s === "'self'" || /^https:\/\/(\*\.)?[a-z0-9.-]+(:\d+)?$/i.test(s) || /^http:\/\/localhost(:\d+)?$/i.test(s));
  const set = new Set(["'self'", ...items]);
  return [...set].join(" ");
}
