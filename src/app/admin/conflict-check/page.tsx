// Conflict-check engine: what is still waiting for review before the engine
// can apply a rule, send a letter or call a vendor.
//
// Deliberately shows NO party names, hits or decisions: the staff console is
// not access-controlled yet (see ../layout.tsx), and conflict records are for
// the conflicts role only (c56 rule 3, c63 rule 1). Those are served by the
// role-checked API under /api/conflict-check.

import { gateStatus } from "@/compliance/approvals";
import { RULE_GATES, VENDOR_GATES } from "@/compliance/gates";
import { ensureServerApprovals } from "@/compliance/server";
import { CONFLICT_GATE_KEYS } from "@/engines/conflict-check/gates";
import { IMPORT_FIELDS, IMPORT_RECORD_TYPES } from "@/engines/conflict-check/historyImport";

export const dynamic = "force-dynamic";

const SHARED_GATE_KEYS = [
  RULE_GATES.conflictRules.key,
  RULE_GATES.retentionPeriods.key,
  VENDOR_GATES.esignature.key,
  VENDOR_GATES.email.key,
];

export default async function ConflictCheckAdminPage() {
  await ensureServerApprovals();
  const rows = [...CONFLICT_GATE_KEYS, ...SHARED_GATE_KEYS].map((key) => gateStatus(key));
  const pending = rows.filter((r) => !r.approved).length;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-slate-900">Conflict check: approvals</h1>
        <p className="mt-1 text-sm text-slate-600">
          {pending} of {rows.length} items this engine depends on are still waiting for review. Until then the engine shows a
          visible placeholder or blocks the action and logs it; a conflicts attorney still decides every possible conflict.
        </p>
      </div>
      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50">
            <tr>
              <th className="px-4 py-2 text-left font-medium text-slate-600">What</th>
              <th className="px-4 py-2 text-left font-medium text-slate-600">Gate</th>
              <th className="px-4 py-2 text-left font-medium text-slate-600">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((r) => (
              <tr key={r.gate.key}>
                <td className="px-4 py-2 text-slate-800">{r.gate.description}</td>
                <td className="whitespace-nowrap px-4 py-2 font-mono text-xs text-slate-500">{r.gate.key}</td>
                <td className="whitespace-nowrap px-4 py-2">
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
      </div>
      <section className="rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-700">
        <h2 className="font-semibold text-slate-900">History import (before checks go live)</h2>
        <p className="mt-1">
          Until the firm&apos;s past clients, matters and declined consultations are imported and a conflicts attorney confirms the
          import, no check can come back clear.
        </p>
        <ol className="mt-2 list-decimal space-y-1 pl-5">
          <li>
            Download the <a className="text-sky-700 underline" href="/api/conflict-check/imports/template">CSV template</a> or export from
            the old system. Columns recognised: <span className="font-mono text-xs">{IMPORT_FIELDS.join(", ")}</span>.
          </li>
          <li>
            Upload it (<code>POST /api/conflict-check/imports</code>) to see what will be imported and which lines fail, and why.
            Record types: <span className="font-mono text-xs">{IMPORT_RECORD_TYPES.join(", ")}</span>.
          </li>
          <li>Commit the import (<code>POST /api/conflict-check/imports/&lt;id&gt;</code> with action commit). Look-alikes become merge suggestions.</li>
          <li>
            Confirm the history is complete (<code>POST /api/conflict-check/settings</code> with action confirm_history_import), by a
            conflicts attorney.
          </li>
        </ol>
      </section>
      <p className="text-xs text-slate-500">
        Reviewers record approvals with <code>npm run compliance -- approve --gate &lt;key&gt; --reviewer &lt;kind&gt; --by &quot;&lt;name&gt;&quot;</code>.
      </p>
    </div>
  );
}
