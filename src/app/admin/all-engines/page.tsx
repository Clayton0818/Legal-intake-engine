// All-engines (cross-cutting) console: permissions (c99), practice areas
// (c102) and the Family Law pack (c103), plus everything this engine is
// still waiting on from reviewers.

import Link from "next/link";
import { gateStatus } from "@/compliance/approvals";
import { ensureServerApprovals } from "@/compliance/server";
import { ALL_ENGINES_GATE_KEYS, ALL_ENGINES_SHARED_GATE_KEYS, FAMILY_RULE_GATES } from "@/engines/all-engines/gates";

export const dynamic = "force-dynamic";

export default async function AllEnginesAdminPage() {
  await ensureServerApprovals();
  const ruleRows = [...Object.values(FAMILY_RULE_GATES).map((g) => g.key), ...ALL_ENGINES_SHARED_GATE_KEYS].map((k) => gateStatus(k));
  const copyKeys = ALL_ENGINES_GATE_KEYS.filter((k) => k.startsWith("copy."));
  const copyPending = copyKeys.filter((k) => !gateStatus(k).approved).length;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-slate-900">Firm-wide settings</h1>
        <p className="mt-1 text-sm text-slate-600">Who can do what, and which practice areas the firm offers.</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Link href="/admin/all-engines/permissions" className="rounded-lg border border-slate-200 bg-white p-4 hover:border-slate-400">
          <div className="font-medium text-slate-900">Permissions</div>
          <div className="mt-1 text-sm text-slate-600">Role × right matrix, who holds which role, and the change log.</div>
        </Link>
        <Link href="/admin/all-engines/practice-areas" className="rounded-lg border border-slate-200 bg-white p-4 hover:border-slate-400">
          <div className="font-medium text-slate-900">Practice areas</div>
          <div className="mt-1 text-sm text-slate-600">Switch areas on or off and review pack updates.</div>
        </Link>
      </div>
      <section className="rounded-lg border border-slate-200 bg-white p-4 text-sm">
        <h2 className="font-semibold text-slate-900">Waiting for review</h2>
        <p className="mt-1 text-slate-600">
          {copyPending} of {copyKeys.length} client-facing Family Law sentences still show a visible placeholder until an attorney approves them.
          Texas rule tools below stay blocked until approved.
        </p>
        <table className="mt-3 min-w-full divide-y divide-slate-200">
          <tbody className="divide-y divide-slate-100">
            {ruleRows.map((r) => (
              <tr key={r.gate.key}>
                <td className="py-1.5 pr-4 text-slate-800">{r.gate.description}</td>
                <td className="whitespace-nowrap py-1.5 pr-4 font-mono text-xs text-slate-500">{r.gate.key}</td>
                <td className="whitespace-nowrap py-1.5">
                  {r.approved ? (
                    <span className="rounded bg-emerald-50 px-2 py-0.5 text-emerald-700">Approved</span>
                  ) : (
                    <span className="rounded bg-amber-50 px-2 py-0.5 text-amber-800">Waiting: {r.pendingReviewers.join(", ")}</span>
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
