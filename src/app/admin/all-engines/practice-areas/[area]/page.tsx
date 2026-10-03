// c102/c103 — what a practice-area pack contributes to each engine, for the
// firm's review. Client-facing wording is shown exactly as clients would see
// it today: the approved text, or the visible pending-review placeholder.

import { notFound } from "next/navigation";
import { gateStatus, legalCopyStatus } from "@/compliance/approvals";
import { ensureServerApprovals } from "@/compliance/server";
import "@/engines/all-engines/gates";
import { getPack, packContentHash } from "@/engines/all-engines/packs/registry";
import type { FolderNode } from "@/engines/all-engines/packs/types";

export const dynamic = "force-dynamic";

function Folders({ nodes }: { nodes: FolderNode[] }) {
  return (
    <ul className="list-disc pl-5">
      {nodes.map((n) => (
        <li key={n.id}>
          {n.name} <span className="text-xs text-slate-500">({n.defaultPrivilege ?? "none"}{n.clientVisibleFolder ? ", client folder" : ""})</span>
          {n.children ? <Folders nodes={n.children} /> : null}
        </li>
      ))}
    </ul>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-700">
      <h2 className="mb-2 font-semibold text-slate-900">{title}</h2>
      {children}
    </section>
  );
}

export default async function PackPage({ params }: { params: Promise<{ area: string }> }) {
  const { area } = await params;
  const pack = getPack(area);
  if (!pack) notFound();
  await ensureServerApprovals();
  const review = gateStatus(pack.contentReviewGateKey);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-slate-900">
          {pack.label} pack <span className="text-sm font-normal text-slate-500">v{pack.version} · {pack.jurisdiction}</span>
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          Content hash <span className="font-mono text-xs">{packContentHash(pack)}</span>.{" "}
          {review.approved ? "Reviewed by an attorney." : "DRAFT — pending review by a Texas family-law attorney. Nothing here is legal advice."}
        </p>
        <ul className="mt-1 list-disc pl-5 text-xs text-slate-500">
          {pack.changelog.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      </div>

      <Section title="Intake: matter types">
        <ul className="list-disc pl-5">
          {pack.intake.matterTypes.map((t) => (
            <li key={t.id}>
              <span className="font-medium">{t.label}</span> — {t.description}
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Intake: questions (as clients see them today)">
        <ol className="list-decimal space-y-1 pl-5">
          {[...pack.intake.questions]
            .sort((a, b) => a.order - b.order)
            .map((q) => {
              const c = legalCopyStatus(q.prompt.copyKey);
              return (
                <li key={q.id}>
                  <span className="text-xs uppercase text-slate-500">{q.group}</span> · {c.text}
                  {q.safetySignalAnswers?.length ? <span className="ml-1 text-xs text-rose-700">safety signal: {q.safetySignalAnswers.join(", ")}</span> : null}
                  {q.urgentSignalAnswers?.length ? <span className="ml-1 text-xs text-amber-700">urgent: {q.urgentSignalAnswers.join(", ")}</span> : null}
                  {!c.approved ? <div className="text-xs text-slate-500">Proposed wording: “{q.prompt.draft}”</div> : null}
                </li>
              );
            })}
        </ol>
        <p className="mt-2 text-xs text-slate-500">
          Safety handling: safety questions first; any signal routes to the emergency flow and marks the client DV-sensitive. Defaults: safe email
          required, no SMS, no voicemail, nothing sensitive by email, never a shared device.
        </p>
      </Section>

      <Section title="Conflict check: party roles">
        <ul className="list-disc pl-5">
          {pack.conflicts.partyRoles.map((r) => (
            <li key={r.id}>
              {r.label} — {r.adverseByDefault ? "usually adverse" : "related"}; {r.indexByDefault ? "indexed" : "not indexed by default"}
              {r.askAtIntake ? "; asked at intake" : ""}
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Documents: folders">
        <Folders nodes={pack.documents.folderTemplate} />
      </Section>

      <Section title="Documents: required-document checklists and templates">
        {pack.documents.checklists.map((c) => (
          <div key={c.id} className="mb-2">
            <div className="font-medium">{c.label}</div>
            <ul className="list-disc pl-5">
              {c.items.map((i) => (
                <li key={i.id}>
                  {i.label} <span className="text-xs text-slate-500">({i.providedBy}{i.required ? ", required" : ""})</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
        <div className="font-medium">Templates (lawyer-reviewed before use)</div>
        <ul className="list-disc pl-5">
          {pack.documents.templates.map((t) => (
            <li key={t.id}>
              {t.label} <span className="font-mono text-xs text-slate-500">{gateStatus(t.gateKey).approved ? "approved" : `pending: ${t.gateKey}`}</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Stages and task lists">
        {pack.stages.tracks.map((t) => (
          <p key={t.id}>
            <span className="font-medium">{t.label}:</span> {t.stages.map((s) => s.label).join(" → ")}
          </p>
        ))}
        {pack.tasks.lists.map((l) => (
          <div key={l.id} className="mt-2">
            <div className="font-medium">
              {l.label} <span className="text-xs text-slate-500">({l.trigger.on === "matter_opened" ? "when the matter opens" : `on entering ${l.trigger.stageId}`})</span>
            </div>
            <ul className="list-disc pl-5">
              {l.tasks.map((t) => (
                <li key={t.id}>
                  {t.title} <span className="text-xs text-slate-500">— {t.assigneeRole}{t.dueBusinessDays !== undefined ? `, firm target ${t.dueBusinessDays} business day(s)` : ""}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </Section>

      <Section title="Texas rule tools (lawyer only; blocked until an attorney approves)">
        <ul className="list-disc pl-5">
          {pack.deadlines.rules.map((r) => (
            <li key={r.id}>
              {r.label} — {r.note}{" "}
              <span className="font-mono text-xs text-slate-500">{gateStatus(r.gateKey).approved ? "approved" : `pending: ${r.gateKey}`}</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Billing defaults">
        <p>
          Default: {pack.billing.defaultFeeType.replace("_", " + ")}. Offered: {pack.billing.offeredFeeTypes.join(", ")}. Retainer floor comes from firm
          settings.
        </p>
        <ul className="list-disc pl-5">
          {pack.billing.withheldFeeTypes.map((w) => (
            <li key={w.feeType}>
              Not offered: {w.feeType} — {w.why}
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}
