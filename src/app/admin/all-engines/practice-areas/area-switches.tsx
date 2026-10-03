"use client";

// Practice-area switches. PUT /api/all-engines/practice-areas validates
// (at least one on, only shipped packs) and logs every change.
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { send } from "../_lib/send";

interface Area {
  id: string;
  label: string;
  enabled: boolean;
  packAvailable: boolean;
  openMatters: number;
}

export function AreaSwitches({ areas }: { areas: Area[] }) {
  const router = useRouter();
  const [on, setOn] = useState(() => new Set(areas.filter((a) => a.enabled).map((a) => a.id)));
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  async function save() {
    const err = await send("/api/all-engines/practice-areas", "PUT", { areas: [...on], reason });
    setError(err);
    if (!err) start(() => router.refresh());
  }

  return (
    <div className="space-y-3">
      {areas.map((a) => (
        <label key={a.id} className="flex items-center gap-3 text-sm">
          <input
            type="checkbox"
            checked={on.has(a.id)}
            disabled={!a.packAvailable && !a.enabled}
            onChange={(e) => {
              const next = new Set(on);
              if (e.target.checked) next.add(a.id);
              else next.delete(a.id);
              setOn(next);
            }}
          />
          <span className="font-medium text-slate-800">{a.label}</span>
          {!a.packAvailable ? <span className="text-xs text-slate-500">(coming later)</span> : null}
          {a.enabled && !on.has(a.id) && a.openMatters > 0 ? (
            <span className="text-xs text-amber-700">{a.openMatters} open matter(s) continue unchanged; only new ones stop.</span>
          ) : null}
        </label>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <input
          className="w-80 rounded-md border border-slate-300 px-2 py-1 text-sm"
          placeholder="Reason for the change (required)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <button type="button" disabled={pending || !reason.trim()} onClick={() => void save()} className="rounded-md bg-slate-900 px-3 py-1 text-sm text-white disabled:opacity-50">
          Save
        </button>
      </div>
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
    </div>
  );
}

export function AcceptUpdate({ area, version, contentHash }: { area: string; version: string; contentHash: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  async function accept() {
    if (!window.confirm(`Accept version ${version} of this pack? Engines will use it from now on.`)) return;
    const err = await send(`/api/all-engines/practice-areas/${area}/accept`, "POST", { version, contentHash });
    setError(err);
    if (!err) start(() => router.refresh());
  }
  return (
    <span>
      <button type="button" disabled={pending} onClick={() => void accept()} className="rounded-md border border-slate-300 px-2 py-0.5 text-sm hover:bg-slate-50">
        Accept version {version}
      </button>
      {error ? <span className="ml-2 text-xs text-red-600">{error}</span> : null}
    </span>
  );
}
