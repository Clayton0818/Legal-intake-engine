// GET /api/admin/matters/[id]   — one matter's full detail, tenant-scoped.
// PATCH /api/admin/matters/[id] — updates ONLY `stage`, after validating the
//                                  new value is one of the matter_stage
//                                  enum's own values. No other field on
//                                  `matters` is writable through this route.
//
// Both handlers go through withTenant() per ADR-0001 §D5 — see the sibling
// list route's comment for why there's no other way to reach this table.
import { NextResponse } from "next/server";
import { getDevTenantId } from "@/tenancy/devTenant";
import { getMatterDetail, isMatterStage, updateMatterStage } from "@/app/admin/_lib/queries";

// withTenant (and, transitively, src/tenancy/db.ts) is imported lazily
// inside each handler, not statically at module scope. db.ts throws at
// import time if DATABASE_URL is unset, and `next build`'s "collecting
// page data" step actually loads every route module to inspect it — a
// static top-level import here would make DATABASE_URL a *build-time*
// requirement (CI's build step deliberately runs without it; see
// .github/workflows/ci.yml).

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  let tenantId: string;
  try {
    tenantId = getDevTenantId();
  } catch (error) {
    console.error(`[GET /api/admin/matters/${id}] tenant resolution failed:`, error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Tenant resolution failed." },
      { status: 500 }
    );
  }

  try {
    const { withTenant } = await import("@/tenancy/withTenant");
    const detail = await withTenant(tenantId, (tx) => getMatterDetail(tx, tenantId, id));
    if (!detail) {
      return NextResponse.json({ error: "Matter not found." }, { status: 404 });
    }
    return NextResponse.json(detail);
  } catch (error) {
    console.error(`[GET /api/admin/matters/${id}] query failed:`, error);
    return NextResponse.json({ error: "Failed to load matter." }, { status: 500 });
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be JSON." }, { status: 400 });
  }

  const stage = (body as { stage?: unknown } | null)?.stage;
  if (!isMatterStage(stage)) {
    return NextResponse.json(
      { error: "`stage` is required and must be one of the matter_stage enum's values." },
      { status: 400 }
    );
  }

  let tenantId: string;
  try {
    tenantId = getDevTenantId();
  } catch (error) {
    console.error(`[PATCH /api/admin/matters/${id}] tenant resolution failed:`, error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Tenant resolution failed." },
      { status: 500 }
    );
  }

  try {
    const { withTenant } = await import("@/tenancy/withTenant");
    const updated = await withTenant(tenantId, (tx) => updateMatterStage(tx, tenantId, id, stage));
    if (!updated) {
      return NextResponse.json({ error: "Matter not found." }, { status: 404 });
    }
    return NextResponse.json({ matter: updated });
  } catch (error) {
    console.error(`[PATCH /api/admin/matters/${id}] update failed:`, error);
    return NextResponse.json({ error: "Failed to update matter." }, { status: 500 });
  }
}
