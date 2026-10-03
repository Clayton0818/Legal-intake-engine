// Calendar & deadline engine (calendar core): the firm's open limitation
// dates (c93) — soonest first, with verification state — plus the approvals
// this engine is waiting on. Shows no client facts beyond the claim label the
// lawyer typed; the staff console is not access-controlled yet (see
// ../layout.tsx), so detailed records stay behind the role-checked API.

import { gateStatus } from "@/compliance/approvals";
import { ensureServerApprovals } from "@/compliance/server";
import { CALENDAR_CORE_DEPENDENT_GATE_KEYS } from "@/engines/calendar-core/gates";
import { DRAFT_NOTICE } from "@/engines/calendar-core/templates/familyLawDrafts";

export const dynamic = "force-dynamic";

type OpenLimitation = { id: string; matterId: string; claimDescription: string; limitationDate: string; status: string; daysRemaining: number; needsVerification: boolean };

async function loadOpenLimitations(): Promise<{ rows: OpenLimitation[]; error: string | null }> {
  try {
    const [{ resolveRequestTenantId }, { withTenant }, { listOpenLimitations }] = await Promise.all([
      import("@/auth/request"),
      import("@/tenancy/withTenant"),
      import("@/engines/calendar-core/limitations/service"),
    ]);
    const tenantId = await resolveRequestTenantId();
    return { rows: await withTenant(tenantId, (tx) => listOpenLimitations(tx, tenantId)), error: null };
  } catch (err) {
    return { rows: [], error: err instanceof Error ? err.message : String(err) };
  }
}

function urgencyClass(days: number, needsVerification: boolean): string {
  if (days < 0 || days <= 7) return "bg-red-100 text-red-700";
  if (days <= 30 || needsVerification) return "bg-amber-100 text-amber-800";
  return "bg-slate-100 text-slate-700";
}

export default async function CalendarCoreAdminPage() {
  await ensureServerApprovals();
  const gates = CALENDAR_CORE_DEPENDENT_GATE_KEYS.map((key) => gateStatus(key));
  const { rows, error } = await loadOpenLimitations();
  const unverified = rows.filter((r) => r.needsVerification).length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-slate-900">Calendar: limitation dates</h1>
        <p className="mt-1 text-sm text-slate-600">
          {rows.length} open limitation date(s); {unverified} still waiting for an independent second check. Unverified dates are
          flagged every day, and reminders escalate as each date nears (real clock, weekends included).
        </p>
      </div>

      {error ? (
        <p className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">Could not load limitation dates: {error}</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50">
              <tr>
                <th className="px-4 py-2 text-left font-medium text-slate-600">Date</th>
                <th className="px-4 py-2 text-left font-medium text-slate-600">Days left</th>
                <th className="px-4 py-2 text-left font-medium text-slate-600">Claim</th>
                <th className="px-4 py-2 text-left font-medium text-slate-600">Verification</th>
                <th className="px-4 py-2 text-left font-medium text-slate-600">Matter</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-slate-500">No open limitation dates.</td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.id}>
                    <td className="whitespace-nowrap px-4 py-2 font-mono text-xs">{r.limitationDate}</td>
                    <td className="whitespace-nowrap px-4 py-2">
                      <span className={`rounded px-2 py-0.5 ${urgencyClass(r.daysRemaining, r.needsVerification)}`}>
                        {r.daysRemaining < 0 ? `passed ${-r.daysRemaining}d ago` : `${r.daysRemaining}d`}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-slate-800">{r.claimDescription}</td>
                    <td className="whitespace-nowrap px-4 py-2">
                      {r.needsVerification ? (
                        <span className="rounded bg-red-50 px-2 py-0.5 text-red-700">{r.status === "disputed" ? "Disputed" : "Not verified"}</span>
                      ) : (
                        <span className="rounded bg-emerald-50 px-2 py-0.5 text-emerald-700">Verified</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2">
                      <a className="text-sky-700 underline" href={`/admin/matters/${r.matterId}`}>Open matter</a>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      <section className="space-y-2">
        <h2 className="font-semibold text-slate-900">Approvals this engine depends on</h2>
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <tbody className="divide-y divide-slate-100">
              {gates.map((g) => (
                <tr key={g.gate.key}>
                  <td className="px-4 py-2 text-slate-800">{g.gate.description}</td>
                  <td className="whitespace-nowrap px-4 py-2 font-mono text-xs text-slate-500">{g.gate.key}</td>
                  <td className="whitespace-nowrap px-4 py-2">
                    {g.approved ? (
                      <span className="rounded bg-emerald-50 px-2 py-0.5 text-emerald-700">Approved</span>
                    ) : (
                      <span className="rounded bg-amber-50 px-2 py-0.5 text-amber-800">Waiting: {g.pendingReviewers.join(", ")}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-slate-500">
          Until approved, deadline calculations answer 423 and calendar sync is held. Lawyer-entered limitation dates, their
          verification and reminders are never blocked. Task-list and stage defaults: {DRAFT_NOTICE}
        </p>
      </section>
    </div>
  );
}
