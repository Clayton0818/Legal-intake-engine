// c102 — practice areas the firm offers, and pack versions to review.

import Link from "next/link";
import { withStaff } from "../_lib/load";
import { AcceptUpdate, AreaSwitches } from "./area-switches";

export const dynamic = "force-dynamic";

export default async function PracticeAreasPage() {
  const { data, error } = await withStaff("practice-areas", async ({ tx, tenantId, staff }) => {
    const { getPracticeAreaOverview } = await import("@/engines/all-engines/practiceAreas/service");
    return getPracticeAreaOverview(tx, tenantId, staff);
  });
  if (!data) return <p className="text-sm text-red-700">{error}</p>;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-slate-900">Practice areas</h1>
        <p className="mt-1 text-sm text-slate-600">
          Only switched-on areas appear to clients and staff. Switching an area off never deletes or changes existing matters; it only stops new
          ones, and new inquiries in that area are declined politely with a referral. Owner or firm admin only; every change is logged.
        </p>
      </div>
      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <AreaSwitches areas={data.map((a) => ({ id: a.id, label: a.label, enabled: a.enabled, packAvailable: a.packAvailable, openMatters: a.openMatters }))} />
      </section>
      <section className="rounded-lg border border-slate-200 bg-white p-4 text-sm">
        <h2 className="font-semibold text-slate-900">Pack versions</h2>
        <table className="mt-2 min-w-full">
          <thead>
            <tr className="text-left text-slate-500">
              <th className="py-1 pr-4 font-medium">Area</th>
              <th className="py-1 pr-4 font-medium">Accepted</th>
              <th className="py-1 pr-4 font-medium">Available</th>
              <th className="py-1 font-medium">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {data.map((a) => (
              <tr key={a.id} className="align-top">
                <td className="py-1.5 pr-4">
                  {a.packAvailable ? (
                    <Link className="text-sky-700 underline" href={`/admin/all-engines/practice-areas/${a.id}`}>
                      {a.label}
                    </Link>
                  ) : (
                    a.label
                  )}
                </td>
                <td className="py-1.5 pr-4">{a.acceptedVersion ?? "—"}</td>
                <td className="py-1.5 pr-4">{a.latestVersion ?? "not yet"}</td>
                <td className="py-1.5">
                  {a.state === "update_available" && a.latestVersion && a.latestContentHash ? (
                    <div className="space-y-1">
                      <div className="text-amber-800">Update to review:</div>
                      <ul className="list-disc pl-5 text-slate-700">
                        {a.changes.map((c) => (
                          <li key={c.section}>
                            {c.section}: {c.added.length} added, {c.removed.length} removed, {c.changed.length} changed
                          </li>
                        ))}
                      </ul>
                      <AcceptUpdate area={a.id} version={a.latestVersion} contentHash={a.latestContentHash} />
                    </div>
                  ) : a.state === "current" ? (
                    <span className="text-emerald-700">Up to date</span>
                  ) : a.state === "not_accepted" ? (
                    <span className="text-slate-600">Accepted when switched on</span>
                  ) : (
                    <span className="text-slate-500">No pack yet</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
