// Intake console (c65, c66, c69 + the approval status of every intake gate).
// Read-only overview: the one queue for every channel, open emergencies, and
// which intake features are still waiting for attorney / CPA / vendor sign-off.
// Actions go through /api/intake/**. Internal only — nothing here is client-facing.
import { getDevTenantId } from "@/tenancy/devTenant";
import { gateStatus } from "@/compliance/approvals";
import { INTAKE_GATE_KEYS, INTAKE_SHARED_GATE_KEYS } from "@/engines/intake/gates";

export const dynamic = "force-dynamic";

interface QueueRow {
  intakeSessionId: string;
  channel: string;
  status: string;
  fullName: string | null;
  safetyFlagged: boolean;
  emergencyUnacknowledged: boolean;
  responseTargetAt: Date | null;
  responseOutcome: string | null;
  fitOutcome: string | null;
  startedAt: Date;
}

async function loadData(): Promise<{ queue: QueueRow[]; emergencies: number; error: string | null }> {
  try {
    const tenantId = getDevTenantId();
    const [{ withTenant }, { ensureServerApprovals }, { listIntakeQueue }, { listOpenEmergencies }] = await Promise.all([
      import("@/tenancy/withTenant"),
      import("@/compliance/server"),
      import("@/engines/intake/channels/service"),
      import("@/engines/intake/emergency/service"),
    ]);
    await ensureServerApprovals();
    return await withTenant(tenantId, async (tx) => ({
      queue: (await listIntakeQueue(tx, tenantId, { limit: 50 })) as QueueRow[],
      emergencies: (await listOpenEmergencies(tx, tenantId)).length,
      error: null,
    }));
  } catch (err) {
    console.error("[admin/intake] failed to load:", err);
    return { queue: [], emergencies: 0, error: "Could not load the intake queue." };
  }
}

function fmt(d: Date | null): string {
  return d ? new Date(d).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : "—";
}

export default async function IntakeConsolePage() {
  const { queue, emergencies, error } = await loadData();
  const gates = [...INTAKE_GATE_KEYS, ...INTAKE_SHARED_GATE_KEYS].map((key) => gateStatus(key));
  const pending = gates.filter((g) => !g.approved);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Intake</h1>
        <p className="mt-1 text-sm text-slate-600">Every channel lands in one queue. Emergencies are listed first.</p>
      </div>

      {emergencies > 0 ? (
        <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm font-medium text-red-800">
          {emergencies} open emergency alert{emergencies === 1 ? "" : "s"} — acknowledge in the emergency queue.
        </div>
      ) : null}

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase text-slate-500">Queue</h2>
        {error ? <p className="text-sm text-red-700">{error}</p> : null}
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500">
              <tr>
                <th className="px-3 py-2">Contact</th>
                <th className="px-3 py-2">Channel</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Respond by</th>
                <th className="px-3 py-2">Fit</th>
                <th className="px-3 py-2">Started</th>
              </tr>
            </thead>
            <tbody>
              {queue.length === 0 ? (
                <tr>
                  <td className="px-3 py-3 text-slate-500" colSpan={6}>
                    No open inquiries.
                  </td>
                </tr>
              ) : (
                queue.map((r) => (
                  <tr key={r.intakeSessionId} className={r.emergencyUnacknowledged || r.safetyFlagged ? "bg-red-50" : ""}>
                    <td className="px-3 py-2 text-slate-900">
                      {r.fullName ?? "Unknown contact"}
                      {r.safetyFlagged ? <span className="ml-2 rounded bg-red-100 px-1.5 py-0.5 text-xs text-red-800">safety</span> : null}
                    </td>
                    <td className="px-3 py-2 text-slate-700">{r.channel.replace(/_/g, " ")}</td>
                    <td className="px-3 py-2 text-slate-700">{r.status.replace(/_/g, " ")}</td>
                    <td className="px-3 py-2 text-slate-700">{r.responseOutcome ? r.responseOutcome.replace(/_/g, " ") : fmt(r.responseTargetAt)}</td>
                    <td className="px-3 py-2 text-slate-700">{r.fitOutcome ?? "—"}</td>
                    <td className="px-3 py-2 text-slate-500">{fmt(r.startedAt)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase text-slate-500">
          Waiting for sign-off ({pending.length} of {gates.length})
        </h2>
        <p className="mb-2 text-sm text-slate-600">
          Until each item is approved, its wording shows as a visible placeholder and gated actions are blocked and logged.
        </p>
        <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white text-sm">
          {pending.map((g) => (
            <li key={g.gate.key} className="flex items-start justify-between gap-4 px-3 py-2">
              <span className="text-slate-800">
                {g.gate.description}
                <span className="ml-2 font-mono text-xs text-slate-400">{g.gate.key}</span>
              </span>
              <span className="shrink-0 text-xs text-slate-500">{g.pendingReviewers.join(", ")}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
