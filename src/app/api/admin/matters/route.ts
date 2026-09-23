// GET /api/admin/matters — the matters queue, tenant-scoped.
//
// Per ADR-0001 §D5, ALL access to `matters` (and any other tenant-scoped
// table) goes through withTenant(). There is no other database handle
// exported from src/tenancy/, so there's no other way this route could
// query the table even if someone tried.
import { NextResponse } from "next/server";
import { getDevTenantId } from "@/tenancy/devTenant";
import { listMattersForTenant } from "@/app/admin/_lib/queries";

// withTenant (and, transitively, src/tenancy/db.ts) is imported lazily
// inside the handler, not statically at module scope. db.ts throws at
// import time if DATABASE_URL is unset, and `next build`'s "collecting
// page data" step actually loads every route module to inspect it — a
// static top-level import here would make DATABASE_URL a *build-time*
// requirement (CI's build step deliberately runs without it; see
// .github/workflows/ci.yml).

export const dynamic = "force-dynamic";

export async function GET() {
  let tenantId: string;
  try {
    tenantId = getDevTenantId();
  } catch (error) {
    console.error("[GET /api/admin/matters] tenant resolution failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Tenant resolution failed." },
      { status: 500 }
    );
  }

  try {
    const { withTenant } = await import("@/tenancy/withTenant");
    const matterRows = await withTenant(tenantId, (tx) => listMattersForTenant(tx, tenantId));
    return NextResponse.json({ matters: matterRows });
  } catch (error) {
    console.error("[GET /api/admin/matters] query failed:", error);
    return NextResponse.json({ error: "Failed to load matters." }, { status: 500 });
  }
}
