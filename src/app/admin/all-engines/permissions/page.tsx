// c99 — the firm's permission matrix, role holders and the change log.
// Read here; changed through /api/all-engines/** (permissions.manage, logged).

import { FIRM_ROLES, ROLE_INFO, type RightArea } from "@/engines/all-engines/permissions/policy";
import { withStaff } from "../_lib/load";
import { MatrixCell } from "./matrix-cell";

export const dynamic = "force-dynamic";

const AREA_LABEL: Record<RightArea, string> = {
  matters: "Matters",
  intake: "Intake",
  contacts: "Contacts",
  conflicts: "Conflicts",
  documents: "Documents",
  calendar: "Calendar, tasks and flags",
  billing: "Billing",
  trust: "Trust",
  reports: "Reports",
  administration: "Administration",
  portal: "Client portal",
};

function fmt(d: Date | string): string {
  return new Date(d).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

export default async function PermissionsPage() {
  const { data, error } = await withStaff("permissions", async ({ tx, tenantId, staff }) => {
    const { getPermissionMatrix, listRoleHolders, listAccessChanges } = await import("@/engines/all-engines/permissions/service");
    return {
      ...(await getPermissionMatrix(tx, tenantId, staff)),
      holders: await listRoleHolders(tx, tenantId, staff),
      log: await listAccessChanges(tx, tenantId, staff, { limit: 30 }),
    };
  });
  if (!data) return <p className="text-sm text-red-700">{error}</p>;

  let lastArea: string | null = null;
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-slate-900">Permissions</h1>
        <p className="mt-1 text-sm text-slate-600">
          ✓ = the role holds the right. <span className="font-semibold text-sky-700">Blue</span> = given by the firm,{" "}
          <span className="font-semibold text-rose-700">red</span> = removed by the firm. Click a cell to change it (a reason is required and
          the change is logged). Greyed cells are fixed for safety: legal decisions stay with lawyers, trust reconciliation with the
          bookkeeper and owner, the party index with the conflicts role, and an ethical screen always wins.
        </p>
      </div>
      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50">
            <tr>
              <th className="px-3 py-2 text-left font-medium text-slate-600">Right</th>
              {FIRM_ROLES.map((r) => (
                <th key={r} className="px-2 py-2 text-center font-medium text-slate-600" title={ROLE_INFO[r].description}>
                  {ROLE_INFO[r].label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {data.matrix.flatMap((row) => {
              const rows = [];
              if (row.right.area !== lastArea) {
                lastArea = row.right.area;
                rows.push(
                  <tr key={`area-${row.right.area}`} className="bg-slate-50/60">
                    <td colSpan={FIRM_ROLES.length + 1} className="px-3 py-1 text-xs font-semibold uppercase text-slate-500">
                      {AREA_LABEL[row.right.area]}
                    </td>
                  </tr>
                );
              }
              rows.push(
                <tr key={row.right.key}>
                  <td className="px-3 py-1.5">
                    <div className="text-slate-800">{row.right.label}</div>
                    <div className="text-xs text-slate-500">{row.right.description}</div>
                  </td>
                  {row.cells.map((c) => (
                    <td key={c.role} className="px-2 py-1.5 text-center">
                      <MatrixCell role={c.role} right={c.right} effective={c.effective} byDefault={c.byDefault} source={c.source} editable={c.editable} note={c.note} />
                    </td>
                  ))}
                </tr>
              );
              return rows;
            })}
          </tbody>
        </table>
      </div>

      <section className="rounded-lg border border-slate-200 bg-white p-4 text-sm">
        <h2 className="font-semibold text-slate-900">Who holds which role</h2>
        <p className="mt-1 text-slate-600">
          Roles from the account type (admin, lawyer, intake staff, read only) are changed in user management; owner, paralegal, bookkeeper and
          conflicts-attorney roles are assigned with <code>POST /api/all-engines/roles</code>.
        </p>
        <table className="mt-2 min-w-full">
          <tbody className="divide-y divide-slate-100">
            {data.holders.map((h) => (
              <tr key={h.userId}>
                <td className="py-1.5 pr-4 text-slate-800">{h.displayName}</td>
                <td className="py-1.5 pr-4 text-slate-500">{h.status}</td>
                <td className="py-1.5 text-slate-700">{h.roles.map((r) => ROLE_INFO[r].label).join(", ") || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-4 text-sm">
        <h2 className="font-semibold text-slate-900">Recent changes (append-only log)</h2>
        {data.log.length === 0 ? (
          <p className="mt-1 text-slate-500">No changes yet.</p>
        ) : (
          <ul className="mt-2 space-y-1">
            {data.log.map((l) => (
              <li key={l.id} className="text-slate-700">
                <span className="text-slate-500">{fmt(l.occurredAt)}</span> · <span className="font-mono text-xs">{l.action}</span>
                {l.role ? ` · ${l.role}` : ""}
                {l.right ? ` · ${l.right}` : ""}
                {l.practiceArea ? ` · ${l.practiceArea}` : ""}
                {l.reason ? ` — “${l.reason}”` : ""}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
