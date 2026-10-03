// Worker hooks of the calendar-core engine (discovered automatically by
// src/worker/hooks.ts; ADR-0001 D6). Each hook runs once per active firm per
// tick, in its own tenant transaction. All limitation work is on the REAL
// clock and idempotent per local day (dedupe keys), so a frequent tick is safe.

import type { EngineWorkerModule } from "@/worker/hooks";
import { getFirmSettings } from "@/core";
import { ENGINE, readCalendarCoreSettings } from "./settings";
import { runLimitationCoverageScan, runLimitationScan } from "./limitations/service";
import { runInboundSync, runOutboundSync } from "./calendar/sync";
import { releaseReadyItems } from "./templates/taskListService";

export const worker: EngineWorkerModule = {
  tickHooks: [
    {
      // c93: daily flag for unverified/disputed dates, escalating reminders, passed dates.
      name: "calendar-core.limitation_scan",
      engine: ENGINE,
      run: async ({ tx, tenantId, now }) => ({ ...(await runLimitationScan(tx, tenantId, now)) }),
    },
    {
      // c93 + c66: matters with no limitation decision, and intake deadline-risk alerts.
      name: "calendar-core.limitation_coverage",
      engine: ENGINE,
      run: async ({ tx, tenantId, now }) => ({ ...(await runLimitationCoverageScan(tx, tenantId, now)) }),
    },
    {
      // c91: push pending changes to Outlook/Google (held while vendor.calendar_sync is pending).
      name: "calendar-core.sync_outbound",
      engine: ENGINE,
      run: async ({ tx, tenantId, now }) => {
        const s = readCalendarCoreSettings(await getFirmSettings(tx, tenantId));
        return { ...(await runOutboundSync(tx, tenantId, { now, maxAttempts: s.syncMaxAttempts })) };
      },
    },
    {
      // c91: pull lawyers' own calendar changes (held while vendor.calendar_sync is pending).
      name: "calendar-core.sync_inbound",
      engine: ENGINE,
      run: async ({ tx, tenantId, now }) => {
        const s = readCalendarCoreSettings(await getFirmSettings(tx, tenantId));
        return { ...(await runInboundSync(tx, tenantId, { now, windowDays: s.syncWindowDays })) };
      },
    },
    {
      // c94: create dependent tasks once their prerequisites are done.
      name: "calendar-core.task_list_release",
      engine: ENGINE,
      run: async ({ tx, tenantId, now }) => ({ ...(await releaseReadyItems(tx, tenantId, now)) }),
    },
  ],
};
