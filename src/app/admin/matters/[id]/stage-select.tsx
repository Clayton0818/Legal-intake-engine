"use client";

// Client-side stage changer. Submits to the PATCH endpoint
// (src/app/api/admin/matters/[id]/route.ts) rather than mutating the
// database directly from the browser — that route is the only place stage
// writes happen, and it re-validates the value server-side against the
// matter_stage enum regardless of what this <select> offers.
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { formatEnumLabel } from "../../_lib/format";

interface StageSelectProps {
  matterId: string;
  currentStage: string;
  stages: readonly string[];
}

export function StageSelect({ matterId, currentStage, stages }: StageSelectProps) {
  const router = useRouter();
  const [stage, setStage] = useState(currentStage);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  async function handleChange(nextStage: string) {
    const previousStage = stage;
    setStage(nextStage);
    setError(null);

    try {
      const response = await fetch(`/api/admin/matters/${matterId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stage: nextStage }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Failed to update stage (HTTP ${response.status}).`);
      }

      // Re-fetch the server component so the rest of the page (e.g. any
      // future stage-dependent copy) stays consistent with what we just
      // wrote, rather than trusting only local state.
      startTransition(() => {
        router.refresh();
      });
    } catch (err) {
      setStage(previousStage);
      setError(err instanceof Error ? err.message : "Failed to update stage.");
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <label className="text-xs font-medium uppercase text-slate-500" htmlFor="matter-stage">
        Change stage
      </label>
      <select
        id="matter-stage"
        className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-800 disabled:opacity-60"
        value={stage}
        disabled={isPending}
        onChange={(event) => {
          void handleChange(event.target.value);
        }}
      >
        {stages.map((value) => (
          <option key={value} value={value}>
            {formatEnumLabel(value)}
          </option>
        ))}
      </select>
      {error ? <p className="max-w-xs text-right text-xs text-red-600">{error}</p> : null}
    </div>
  );
}
