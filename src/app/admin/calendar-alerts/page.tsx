// Calendar & deadline engine (alerts): the firm's attention numbers — reply
// clocks (c43/c44), overdue work (c45), client chases (c42/c46), stalls
// (c47), court notices (c64), drafted updates (c54) and matter health (c53) —
// plus every approval gate this engine waits on. Counts only: the staff
// console is not access-controlled yet (see ../layout.tsx), so records stay
// behind the role-checked API under /api/calendar-alerts. Internal only;
// nothing here is ever shown to a client.

import { gateStatus } from "@/compliance/approvals";
import { ensureServerApprovals } from "@/compliance/server";
import { ALERT_GATE_KEYS, ALERT_SHARED_GATE_KEYS } from "@/engines/calendar-alerts/gates";
import type { AlertSummary } from "@/engines/calendar-alerts/summary";

export const dynamic = "force-dynamic";

async function loadSummary(): Promise<{ summary: AlertSummary | null; error: string | null }> {
  try {
    const [{ resolveRequestTenantId }, { withTenant }, { alertSummary }] = await Promise.all([
      import("@/auth/request"),
      import("@/tenancy/withTenant"),
      import("@/engines/calendar-alerts/summary"),
    ]);
    const tenantId = await resolveRequestTenantId();
    return { summary: await withTenant(tenantId, (tx) => alertSummary(tx, tenantId, new Date())), error: null };
  } catch (err) {
    return { summary: null, error: err instanceof Error ? err.message : String(err) };
  }
}

function Tile({ label, value, tone, hint }: { label: string; value: number; tone: "red" | "amber" | "slate"; hint: string }) {
  const colour = value === 0 ? "border-slate-200 bg-white" : tone === "red" ? "border-red-200 bg-red-50" : tone === "amber" ? "border-amber-200 bg-amber-50" : "border-slate-200 bg-white";
  return (
    <div className={`rounded-lg border p-4 ${colour}`}>
      <div className="text-2xl font-semibold text-slate-900">{value}</div>
      <div className="text-sm font-medium text-slate-700">{label}</div>
      <div className="mt-1 text-xs text-slate-500">{hint}</div>
    </div>
  );
}

export default async function CalendarAlertsAdminPage() {
  await ensureServerApprovals();
  const gates = [...ALERT_GATE_KEYS, ...ALERT_SHARED_GATE_KEYS].map((key) => gateStatus(key));
  const { summary, error } = await loadSummary();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-slate-900">Alerts and client communication</h1>
        <p className="mt-1 text-sm text-slate-600">
          Internal only. Reply targets and overdue work count the firm&apos;s business hours; court notices and deadline safety nets run on
          the real clock, nights and weekends included. Nothing here takes a legal step on its own.
        </p>
      </div>

      {error || !summary ? (
        <p className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">Could not load the alert summary: {error}</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Tile label="Court emails not acknowledged" value={summary.courtNoticesUnacknowledged} tone="red" hint="c64 — escalates to the backup lawyer, then owner/admin" />
            <Tile label="Court emails to file to a matter" value={summary.courtNoticesUnmatched} tone="amber" hint="c64 admin queue" />
            <Tile label="Possible fake court emails" value={summary.possiblePhishing} tone="amber" hint="c64 — not treated as notices" />
            <Tile label="Overdue deadline tasks" value={summary.overdueDeadlineTasks} tone="red" hint="c45 — real clock, no grace" />
            <Tile label="Open reply clocks" value={summary.openReplyClocks} tone="slate" hint="c43/c44" />
            <Tile label="Client promises missed" value={summary.promisesMissed} tone="red" hint="c43/c44 — the client is not told" />
            <Tile label="Overdue firm tasks" value={summary.overdueTasks} tone="amber" hint="c45" />
            <Tile label="Client chases running" value={summary.activeClientChases} tone="slate" hint="c42/c46 — neutral reminders, then the lawyer decides" />
            <Tile label="Stalled items" value={summary.stalledItems} tone="amber" hint="c47" />
            <Tile label="Drafted updates to approve" value={summary.draftsAwaitingApproval} tone="amber" hint="c54 — a lawyer approves every draft" />
            <Tile label="Matters in red" value={summary.health.red ?? 0} tone="red" hint={`c53 — amber ${summary.health.amber ?? 0}, green ${summary.health.green ?? 0}, too new ${summary.health.insufficient_data ?? 0}`} />
          </div>
        </>
      )}

      <div>
        <h2 className="text-sm font-semibold text-slate-900">Approvals this engine waits on</h2>
        <p className="mt-1 text-xs text-slate-500">
          Until approved, client wording shows as a visible placeholder and is held (never sent), and gated actions are blocked and logged.
        </p>
        <div className="mt-2 overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50">
              <tr>
                <th className="px-4 py-2 text-left font-medium text-slate-600">Gate</th>
                <th className="px-4 py-2 text-left font-medium text-slate-600">What it covers</th>
                <th className="px-4 py-2 text-left font-medium text-slate-600">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {gates.map((g) => (
                <tr key={g.gate.key}>
                  <td className="whitespace-nowrap px-4 py-2 font-mono text-xs">{g.gate.key}</td>
                  <td className="px-4 py-2 text-slate-700">{g.gate.description}</td>
                  <td className="whitespace-nowrap px-4 py-2">
                    {g.approved ? (
                      <span className="rounded bg-green-100 px-2 py-0.5 text-green-800">approved</span>
                    ) : (
                      <span className="rounded bg-amber-100 px-2 py-0.5 text-amber-800">pending {g.pendingReviewers.join(" + ")}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
