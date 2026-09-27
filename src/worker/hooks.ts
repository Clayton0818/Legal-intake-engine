// Worker extension points (ADR-0001 D6). The tick (./tick.ts) runs, for every
// active firm:
//   1. due `scheduled_tasks` rows, dispatched by task_type to a handler;
//   2. every TICK HOOK (periodic per-tenant work: drain the notification
//      outbox, scan for overdue tasks, check reconciliations …).
//
// Engines add their own hooks and handlers WITHOUT editing shared files, by
// exporting them from src/engines/<slug>/worker.ts:
//
//   import type { EngineWorkerModule } from "@/worker/hooks";
//   export const worker: EngineWorkerModule = {
//     tickHooks: [{ name: "calendar-alerts.overdue_scan", engine: "calendar-alerts", run: async ({ tx, tenantId, now }) => { … } }],
//     scheduledTaskHandlers: { "calendar-alerts.reminder": async ({ tx, tenantId, task }) => { … } },
//   };
//
// Names and task types must start with "<slug>." so two engines can never
// collide. This module has no database imports (tests can load it freely).

import type { TenantTx } from "@/tenancy/withTenant";
import type { scheduledTasks } from "@/db/schema";
import { ENGINE_SLUGS, isModuleNotFound, type AuditEngine } from "@/core/engines";
import { drainNotificationOutbox } from "@/core/notify";

export interface TenantTickContext {
  /** A withTenant() transaction scoped to `tenantId`. */
  tx: TenantTx;
  tenantId: string;
  now: Date;
}

export interface TenantTickHook {
  /** Unique, prefixed with the engine slug: e.g. 'calendar-alerts.overdue_scan'. */
  name: string;
  engine: AuditEngine;
  /** Return a small summary object for the tick log (optional). */
  run(ctx: TenantTickContext): Promise<Record<string, unknown> | void>;
}

export type ScheduledTaskRow = typeof scheduledTasks.$inferSelect;

export type ScheduledTaskHandler = (ctx: TenantTickContext & { task: ScheduledTaskRow }) => Promise<void>;

/** What src/engines/<slug>/worker.ts exports as `worker`. */
export interface EngineWorkerModule {
  tickHooks?: TenantTickHook[];
  /** Keyed by scheduled_tasks.task_type, which must be '<slug>.<name>'. */
  scheduledTaskHandlers?: Record<string, ScheduledTaskHandler>;
}

export interface WorkerRegistry {
  hooks: TenantTickHook[];
  handlers: Map<string, { engine: string; handler: ScheduledTaskHandler }>;
}

/** Core hooks that always run. */
export const CORE_TICK_HOOKS: readonly TenantTickHook[] = [
  {
    name: "core.notification_outbox",
    engine: "core",
    run: async ({ tx, tenantId, now }) => ({ ...(await drainNotificationOutbox(tx, tenantId, { now })) }),
  },
];

/** Combine core hooks with each engine's module, validating names. Pure. */
export function buildRegistry(modules: ReadonlyArray<{ slug: string; module: EngineWorkerModule }>): WorkerRegistry {
  const hooks: TenantTickHook[] = [...CORE_TICK_HOOKS];
  const handlers: WorkerRegistry["handlers"] = new Map();
  const names = new Set(hooks.map((h) => h.name));

  for (const { slug, module } of modules) {
    for (const hook of module.tickHooks ?? []) {
      if (!hook.name.startsWith(`${slug}.`)) {
        throw new Error(`Tick hook '${hook.name}' from engine '${slug}' must be named '${slug}.<name>'.`);
      }
      if (names.has(hook.name)) throw new Error(`Duplicate tick hook '${hook.name}'.`);
      names.add(hook.name);
      hooks.push(hook);
    }
    for (const [taskType, handler] of Object.entries(module.scheduledTaskHandlers ?? {})) {
      if (!taskType.startsWith(`${slug}.`)) {
        throw new Error(`Scheduled task type '${taskType}' from engine '${slug}' must be '${slug}.<name>'.`);
      }
      if (handlers.has(taskType)) throw new Error(`Duplicate scheduled task handler '${taskType}'.`);
      handlers.set(taskType, { engine: slug, handler });
    }
  }
  return { hooks, handlers };
}

/** Import src/engines/<slug>/worker.ts for every engine that has one. */
export async function loadEngineWorkerModules(): Promise<Array<{ slug: string; module: EngineWorkerModule }>> {
  const out: Array<{ slug: string; module: EngineWorkerModule }> = [];
  for (const slug of ENGINE_SLUGS) {
    try {
      const mod = (await import(`../engines/${slug}/worker.ts`)) as { worker?: EngineWorkerModule };
      if (mod.worker) out.push({ slug, module: mod.worker });
    } catch (err) {
      if (isModuleNotFound(err, `${slug}/worker`)) continue; // engine has no worker module yet
      throw err;
    }
  }
  return out;
}

export interface HookRunReport {
  name: string;
  ok: boolean;
  summary?: Record<string, unknown>;
  error?: string;
}

/**
 * Run each hook for one tenant in its OWN tenant transaction, so one failing
 * hook rolls back only its own work and never stops the others. Failures are
 * reported, not swallowed silently.
 */
export async function runTenantHooks(
  tenantId: string,
  hooks: readonly TenantTickHook[],
  runInTenant: <T>(tenantId: string, fn: (tx: TenantTx) => Promise<T>) => Promise<T>,
  now: Date
): Promise<HookRunReport[]> {
  const reports: HookRunReport[] = [];
  for (const hook of hooks) {
    try {
      const summary = await runInTenant(tenantId, (tx) => hook.run({ tx, tenantId, now }));
      reports.push({ name: hook.name, ok: true, ...(summary ? { summary } : {}) });
    } catch (err) {
      reports.push({ name: hook.name, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return reports;
}
