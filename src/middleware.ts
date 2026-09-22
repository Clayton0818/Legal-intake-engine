import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// AUTH STUB — not real authentication. ADR-0001 §D8 specifies a managed
// auth provider (Clerk to start; WorkOS if enterprise SSO appears early)
// and explicitly says "never roll our own." This file exists so the
// module boundary and request path are in place — where auth middleware
// will actually run — without pretending to provide security it doesn't.
//
// Right now this only tags every request with a header identifying it as
// unauthenticated, so nothing downstream can accidentally treat a request
// as authenticated just because this file exists. Replace the body of this
// function with real Clerk (or WorkOS) middleware before any route here
// reads or writes matter data — do not build application routes that trust
// a caller's identity against this stub.
export function middleware(_request: NextRequest) {
  const response = NextResponse.next();
  response.headers.set("x-auth-stub", "unauthenticated");
  return response;
}

export const config = {
  // Skip static assets and the health check, which must stay reachable
  // without any auth machinery in front of it.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/health).*)"],
};
