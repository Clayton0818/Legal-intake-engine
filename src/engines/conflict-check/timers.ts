// Timers of the Conflict-check engine, run by the worker (./worker.ts).
//
// - Waiver reminders and the outer limit (c59 §4.4 steps 4–6), counted in
//   firm BUSINESS hours (founder decision).
// - Daily maintenance (c56 dedupe scan, c62 narrative purge, c97
//   re-confirmations), queued as one scheduled task per firm per day.
//
// Decision-task and letter-task overdue flags are NOT here: those are
// ordinary tasks with due times, and c45's single overdue mechanism flags
// them (internal only, with the minimal email every flag carries).

import { and, eq, isNull } from "drizzle-orm";
import { scheduledTasks } from "@/db/schema";
import { conflictWaivers } from "@/db/tables/conflict-check";
import { addBusinessHours, audit, enqueueNotification, getFirmSettings, toBusinessCalendar, SYSTEM_ACTOR } from "@/core";
import { NOTIFY_COPY_GATES } from "@/compliance/gates";
import type { TenantTx } from "@/tenancy/withTenant";
import { waiverTimerAction } from "./decisions";
import { afterWaiverChange, returnToAttorney } from "./decisionService";
import { queueReconfirmations } from "./interestService";
import { purgeDeclinedNarratives } from "./letterService";
import { runDedupeScan } from "./partyIndex";
import { ENGINE, readConflictSettings } from "./settings";
import { completeTasksByRef } from "./util";

export const MAINTENANCE_TASK_TYPE = "conflict-check.daily_maintenance";
export const MAINTENANCE_INTERVAL_HOURS = 24;

export async function runWaiverTimers(tx: TenantTx, tenantId: string, now: Date): Promise<{ reminded: number; expired: number }> {
  const sent = await tx
    .select()
    .from(conflictWaivers)
    .where(and(eq(conflictWaivers.tenantId, tenantId), eq(conflictWaivers.status, "sent")));
  if (sent.length === 0) return { reminded: 0, expired: 0 };
  const firmSettings = await getFirmSettings(tx, tenantId);
  const settings = readConflictSettings(firmSettings);
  const calendar = toBusinessCalendar(firmSettings);
  const nextReminderAt = (from: Date) => addBusinessHours(from, settings.waiverReminderBusinessHours, calendar);

  let reminded = 0;
  let expired = 0;
  for (const w of sent) {
    const action = waiverTimerAction(w, now, nextReminderAt);
    if (action === "remind") {
      // Neutral reminder to the client's DV-safe address; ids only, wording from the reviewed gate.
      await enqueueNotification(
        tx,
        {
          tenantId,
          channel: "email",
          recipient: { type: "party", partyId: w.clientPartyId },
          templateKey: NOTIFY_COPY_GATES.reminder.key,
          payload: w.documentId ? { documentId: w.documentId } : {},
          sensitive: true,
          dedupeKey: `conflict-check.waiver_reminder:${w.id}:${now.toISOString()}`,
        },
        { now }
      );
      await tx.update(conflictWaivers).set({ lastReminderAt: now, updatedAt: now }).where(eq(conflictWaivers.id, w.id));
      await audit(tx, { tenantId, engine: ENGINE, action: "waiver.reminded", entityType: "conflict_waiver", entityId: w.id });
      reminded++;
    } else if (action === "outer_limit") {
      const [row] = await tx
        .update(conflictWaivers)
        .set({ status: "expired", updatedAt: now })
        .where(eq(conflictWaivers.id, w.id))
        .returning();
      await audit(tx, { tenantId, engine: ENGINE, action: "waiver.expired", entityType: "conflict_waiver", entityId: w.id });
      await completeTasksByRef(tx, {
        tenantId,
        kind: "conflict-check.waiver_signature_due",
        sourceRef: `conflict_waiver:${w.id}`,
        by: SYSTEM_ACTOR,
        reason: "Outer limit reached; returned to the conflicts attorney",
        at: now,
      });
      await returnToAttorney(tx, row!, "A consent document was not signed in time", now);
      await afterWaiverChange(tx, row!, now);
      expired++;
    }
  }
  return { reminded, expired };
}

/** Make sure one maintenance task is pending for the firm (bootstrap and recovery). */
export async function ensureMaintenanceQueued(tx: TenantTx, tenantId: string, now: Date): Promise<boolean> {
  const [pending] = await tx
    .select({ id: scheduledTasks.id })
    .from(scheduledTasks)
    .where(
      and(
        eq(scheduledTasks.tenantId, tenantId),
        eq(scheduledTasks.taskType, MAINTENANCE_TASK_TYPE),
        isNull(scheduledTasks.completedAt),
        isNull(scheduledTasks.cancelledAt)
      )
    )
    .limit(1);
  if (pending) return false;
  await tx.insert(scheduledTasks).values({ tenantId, taskType: MAINTENANCE_TASK_TYPE, dueAt: now, payload: {} });
  return true;
}

/** The daily maintenance body. Queues the next run before returning. */
export async function runDailyMaintenance(tx: TenantTx, tenantId: string, now: Date) {
  const suggestions = await runDedupeScan(tx, tenantId);
  // Gated on rules.retention_periods: blocked and logged (once a day) until approved.
  const purge = await purgeDeclinedNarratives(tx, tenantId, now);
  const reconfirmations = await queueReconfirmations(tx, tenantId, now);
  await tx.insert(scheduledTasks).values({
    tenantId,
    taskType: MAINTENANCE_TASK_TYPE,
    dueAt: new Date(now.getTime() + MAINTENANCE_INTERVAL_HOURS * 3_600_000),
    payload: {},
  });
  return { suggestions, purge, reconfirmations };
}
