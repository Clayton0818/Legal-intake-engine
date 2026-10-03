// Document engine (c84): what the store depends on before it can run for
// real, and how it is configured.
//
// Deliberately shows NO documents, names or matters: the staff console is not
// access-controlled yet (see ../layout.tsx). Documents are served only by the
// permission-checked, access-logged API under /api/document.

import { gateStatus } from "@/compliance/approvals";
import { ensureServerApprovals } from "@/compliance/server";
import { DOCUMENT_GATE_KEYS } from "@/engines/document/gates";
import { DEFAULT_FOLDER_TEMPLATE, REQUIRED_FOLDER_KEYS, planFolders } from "@/engines/document/folders/template";
import { DEFAULT_DOCUMENT_SETTINGS } from "@/engines/document/settings";
import { accessHookNames } from "@/engines/document/access/service";

export const dynamic = "force-dynamic";

function storageSummary(): { name: string; note: string } {
  const mode = (process.env.DOCUMENT_STORAGE ?? "memory").toLowerCase();
  if (mode === "local") return { name: "Local disk (encrypted, AES-256-GCM)", note: "Development / single-server pilot only." };
  if (mode === "memory") return { name: "In-memory", note: "Files are lost when the server restarts. Not allowed in production." };
  return { name: mode, note: "No vendor adapter is wired yet (storage ADR addendum pending)." };
}

export default async function DocumentAdminPage() {
  await ensureServerApprovals();
  const rows = DOCUMENT_GATE_KEYS.map((key) => gateStatus(key));
  const pending = rows.filter((r) => !r.approved).length;
  const storage = storageSummary();
  const hooks = accessHookNames();
  const folders = planFolders(DEFAULT_FOLDER_TEMPLATE);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-slate-900">Documents: store status</h1>
        <p className="mt-1 text-sm text-slate-600">
          {pending} of {rows.length} items the document store depends on are still waiting for review. Until then vendor storage, malware
          scanning and text recognition stay off (files are stored on our own infrastructure and marked “not virus-scanned”), and retention
          dates are not proposed.
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

      <section className="grid gap-4 md:grid-cols-2">
        <div className="rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-700">
          <h2 className="font-semibold text-slate-900">Storage</h2>
          <p className="mt-1">{storage.name}</p>
          <p className="mt-1 text-xs text-slate-500">{storage.note}</p>
          <p className="mt-2 text-xs text-slate-500">
            Every upload is a new version (never overwritten), checked against its SHA-256 on every download. Upload limit by default:{" "}
            {Math.round(DEFAULT_DOCUMENT_SETTINGS.maxUploadBytes / (1024 * 1024))} MB (firm setting).
          </p>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-700">
          <h2 className="font-semibold text-slate-900">Screens and access</h2>
          <p className="mt-1">
            Screen sources: <span className="font-mono text-xs">{hooks.screens.join(", ")}</span>
          </p>
          <p className="mt-1">
            Matter-scope sources: <span className="font-mono text-xs">{hooks.scopes.length ? hooks.scopes.join(", ") : "none (role permissions only)"}</span>
          </p>
          <p className="mt-2 text-xs text-slate-500">
            A screen hides a matter&apos;s documents from that person in listings, downloads and search, whatever their role. Every view,
            download, listing and search is recorded in the document access log (GET /api/document/access-log).
          </p>
        </div>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-700">
        <h2 className="font-semibold text-slate-900">Default folder layout</h2>
        <p className="mt-1 text-xs text-slate-500">
          Used for a matter when the firm has no active template for its practice area. Firms set their own per practice area
          (POST /api/document/folder-templates, then activate). Every template must keep the folders with keys{" "}
          <span className="font-mono">{REQUIRED_FOLDER_KEYS.join(", ")}</span>, which other features file into.
        </p>
        <ul className="mt-2 space-y-0.5">
          {folders.map((f) => (
            <li key={f.key} style={{ paddingLeft: `${(f.depth - 1) * 1.25}rem` }}>
              {f.name} <span className="font-mono text-xs text-slate-400">{f.key}</span>
              {f.defaultPrivilegeTag !== "none" ? <span className="ml-2 text-xs text-amber-700">{f.defaultPrivilegeTag}</span> : null}
            </li>
          ))}
        </ul>
      </section>

      <p className="text-xs text-slate-500">
        Reviewers record approvals with <code>npm run compliance -- approve --gate &lt;key&gt; --reviewer &lt;kind&gt; --by &quot;&lt;name&gt;&quot;</code>.
      </p>
    </div>
  );
}
