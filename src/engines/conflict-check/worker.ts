// Worker hooks of the Conflict-check engine (discovered automatically by
// src/worker/hooks.ts; ADR-0001 D6). Each hook runs once per active firm per
// tick in its own tenant transaction.

import type { EngineWorkerModule } from "@/worker/hooks";
import { flagLateStartDates } from "./lateralService";
import { EXPORT_TASK_TYPE, generateExport } from "./logService";
import { ENGINE } from "./settings";
import { syncMatterParties } from "./sync";
import { ensureMaintenanceQueued, MAINTENANCE_TASK_TYPE, runDailyMaintenance, runWaiverTimers } from "./timers";

export const worker: EngineWorkerModule = {
  tickHooks: [
    {
      // c56 §4.4 / c58: parties added to matters by any engine are indexed and checked.
      name: "conflict-check.index_sync",
      engine: ENGINE,
      run: async ({ tx, tenantId, now }) => ({ ...(await syncMatterParties(tx, tenantId, now)) }),
    },
    {
      // c59 §4.4: waiver reminders and the outer limit (business hours).
      name: "conflict-check.waiver_timers",
      engine: ENGINE,
      run: async ({ tx, tenantId, now }) => runWaiverTimers(tx, tenantId, now),
    },
    {
      // c61 §4.4: start date reached before the lateral check is complete.
      name: "conflict-check.lateral_start_dates",
      engine: ENGINE,
      run: async ({ tx, tenantId, now }) => ({ flagged: await flagLateStartDates(tx, tenantId, now) }),
    },
    {
      name: "conflict-check.ensure_maintenance",
      engine: ENGINE,
      run: async ({ tx, tenantId, now }) => ({ queued: await ensureMaintenanceQueued(tx, tenantId, now) }),
    },
  ],
  scheduledTaskHandlers: {
    // c63 §4.3: exports are built in the background with the requester's current access.
    [EXPORT_TASK_TYPE]: async ({ tx, tenantId, task, now }) => {
      const exportId = (task.payload as { exportId?: unknown }).exportId;
      if (typeof exportId === "string") await generateExport(tx, tenantId, exportId, now);
    },
    [MAINTENANCE_TASK_TYPE]: async ({ tx, tenantId, now }) => {
      await runDailyMaintenance(tx, tenantId, now);
    },
  },
};
