// Matter detail view (board card c24). Renders the full matter record, the
// linked party's contact info, the latest intake session's collected
// answers, and any conflict-check results for that session. Stage changes
// go through the client-side StageSelect, which PATCHes
// /api/admin/matters/[id] rather than mutating anything from this Server
// Component directly.
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDevTenantId } from "@/tenancy/devTenant";
import { getMatterDetail, MATTER_STAGE_VALUES } from "../../_lib/queries";
import {
  conflictOutcomeBadgeClass,
  formatAnswerValue,
  formatDate,
  formatDateTime,
  formatEnumLabel,
  formatFieldLabel,
  stageBadgeClass,
} from "../../_lib/format";
import { StageSelect } from "./stage-select";

export const dynamic = "force-dynamic";

export default async function MatterDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const tenantId = getDevTenantId();
  // withTenant (and, transitively, src/tenancy/db.ts) is imported lazily,
  // not statically at module scope — see src/app/admin/page.tsx's comment
  // for why a static import here would make DATABASE_URL a build-time
  // requirement instead of a request-time one.
  const { withTenant } = await import("@/tenancy/withTenant");
  const detail = await withTenant(tenantId, (tx) => getMatterDetail(tx, tenantId, id));

  if (!detail) {
    notFound();
  }

  const { matter, party, assignedUser, intakeSession, conflictResults } = detail;
  const answers = (intakeSession?.collectedAnswers ?? {}) as Record<string, unknown>;
  const answerEntries = Object.entries(answers);

  return (
    <div className="space-y-6">
      <Link href="/admin" className="text-sm text-slate-500 hover:underline">
        ← Back to matters queue
      </Link>

      <div className="rounded-lg border border-slate-200 bg-white p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-lg font-semibold text-slate-900">
              {party?.fullName ?? "Unknown party"}
            </h1>
            <p className="mt-1 text-sm text-slate-600">
              {matter.practiceArea ?? "No practice area set"}
            </p>
          </div>
          <StageSelect matterId={matter.id} currentStage={matter.stage} stages={MATTER_STAGE_VALUES} />
        </div>

        <dl className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div>
            <dt className="text-xs font-medium uppercase text-slate-500">Current stage</dt>
            <dd className="mt-1">
              <span
                className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${stageBadgeClass(matter.stage)}`}
              >
                {formatEnumLabel(matter.stage)}
              </span>
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase text-slate-500">Opened</dt>
            <dd className="mt-1 text-sm text-slate-800">{formatDate(matter.openedAt)}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase text-slate-500">Closed</dt>
            <dd className="mt-1 text-sm text-slate-800">{formatDate(matter.closedAt)}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase text-slate-500">Assigned to</dt>
            <dd className="mt-1 text-sm text-slate-800">
              {assignedUser?.displayName ?? "Unassigned"}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase text-slate-500">Retention (years)</dt>
            <dd className="mt-1 text-sm text-slate-800">{matter.retentionYears ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase text-slate-500">Eligible for deletion</dt>
            <dd className="mt-1 text-sm text-slate-800">{formatDate(matter.eligibleForDeletionAt)}</dd>
          </div>
        </dl>
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-6">
        <h2 className="text-sm font-semibold text-slate-900">Party contact info</h2>
        {party ? (
          <dl className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div>
              <dt className="text-xs font-medium uppercase text-slate-500">Full name</dt>
              <dd className="mt-1 text-sm text-slate-800">{party.fullName}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase text-slate-500">Email</dt>
              <dd className="mt-1 text-sm text-slate-800">{party.email ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase text-slate-500">Phone</dt>
              <dd className="mt-1 text-sm text-slate-800">{party.phone ?? "—"}</dd>
            </div>
          </dl>
        ) : (
          <p className="mt-2 text-sm text-slate-600">No party record found.</p>
        )}
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-6">
        <h2 className="text-sm font-semibold text-slate-900">Intake answers</h2>
        {!intakeSession ? (
          <p className="mt-2 text-sm text-slate-600">No intake session linked to this matter.</p>
        ) : answerEntries.length === 0 ? (
          <p className="mt-2 text-sm text-slate-600">No answers collected yet.</p>
        ) : (
          <dl className="mt-4 divide-y divide-slate-100">
            {answerEntries.map(([key, value]) => (
              <div key={key} className="grid grid-cols-1 gap-1 py-2 sm:grid-cols-3">
                <dt className="text-sm font-medium text-slate-600">{formatFieldLabel(key)}</dt>
                <dd className="text-sm text-slate-800 sm:col-span-2">{formatAnswerValue(value)}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-6">
        <h2 className="text-sm font-semibold text-slate-900">Conflict check results</h2>
        {conflictResults.length === 0 ? (
          <p className="mt-2 text-sm text-slate-600">No conflict check results recorded.</p>
        ) : (
          <ul className="mt-4 space-y-3">
            {conflictResults.map((result) => (
              <li key={result.id} className="rounded-md border border-slate-100 p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium text-slate-800">Role sought: {result.roleSought}</span>
                  <span
                    className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${conflictOutcomeBadgeClass(result.outcome)}`}
                  >
                    {formatEnumLabel(result.outcome)}
                  </span>
                </div>
                <p className="mt-1 text-xs text-slate-500">Checked {formatDateTime(result.createdAt)}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
