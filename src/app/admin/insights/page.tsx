// Firm insights dashboard (board card c33). The matters queue (/admin)
// answers "what do I need to work on"; this answers "how is intake actually
// going" — practice-area mix, where matters get stuck, and the conflict-check
// outcome breakdown. Every number here is derived straight from data the
// product already captures for compliance reasons (c19's schema, c6's audit
// trail) — this page adds a view, not new capture.
import Link from "next/link";
import { getDevTenantId } from "@/tenancy/devTenant";
import { getInsightsForTenant } from "../_lib/queries";
import { formatEnumLabel, formatPercent, conflictOutcomeBadgeClass } from "../_lib/format";

// Tenant-scoped data must never be served from Next's static/full route
// cache, matching the rest of /admin.
export const dynamic = "force-dynamic";

function StatTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <p className="text-xs font-medium uppercase text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-slate-900">{value}</p>
      {hint ? <p className="mt-1 text-xs text-slate-500">{hint}</p> : null}
    </div>
  );
}

function BarRow({
  label,
  count,
  total,
  badgeClass,
}: {
  label: string;
  count: number;
  total: number;
  badgeClass: string;
}) {
  const widthPct = total === 0 ? 0 : Math.max((count / total) * 100, count > 0 ? 4 : 0);
  return (
    <div className="flex items-center gap-3 py-1.5">
      <span className="w-44 shrink-0 truncate text-sm text-slate-700" title={label}>
        {label}
      </span>
      <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-slate-100">
        <div className={`h-full rounded-full ${badgeClass}`} style={{ width: `${widthPct}%` }} />
      </div>
      <span className="w-8 shrink-0 text-right text-sm font-medium text-slate-800">{count}</span>
    </div>
  );
}

// Solid-fill bar colors, one per stage, matching stageBadgeClass's color
// family so a stage's bar and its badge read as the same color. This is a
// static map rather than deriving the class name at runtime (e.g.
// `bg-${hue}-400`) on purpose: Tailwind's build only includes classes it
// can find as complete literal strings in the source it scans. A
// dynamically-assembled class name is invisible to that scan, so the class
// never makes it into the compiled CSS and the bar silently renders with no
// fill at all — which is exactly the bug this replaces (caught by actually
// looking at a rendered screenshot, not just reading the code).
const STAGE_BAR_FILL_CLASSES: Record<string, string> = {
  prospective: "bg-slate-400",
  consultation_scheduled: "bg-blue-400",
  consult_completed_manual_follow_up: "bg-amber-400",
  pending_review: "bg-amber-400",
  did_not_schedule: "bg-slate-300",
  did_not_hire_referred_out: "bg-slate-300",
  declined_conflict: "bg-red-400",
  retained: "bg-green-400",
  closed: "bg-slate-400",
};

function stageBarFillClass(stage: string): string {
  return STAGE_BAR_FILL_CLASSES[stage] ?? "bg-slate-400";
}

export default async function AdminInsights() {
  const tenantId = getDevTenantId();
  // withTenant is imported lazily, not statically at module scope — see
  // src/app/admin/page.tsx's comment for why a static import here would
  // make DATABASE_URL a build-time requirement instead of a request-time
  // one (the exact bug fixed for this route's siblings in #19).
  const { withTenant } = await import("@/tenancy/withTenant");
  const insights = await withTenant(tenantId, (tx) => getInsightsForTenant(tx, tenantId));

  const nonZeroStages = insights.byStage.filter((row) => row.count > 0);
  const totalConflictChecks = insights.byConflictOutcome.reduce((sum, row) => sum + row.count, 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">Firm insights</h1>
          <p className="mt-1 text-sm text-slate-600">
            How intake is actually going for this firm — not just what&apos;s in the queue.
          </p>
        </div>
        <Link href="/admin" className="text-sm text-slate-500 hover:underline">
          ← Back to matters queue
        </Link>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Total matters" value={String(insights.totalMatters)} />
        <StatTile
          label="Retained"
          value={formatPercent(insights.retainedRate)}
          hint={`${insights.retainedCount} of ${insights.totalMatters}`}
        />
        <StatTile
          label="Declined for conflict"
          value={String(insights.declinedConflictCount)}
        />
        <StatTile
          label="Unassigned matters"
          value={String(insights.unassignedCount)}
          hint={insights.unassignedCount > 0 ? "Needs a staff owner" : undefined}
        />
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-6">
        <h2 className="text-sm font-semibold text-slate-900">Matters by stage</h2>
        {nonZeroStages.length === 0 ? (
          <p className="mt-2 text-sm text-slate-600">No matters yet.</p>
        ) : (
          <div className="mt-3">
            {nonZeroStages.map((row) => (
              <BarRow
                key={row.stage}
                label={formatEnumLabel(row.stage)}
                count={row.count}
                total={insights.totalMatters}
                badgeClass={stageBarFillClass(row.stage)}
              />
            ))}
          </div>
        )}
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-6">
        <h2 className="text-sm font-semibold text-slate-900">Practice area mix</h2>
        {insights.byPracticeArea.length === 0 ? (
          <p className="mt-2 text-sm text-slate-600">No matters yet.</p>
        ) : (
          <div className="mt-3">
            {insights.byPracticeArea.map((row) => (
              <BarRow
                key={row.practiceArea}
                label={formatEnumLabel(row.practiceArea)}
                count={row.count}
                total={insights.totalMatters}
                badgeClass="bg-teal-400"
              />
            ))}
          </div>
        )}
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-6">
        <h2 className="text-sm font-semibold text-slate-900">Conflict-check outcomes</h2>
        <p className="mt-1 text-xs text-slate-500">
          Tri-state by design (ADR-0001, c3) — &quot;possible&quot; is a pending human decision, not
          an error.
        </p>
        {totalConflictChecks === 0 ? (
          <p className="mt-3 text-sm text-slate-600">No conflict checks recorded yet.</p>
        ) : (
          <div className="mt-4 flex flex-wrap gap-3">
            {insights.byConflictOutcome.map((row) => (
              <div
                key={row.outcome}
                className={`flex min-w-[7rem] flex-col items-start rounded-lg px-4 py-3 ${conflictOutcomeBadgeClass(row.outcome)}`}
              >
                <span className="text-xs font-medium uppercase opacity-80">
                  {formatEnumLabel(row.outcome)}
                </span>
                <span className="mt-1 text-xl font-semibold">{row.count}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
