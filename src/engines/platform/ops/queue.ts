// c37 — database side of the ops queue. Reads only; every query runs in a
// withTenant() transaction and filters tenantId explicitly.

import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, or } from "drizzle-orm";
import { scheduledTasks, users } from "@/db/schema";
import { flags, notificationOutbox, tasks } from "@/db/tables/foundation";
import type { TenantTx } from "@/tenancy/withTenant";
import { engineSetting, getFirmSettings, toBusinessCalendar, type FirmSettings } from "@/core/firmSettings";
import { buildAttentionQueue, DEFAULT_OPS_SETTINGS, type AttentionItem, type AttentionSummary, type OpsSlaSettings } from "./attention";

export const OPS_ENGINE = "platform";
const ROW_LIMIT = 500;
/** Open tasks due within this many REAL days are loaded (business "due soon" can span a weekend). */
const TASK_HORIZON_DAYS = 7;
const NOTIFICATION_LOOKBACK_DAYS = 14;
const CHECK_BACK_LOOKBACK_DAYS = 7;

export function opsSettingsFrom(settings: FirmSettings): OpsSlaSettings {
  return {
    dueSoonBusinessHours: settings.dueSoonBusinessHours,
    overdueGraceBusinessHours: settings.overdueGraceBusinessHours,
    scheduledLagMinutes: engineSetting(settings, OPS_ENGINE, "scheduledLagMinutes", DEFAULT_OPS_SETTINGS.scheduledLagMinutes),
    stuckClaimMinutes: engineSetting(settings, OPS_ENGINE, "stuckClaimMinutes", DEFAULT_OPS_SETTINGS.stuckClaimMinutes),
    flagAckMinutes: {
      ...DEFAULT_OPS_SETTINGS.flagAckMinutes,
      ...engineSetting<Partial<OpsSlaSettings["flagAckMinutes"]>>(settings, OPS_ENGINE, "flagAckMinutes", {}),
    },
  };
}

export async function loadScheduledTaskRows(tx: TenantTx, tenantId: string, now: Date) {
  return tx
    .select()
    .from(scheduledTasks)
    .where(
      and(
        eq(scheduledTasks.tenantId, tenantId),
        isNull(scheduledTasks.completedAt),
        isNull(scheduledTasks.cancelledAt),
        lte(scheduledTasks.dueAt, now)
      )
    )
    .orderBy(asc(scheduledTasks.dueAt))
    .limit(ROW_LIMIT);
}

export interface AttentionQueue {
  generatedAt: string;
  items: AttentionItem[];
  summary: AttentionSummary;
  truncated: boolean;
}

export async function loadAttentionQueue(tx: TenantTx, tenantId: string, now = new Date()): Promise<AttentionQueue> {
  const settings = await getFirmSettings(tx, tenantId);
  const horizon = new Date(now.getTime() + TASK_HORIZON_DAYS * 86_400_000);

  const [taskRows, flagRows, scheduledRows, notificationRows] = await Promise.all([
    tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.tenantId, tenantId), eq(tasks.status, "open"), lte(tasks.dueAt, horizon)))
      .orderBy(asc(tasks.dueAt))
      .limit(ROW_LIMIT),
    tx
      .select()
      .from(flags)
      .where(
        and(
          eq(flags.tenantId, tenantId),
          or(
            isNull(flags.resolvedAt),
            and(
              isNotNull(flags.checkBackAt),
              lte(flags.checkBackAt, now),
              gte(flags.checkBackAt, new Date(now.getTime() - CHECK_BACK_LOOKBACK_DAYS * 86_400_000))
            )
          )
        )
      )
      .orderBy(desc(flags.createdAt))
      .limit(ROW_LIMIT),
    loadScheduledTaskRows(tx, tenantId, now),
    tx
      .select({
        id: notificationOutbox.id,
        status: notificationOutbox.status,
        channel: notificationOutbox.channel,
        templateKey: notificationOutbox.templateKey,
        matterId: notificationOutbox.matterId,
        lastError: notificationOutbox.lastError,
        createdAt: notificationOutbox.createdAt,
      })
      .from(notificationOutbox)
      .where(
        and(
          eq(notificationOutbox.tenantId, tenantId),
          inArray(notificationOutbox.status, ["failed", "bounced", "held"]),
          gte(notificationOutbox.createdAt, new Date(now.getTime() - NOTIFICATION_LOOKBACK_DAYS * 86_400_000))
        )
      )
      .limit(ROW_LIMIT),
  ]);

  const { items, summary } = buildAttentionQueue({
    tasks: taskRows,
    flags: flagRows,
    scheduled: scheduledRows,
    notifications: notificationRows,
    now,
    calendar: toBusinessCalendar(settings),
    settings: opsSettingsFrom(settings),
  });
  const truncated = [taskRows, flagRows, scheduledRows, notificationRows].some((r) => r.length >= ROW_LIMIT);
  return { generatedAt: now.toISOString(), items, summary, truncated };
}

export async function listFirmAdminIds(tx: TenantTx, tenantId: string): Promise<string[]> {
  const rows = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.tenantId, tenantId), eq(users.role, "firm_admin"), eq(users.status, "active")));
  return rows.map((r) => r.id);
}
