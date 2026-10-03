// Worker hooks of the calendar-alerts engine (discovered automatically by
// src/worker/hooks.ts; ADR-0001 D6). Each hook runs once per active firm per
// tick in its own tenant transaction, so one failing hook never stops the
// others. Every hook is idempotent: re-running a tick never double-flags.

import type { EngineWorkerModule } from "@/worker/hooks";
import { jobIsDue, lastJobRun, loadContext, markJobRun } from "./common";
import { ENGINE } from "./settings";
import { processReplyClocks } from "./replyClock/service";
import { runOverdueScan } from "./overdue/service";
import { processDueLadders } from "./ladder/service";
import { runStallSweep } from "./stall/service";
import { computeMatterHealth, runHealthJob } from "./health/service";
import { runDeliveryWatch, runDigest } from "./delivery/service";
import { pollCourtSources, processNoticeEscalations } from "./courtNotice/service";

const HOUR_MS = 3_600_000;

/** scheduled_tasks type another engine may enqueue to ask for a health recompute ({ matterId }). */
export const HEALTH_RECOMPUTE_TASK = "calendar-alerts.health_recompute";

export const worker: EngineWorkerModule = {
  tickHooks: [
    {
      // c64: poll installed court-mail sources (stubs are skipped; real ones are vendor-gated).
      name: "calendar-alerts.court_mail_poll",
      engine: ENGINE,
      run: async ({ tx, tenantId, now }) => pollCourtSources(tx, await loadContext(tx, tenantId), tenantId, now),
    },
    {
      // c64: unacknowledged court-notice alerts → backup lawyer → owner/admin (real clock).
      name: "calendar-alerts.court_notice_escalation",
      engine: ENGINE,
      run: async ({ tx, tenantId, now }) => ({ ...(await processNoticeEscalations(tx, await loadContext(tx, tenantId), tenantId, now)) }),
    },
    {
      // c43/c44: reply-clock checkpoints and the unacknowledged safety-net re-alert.
      name: "calendar-alerts.reply_clocks",
      engine: ENGINE,
      run: async ({ tx, tenantId, now }) => ({ ...(await processReplyClocks(tx, await loadContext(tx, tenantId), tenantId, now)) }),
    },
    {
      // c45/c46: one overdue mechanism for every task in the product.
      name: "calendar-alerts.overdue_scan",
      engine: ENGINE,
      run: async ({ tx, tenantId, now }) => ({ ...(await runOverdueScan(tx, await loadContext(tx, tenantId), tenantId, now)) }),
    },
    {
      // c42/c46: neutral reminders, then the lawyer decides.
      name: "calendar-alerts.client_ladders",
      engine: ENGINE,
      run: async ({ tx, tenantId, now }) => ({ ...(await processDueLadders(tx, await loadContext(tx, tenantId), tenantId, now)) }),
    },
    {
      // c47: hourly stalled-workflow sweep.
      name: "calendar-alerts.stall_sweep",
      engine: ENGINE,
      run: async ({ tx, tenantId, now }) => {
        if (!jobIsDue(await lastJobRun(tx, tenantId, "stall_sweep"), now, HOUR_MS)) return { skipped: "not due" };
        const result = await runStallSweep(tx, await loadContext(tx, tenantId), tenantId, now);
        await markJobRun(tx, tenantId, "stall_sweep", now, { ...result });
        return result;
      },
    },
    {
      // c53: nightly health recompute.
      name: "calendar-alerts.health",
      engine: ENGINE,
      run: async ({ tx, tenantId, now }) => runHealthJob(tx, await loadContext(tx, tenantId), tenantId, now),
    },
    {
      // c51: bounce / failure / no-safe-address follow-ups.
      name: "calendar-alerts.delivery_watch",
      engine: ENGINE,
      run: async ({ tx, tenantId, now }) => ({ ...(await runDeliveryWatch(tx, await loadContext(tx, tenantId), tenantId, now)) }),
    },
    {
      // c51: daily digest of non-urgent internal flag emails (firm setting, default off).
      name: "calendar-alerts.digest",
      engine: ENGINE,
      run: async ({ tx, tenantId, now }) => runDigest(tx, await loadContext(tx, tenantId), tenantId, now),
    },
  ],
  scheduledTaskHandlers: {
    [HEALTH_RECOMPUTE_TASK]: async ({ tx, tenantId, task, now }) => {
      const matterId = (task.payload as { matterId?: unknown }).matterId;
      if (typeof matterId === "string") await computeMatterHealth(tx, await loadContext(tx, tenantId), tenantId, matterId, now);
    },
  },
};
