// c37 — Ops "attention needed" queue. Internal staff surface: overdue and
// due-soon tasks, open/unacknowledged flags, background jobs that are behind,
// and failed or held notifications. Read-only apart from "Acknowledge".
import Link from "next/link";
import { revalidatePath } from "next/cache";
import type { AttentionItem } from "@/engines/platform/ops/attention";
import { PendingApprovalError } from "@/compliance/approvals";

export const dynamic = "force-dynamic";

const SEVERITY_CLASS: Record<AttentionItem["severity"], string> = {
  critical: "bg-red-100 text-red-800 border-red-200",
  high: "bg-orange-100 text-orange-800 border-orange-200",
  warning: "bg-amber-50 text-amber-800 border-amber-200",
  info: "bg-slate-100 text-slate-700 border-slate-200",
};

const SOURCE_LABEL: Record<AttentionItem["source"], string> = {
  task: "Task",
  flag: "Flag",
  scheduled_task: "Background job",
  notification: "Notification",
};

async function acknowledge(formData: FormData) {
  "use server";
  const flagId = String(formData.get("flagId") ?? "");
  if (!flagId) return;
  const [{ resolveRequestTenantId, requirePrincipal }, { withTenant }, { acknowledgeFlag }] = await Promise.all([
    import("@/auth/request"),
    import("@/tenancy/withTenant"),
    import("@/core/flags"),
  ]);
  const tenantId = await resolveRequestTenantId();
  await withTenant(tenantId, async (tx) => {
    const me = await requirePrincipal(tx, tenantId, "flags.acknowledge");
    if (!me.userId) throw new Error("Set DEV_USER_ID to a real user to acknowledge flags in dev mode.");
    await acknowledgeFlag(tx, { tenantId, flagId, userId: me.userId, engine: "platform" });
  });
  revalidatePath("/admin/ops");
}

async function load() {
  // Lazy imports: next build must not need DATABASE_URL (see /admin/page.tsx).
  const [{ resolveRequestTenantId, requirePrincipal }, { withTenant }, { loadAttentionQueue }] = await Promise.all([
    import("@/auth/request"),
    import("@/tenancy/withTenant"),
    import("@/engines/platform/ops/queue"),
  ]);
  const tenantId = await resolveRequestTenantId();
  return withTenant(tenantId, async (tx) => {
    const me = await requirePrincipal(tx, tenantId, "ops.view");
    const queue = await loadAttentionQueue(tx, tenantId);
    return { queue, canAck: me.permissions.includes("flags.acknowledge") && Boolean(me.userId) };
  });
}

export default async function OpsQueuePage() {
  let data: Awaited<ReturnType<typeof load>>;
  try {
    data = await load();
  } catch (err) {
    if (err instanceof PendingApprovalError) {
      return <div className="rounded-lg border border-amber-200 bg-amber-50 p-6 text-sm text-amber-800">{err.placeholder}</div>;
    }
    const status = (err as { status?: number }).status;
    if (status === 401 || status === 403) {
      return (
        <div className="rounded-lg border border-slate-200 bg-white p-6 text-sm text-slate-700">
          {(err as Error).message || "You do not have access to the ops queue."}
        </div>
      );
    }
    throw err;
  }
  const { queue, canAck } = data;
  const s = queue.summary;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">Attention needed</h1>
          <p className="mt-1 text-sm text-slate-600">
            {s.total} item{s.total === 1 ? "" : "s"} · {s.breached} past SLA · internal only
          </p>
        </div>
        <div className="flex gap-4">
          <Link href="/admin/ops/widget" className="text-sm text-slate-500 hover:underline">
            Website widget
          </Link>
          <Link href="/admin" className="text-sm text-slate-500 hover:underline">
            ← Matters queue
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {(["critical", "high", "warning", "info"] as const).map((sev) => (
          <div key={sev} className={`rounded-lg border px-4 py-3 ${SEVERITY_CLASS[sev]}`}>
            <p className="text-xs font-medium uppercase tracking-wide">{sev}</p>
            <p className="text-2xl font-semibold">{s.bySeverity[sev]}</p>
          </div>
        ))}
      </div>

      {queue.truncated && (
        <p className="text-sm text-amber-700">Showing the first 500 rows per source; there are more.</p>
      )}

      {queue.items.length === 0 ? (
        <div className="rounded-lg border border-slate-200 bg-white p-6 text-sm text-slate-600">Nothing needs attention.</div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50">
              <tr>
                <th className="px-4 py-2 text-left font-medium text-slate-600">Severity</th>
                <th className="px-4 py-2 text-left font-medium text-slate-600">Source</th>
                <th className="px-4 py-2 text-left font-medium text-slate-600">Item</th>
                <th className="px-4 py-2 text-left font-medium text-slate-600">Status</th>
                <th className="px-4 py-2 text-left font-medium text-slate-600">Matter</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {queue.items.map((item) => (
                <tr key={item.key}>
                  <td className="whitespace-nowrap px-4 py-2">
                    <span className={`rounded border px-2 py-0.5 text-xs font-medium ${SEVERITY_CLASS[item.severity]}`}>
                      {item.severity}
                      {item.breached ? " · SLA" : ""}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 text-slate-600">{SOURCE_LABEL[item.source]}</td>
                  <td className="px-4 py-2">
                    <p className="font-medium text-slate-900">{item.title}</p>
                    <p className="text-xs text-slate-500">{item.kind}</p>
                  </td>
                  <td className="px-4 py-2 text-slate-700">{item.detail}</td>
                  <td className="whitespace-nowrap px-4 py-2">
                    {item.matterId ? (
                      <Link href={`/admin/matters/${item.matterId}`} className="text-slate-700 hover:underline">
                        Open
                      </Link>
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 text-right">
                    {item.canAcknowledge && canAck && item.id && (
                      <form action={acknowledge}>
                        <input type="hidden" name="flagId" value={item.id} />
                        <button type="submit" className="rounded-md border border-slate-300 px-3 py-1 text-xs hover:bg-slate-50">
                          Acknowledge
                        </button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-slate-400">Generated {new Date(queue.generatedAt).toLocaleString()}</p>
    </div>
  );
}
