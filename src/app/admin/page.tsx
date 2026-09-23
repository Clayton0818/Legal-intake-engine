// Matters queue (board card c24). Tenant-scoped via withTenant() +
// getDevTenantId() per ADR-0001 §D5 — see src/tenancy/devTenant.ts for why
// this is a temporary stand-in for real auth rather than a new mechanism.
import Link from "next/link";
import { getDevTenantId } from "@/tenancy/devTenant";
import { listMattersForTenant } from "./_lib/queries";
import { formatDate, formatEnumLabel, stageBadgeClass } from "./_lib/format";

// Tenant-scoped data must never be served from Next's static/full route
// cache — a cached response for one firm must not be reused for another,
// and dev-tenant data can change between requests regardless.
export const dynamic = "force-dynamic";

export default async function AdminHome() {
  const tenantId = getDevTenantId();
  // withTenant (and, transitively, src/tenancy/db.ts) is imported lazily,
  // not statically at module scope. db.ts throws at import time if
  // DATABASE_URL is unset, and `next build`'s "collecting page data" step
  // actually loads every route/page module to inspect it — a static
  // top-level import here would make DATABASE_URL a *build-time*
  // requirement (CI's build step deliberately runs without it; see
  // .github/workflows/ci.yml).
  const { withTenant } = await import("@/tenancy/withTenant");
  const matterRows = await withTenant(tenantId, (tx) => listMattersForTenant(tx, tenantId));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">Matters queue</h1>
          <p className="mt-1 text-sm text-slate-600">
            {matterRows.length} matter{matterRows.length === 1 ? "" : "s"} for this firm.
          </p>
        </div>
        <Link href="/admin/insights" className="text-sm text-slate-500 hover:underline">
          View insights →
        </Link>
      </div>

      {matterRows.length === 0 ? (
        <div className="rounded-lg border border-slate-200 bg-white p-6 text-sm text-slate-600">
          No matters yet.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50">
              <tr>
                <th className="px-4 py-2 text-left font-medium text-slate-600">Party</th>
                <th className="px-4 py-2 text-left font-medium text-slate-600">Practice area</th>
                <th className="px-4 py-2 text-left font-medium text-slate-600">Stage</th>
                <th className="px-4 py-2 text-left font-medium text-slate-600">Opened</th>
                <th className="px-4 py-2 text-left font-medium text-slate-600">Assigned to</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {matterRows.map((matter) => (
                <tr key={matter.id} className="hover:bg-slate-50">
                  <td className="whitespace-nowrap px-4 py-2">
                    <Link
                      href={`/admin/matters/${matter.id}`}
                      className="font-medium text-slate-900 hover:underline"
                    >
                      {matter.partyName ?? "Unknown party"}
                    </Link>
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 text-slate-700">
                    {matter.practiceArea ?? "—"}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${stageBadgeClass(matter.stage)}`}
                    >
                      {formatEnumLabel(matter.stage)}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 text-slate-700">
                    {formatDate(matter.openedAt)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 text-slate-700">
                    {matter.assignedUserName ?? "Unassigned"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
