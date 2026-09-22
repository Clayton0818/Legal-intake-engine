import { NextResponse } from "next/server";

// Deliberately does NOT touch the database. A health check that depends on
// a DB round-trip turns "the database is briefly slow" into "the whole
// service reports unhealthy," which is the wrong failure mode for a load
// balancer / Render health check to act on. If a DB-connectivity check is
// ever needed, it belongs at a separate route (e.g. /api/health/db) that
// alerting can treat differently from this one.
export async function GET() {
  return NextResponse.json({
    status: "ok",
    service: "legal-intake-engine",
    timestamp: new Date().toISOString(),
  });
}
