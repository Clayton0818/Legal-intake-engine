"use client";

// One editable cell of the permission matrix. Writes go through
// PUT /api/all-engines/permissions, which re-validates everything and logs it.
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { send } from "../_lib/send";

interface Props {
  role: string;
  right: string;
  effective: boolean;
  byDefault: boolean;
  source: "default" | "granted" | "denied";
  editable: boolean;
  note: string | null;
}

export function MatrixCell({ role, right, effective, byDefault, source, editable, note }: Props) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const mark = effective ? "✓" : "–";
  const tone = source === "granted" ? "text-sky-700 font-semibold" : source === "denied" ? "text-rose-700 font-semibold" : effective ? "text-slate-800" : "text-slate-300";

  async function toggle() {
    const reason = window.prompt(`Reason for ${effective ? "removing" : "giving"} '${right}' ${effective ? "from" : "to"} ${role}:`);
    if (!reason?.trim()) return;
    const effect = effective === byDefault ? (effective ? "deny" : "grant") : null;
    const err = await send("/api/all-engines/permissions", "PUT", { role, right, effect, reason });
    setError(err);
    if (!err) start(() => router.refresh());
  }

  if (!editable) {
    return <span className={tone} title={note ?? undefined}>{mark}</span>;
  }
  return (
    <span>
      <button type="button" disabled={pending} onClick={() => void toggle()} className={`rounded px-1 hover:bg-slate-100 ${tone}`} title={note ?? (source === "default" ? "Default — click to change" : `Changed by the firm (${source}) — click to change`)}>
        {mark}
      </button>
      {error ? <span className="block max-w-[10rem] text-xs text-red-600">{error}</span> : null}
    </span>
  );
}
