// c37 — worker hook: raise ONE internal flag to the firm's admins when
// background jobs (scheduled_tasks) are retrying or stuck past their SLA, and
// resolve it once they clear. Real clock (infrastructure health).
//
// Discovery: src/worker/hooks.ts loads worker modules for every slug in
// ENGINE_SLUGS ('platform' was added 2026-10-03), so `npm run worker:tick`
// runs this scan once per active firm per tick.

import type { EngineWorkerModule, TenantTickContext } from "@/worker/hooks";
import { getFirmSettings } from "@/core/firmSettings";
import { raiseFlag, resolveFlag, listInternalFlags } from "@/core/flags";
import { scheduledTaskAttention } from "./ops/attention";
import { listFirmAdminIds, loadScheduledTaskRows, OPS_ENGINE, opsSettingsFrom } from "./ops/queue";

export const WORKER_BACKLOG_FLAG = "platform.worker_backlog";
const DEDUPE_KEY = "platform.worker_backlog";

/** Pure: what the scan should do. */
export function planBacklogFlag(input: { problemCount: number; highCount: number; openFlagId: string | null; adminIds: string[] }):
  | { action: "raise"; severity: "warning" | "high" }
  | { action: "resolve"; flagId: string }
  | { action: "none" } {
  if (input.problemCount > 0) {
    if (input.openFlagId) return { action: "none" }; // dedupeKey keeps one open flag
    if (input.adminIds.length === 0) return { action: "none" }; // nobody to tell; still visible on /admin/ops
    return { action: "raise", severity: input.highCount > 0 ? "high" : "warning" };
  }
  return input.openFlagId ? { action: "resolve", flagId: input.openFlagId } : { action: "none" };
}

export async function runOpsSlaScan({ tx, tenantId, now }: TenantTickContext): Promise<Record<string, unknown>> {
  const settings = await getFirmSettings(tx, tenantId);
  const rows = await loadScheduledTaskRows(tx, tenantId, now);
  const problems = scheduledTaskAttention(rows, now, opsSettingsFrom(settings));
  const [open] = await listInternalFlags(tx, tenantId, { openOnly: true, types: [WORKER_BACKLOG_FLAG], limit: 1 });
  const adminIds = problems.length > 0 && !open ? await listFirmAdminIds(tx, tenantId) : [];
  const plan = planBacklogFlag({
    problemCount: problems.length,
    highCount: problems.filter((p) => p.severity === "high").length,
    openFlagId: open?.id ?? null,
    adminIds,
  });

  if (plan.action === "raise") {
    await raiseFlag(
      tx,
      {
        tenantId,
        type: WORKER_BACKLOG_FLAG,
        severity: plan.severity,
        audience: "internal",
        title: "Background jobs are behind",
        summary: `${problems.length} scheduled job(s) are retrying or stuck. See /admin/ops.`,
        details: { taskTypes: [...new Set(problems.map((p) => p.kind))], count: problems.length },
        recipients: { userIds: adminIds },
        dedupeKey: DEDUPE_KEY,
        sourceCard: "c37",
        engine: OPS_ENGINE,
      },
      { now }
    );
  } else if (plan.action === "resolve") {
    await resolveFlag(tx, {
      tenantId,
      flagId: plan.flagId,
      by: { type: "system" },
      reason: "Scheduled jobs caught up (automatic).",
      engine: OPS_ENGINE,
      at: now,
    });
  }
  return { problems: problems.length, action: plan.action };
}

export const worker: EngineWorkerModule = {
  tickHooks: [{ name: "platform.ops_sla_scan", engine: "core", run: runOpsSlaScan }],
};
