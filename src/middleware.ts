import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { extractSessionToken, resolveAuthConfig } from "@/auth/config";
import { decideMiddleware } from "@/auth/middlewarePolicy";

// c34 — the coarse edge gate in front of staff surfaces. See
// src/auth/middlewarePolicy.ts for the rules. This is NOT the authorisation
// check: route handlers and pages resolve the session and permissions
// server-side (src/auth/request.ts), including the 'auth.vendor' approval
// gate. In dev mode (DEV_TENANT_ID, today's flow) requests pass through and
// are tagged `x-auth-mode: dev`, so nothing downstream mistakes them for
// authenticated vendor sessions.
export function middleware(request: NextRequest) {
  const config = resolveAuthConfig(process.env);
  const decision = decideMiddleware({
    pathname: request.nextUrl.pathname,
    config,
    hasCredential: Boolean(
      extractSessionToken({
        header: (n) => request.headers.get(n),
        cookie: (n) => request.cookies.get(n)?.value,
      })
    ),
    signInUrl: process.env.AUTH_SIGN_IN_URL,
    frameAncestors: process.env.WIDGET_FRAME_ANCESTORS,
  });

  let response: NextResponse;
  if (decision.action === "redirect") {
    response = NextResponse.redirect(new URL(decision.location, request.url));
  } else if (decision.action === "deny") {
    response = decision.json
      ? NextResponse.json({ error: decision.message }, { status: decision.status })
      : new NextResponse(decision.message, { status: decision.status, headers: { "content-type": "text/plain" } });
  } else {
    response = NextResponse.next();
  }
  for (const [k, v] of Object.entries(decision.headers)) response.headers.set(k, v);
  return response;
}

export const config = {
  // Skip static build assets and the health check, which must stay reachable
  // without any auth machinery in front of it.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/health).*)"],
};
