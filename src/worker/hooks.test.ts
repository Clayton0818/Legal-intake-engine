import { describe, it, expect } from "vitest";
import { buildRegistry, CORE_TICK_HOOKS, loadEngineWorkerModules, runTenantHooks, type TenantTickHook } from "./hooks";
import type { TenantTx } from "@/tenancy/withTenant";

const noop = async () => {};

describe("buildRegistry", () => {
  it("always includes the core notification drain", () => {
    const reg = buildRegistry([]);
    expect(reg.hooks.map((h) => h.name)).toEqual(["core.notification_outbox"]);
    expect(CORE_TICK_HOOKS).toHaveLength(1);
  });

  it("adds engine hooks and scheduled-task handlers", () => {
    const reg = buildRegistry([
      {
        slug: "calendar-alerts",
        module: {
          tickHooks: [{ name: "calendar-alerts.overdue_scan", engine: "calendar-alerts", run: noop }],
          scheduledTaskHandlers: { "calendar-alerts.reminder": noop },
        },
      },
    ]);
    expect(reg.hooks.map((h) => h.name)).toContain("calendar-alerts.overdue_scan");
    expect(reg.handlers.get("calendar-alerts.reminder")?.engine).toBe("calendar-alerts");
  });

  it("requires engine-prefixed names and rejects duplicates", () => {
    expect(() =>
      buildRegistry([{ slug: "intake", module: { tickHooks: [{ name: "overdue_scan", engine: "intake", run: noop }] } }])
    ).toThrow(/must be named 'intake.<name>'/);
    expect(() => buildRegistry([{ slug: "intake", module: { scheduledTaskHandlers: { "billing-trust.x": noop } } }])).toThrow(
      /must be 'intake.<name>'/
    );
    const hook = { name: "intake.scan", engine: "intake" as const, run: noop };
    expect(() => buildRegistry([{ slug: "intake", module: { tickHooks: [hook, hook] } }])).toThrow(/Duplicate/);
  });
});

describe("loadEngineWorkerModules", () => {
  it("loads every engine's worker.ts and the result builds a valid registry", async () => {
    const modules = await loadEngineWorkerModules();
    // The conflict-check, intake and platform engines each ship a worker.ts.
    expect(modules.map((m) => m.slug)).toEqual(expect.arrayContaining(["conflict-check", "intake", "platform"]));
    // buildRegistry enforces engine-prefixed names and rejects duplicates,
    // so this also proves the real modules are well-formed.
    expect(() => buildRegistry(modules)).not.toThrow();
  });
});

describe("runTenantHooks", () => {
  it("runs each hook in its own tenant transaction and isolates failures", async () => {
    const fakeTx = {} as TenantTx;
    const calls: string[] = [];
    const runInTenant = async <T,>(tenantId: string, fn: (tx: TenantTx) => Promise<T>) => {
      calls.push(tenantId);
      return fn(fakeTx);
    };
    const hooks: TenantTickHook[] = [
      { name: "intake.a", engine: "intake", run: async () => ({ done: 1 }) },
      { name: "intake.b", engine: "intake", run: async () => { throw new Error("boom"); } },
      { name: "intake.c", engine: "intake", run: async ({ tenantId }) => ({ tenantId }) },
    ];
    const reports = await runTenantHooks("t-1", hooks, runInTenant, new Date());
    expect(calls).toEqual(["t-1", "t-1", "t-1"]);
    expect(reports).toEqual([
      { name: "intake.a", ok: true, summary: { done: 1 } },
      { name: "intake.b", ok: false, error: "boom" },
      { name: "intake.c", ok: true, summary: { tenantId: "t-1" } },
    ]);
  });
});
