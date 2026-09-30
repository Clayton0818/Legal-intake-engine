// c37 — the ops "attention needed" queue. Pure: turns rows from tasks, flags,
// scheduled_tasks and notification_outbox into one sorted list for staff.
//
// Internal only (founder decision: firm-side overdue flags are internal).
// Nothing here is ever rendered to a client.
//
// Clocks: task timing comes from core's computeTaskTiming (business hours
// unless the task is deadline-critical). Flag acknowledgement SLAs count
// BUSINESS minutes, except critical/urgent flags, which use the real clock
// (they are deadline safety nets / court notices). Worker health
// (scheduled_tasks) is infrastructure and always uses the real clock.

import { businessHoursBetween, type BusinessCalendar } from "@/core/businessHours";
import { computeTaskTiming, type TaskRow } from "@/core/tasks";
import type { FlagRow } from "@/core/flags";
import type { FlagSeverity } from "@/core/flags";
import type { ScheduledTaskRow } from "@/worker/hooks";

export type AttentionSource = "task" | "flag" | "scheduled_task" | "notification";

export interface AttentionItem {
  /** Stable key: `${source}:${id}` (or a group key for notification summaries). */
  key: string;
  source: AttentionSource;
  id: string | null;
  kind: string;
  severity: FlagSeverity;
  /** Machine reason, e.g. 'task_overdue', 'flag_unacknowledged', 'worker_retrying'. */
  reason: AttentionReason;
  title: string;
  detail: string;
  matterId: string | null;
  dueAt: Date | null;
  /** Hours on the relevant clock: overdue hours, unacknowledged hours, or lag. */
  hours: number;
  clock: "business" | "real";
  /** True when an SLA is breached (vs merely approaching). */
  breached: boolean;
  canAcknowledge: boolean;
}

export type AttentionReason =
  | "task_due_soon"
  | "task_overdue"
  | "task_overdue_escalate"
  | "flag_open"
  | "flag_unacknowledged"
  | "flag_check_back_due"
  | "worker_retrying"
  | "worker_stuck"
  | "delivery_failed"
  | "delivery_held";

export interface OpsSlaSettings {
  dueSoonBusinessHours: number;
  overdueGraceBusinessHours: number;
  /** A due scheduled task still unclaimed this long after dueAt is a retry loop / dead worker. */
  scheduledLagMinutes: number;
  /** Claimed but not completed for this long = stuck. */
  stuckClaimMinutes: number;
  /** Acknowledgement SLA per severity, in minutes (business minutes for info/warning/high, real for critical). */
  flagAckMinutes: Record<FlagSeverity, number>;
}

export const DEFAULT_OPS_SETTINGS: Omit<OpsSlaSettings, "dueSoonBusinessHours" | "overdueGraceBusinessHours"> = {
  scheduledLagMinutes: 10,
  stuckClaimMinutes: 30,
  flagAckMinutes: { info: 24 * 60, warning: 8 * 60, high: 120, critical: 15 },
};

const SEVERITY_RANK: Record<FlagSeverity, number> = { critical: 3, high: 2, warning: 1, info: 0 };

export function severityRank(s: FlagSeverity): number {
  return SEVERITY_RANK[s];
}

type TaskLike = Pick<TaskRow, "id" | "kind" | "title" | "matterId" | "dueAt" | "status" | "usesBusinessHours" | "deadlineCritical" | "ownerType">;

export function taskAttention(tasks: readonly TaskLike[], now: Date, cal: BusinessCalendar, s: OpsSlaSettings): AttentionItem[] {
  const out: AttentionItem[] = [];
  for (const t of tasks) {
    const timing = computeTaskTiming(t, now, cal, s);
    if (timing.state === "closed" || timing.state === "not_due" || !timing.severity) continue;
    const reason: AttentionReason =
      timing.state === "due_soon" ? "task_due_soon" : timing.state === "overdue" ? "task_overdue" : "task_overdue_escalate";
    const owner = t.ownerType === "client" ? "waiting on client" : t.ownerType === "firm" ? "firm queue" : "assigned";
    out.push({
      key: `task:${t.id}`,
      source: "task",
      id: t.id,
      kind: t.kind,
      severity: timing.severity,
      reason,
      title: t.title,
      detail:
        timing.state === "due_soon"
          ? `Due in ${round(timing.hoursUntilDue)} ${timing.clock} h (${owner})`
          : `Overdue by ${round(timing.overdueHours)} ${timing.clock} h (${owner})`,
      matterId: t.matterId,
      dueAt: t.dueAt,
      hours: timing.state === "due_soon" ? timing.hoursUntilDue : timing.overdueHours,
      clock: timing.clock,
      breached: timing.state !== "due_soon",
      canAcknowledge: false,
    });
  }
  return out;
}

type FlagLike = Pick<
  FlagRow,
  "id" | "type" | "severity" | "title" | "summary" | "matterId" | "urgent" | "acknowledgedAt" | "resolvedAt" | "checkBackAt" | "createdAt"
>;

function asSeverity(v: string): FlagSeverity {
  return v === "critical" || v === "high" || v === "warning" ? v : "info";
}

export function flagAttention(flags: readonly FlagLike[], now: Date, cal: BusinessCalendar, s: OpsSlaSettings): AttentionItem[] {
  const out: AttentionItem[] = [];
  for (const f of flags) {
    const severity = asSeverity(f.severity);
    if (f.resolvedAt) {
      // Resolved with a check-back date that has arrived: someone promised to look again.
      if (f.checkBackAt && f.checkBackAt.getTime() <= now.getTime()) {
        out.push({
          key: `flag:${f.id}`,
          source: "flag",
          id: f.id,
          kind: f.type,
          severity: severity === "info" ? "warning" : severity,
          reason: "flag_check_back_due",
          title: f.title,
          detail: "Resolved with a check-back date that has now arrived.",
          matterId: f.matterId,
          dueAt: f.checkBackAt,
          hours: (now.getTime() - f.checkBackAt.getTime()) / 3_600_000,
          clock: "real",
          breached: true,
          canAcknowledge: false,
        });
      }
      continue;
    }
    const realClock = severity === "critical" || f.urgent;
    const openHours = realClock ? (now.getTime() - f.createdAt.getTime()) / 3_600_000 : businessHoursBetween(f.createdAt, now, cal);
    const unacked = !f.acknowledgedAt;
    const breached = unacked && openHours * 60 >= s.flagAckMinutes[severity];
    out.push({
      key: `flag:${f.id}`,
      source: "flag",
      id: f.id,
      kind: f.type,
      severity,
      reason: breached ? "flag_unacknowledged" : "flag_open",
      title: f.title,
      detail: unacked
        ? `Not acknowledged after ${round(openHours)} ${realClock ? "real" : "business"} h`
        : (f.summary ?? "Acknowledged, not yet resolved"),
      matterId: f.matterId,
      dueAt: null,
      hours: openHours,
      clock: realClock ? "real" : "business",
      breached,
      canAcknowledge: unacked,
    });
  }
  return out;
}

type ScheduledLike = Pick<ScheduledTaskRow, "id" | "taskType" | "dueAt" | "claimedAt" | "completedAt" | "cancelledAt" | "matterId">;

export function scheduledTaskAttention(rows: readonly ScheduledLike[], now: Date, s: OpsSlaSettings): AttentionItem[] {
  const out: AttentionItem[] = [];
  for (const r of rows) {
    if (r.completedAt || r.cancelledAt) continue;
    if (!r.claimedAt) {
      const lagMin = (now.getTime() - r.dueAt.getTime()) / 60_000;
      if (lagMin < s.scheduledLagMinutes) continue;
      out.push({
        key: `scheduled_task:${r.id}`,
        source: "scheduled_task",
        id: r.id,
        kind: r.taskType,
        severity: lagMin >= 6 * s.scheduledLagMinutes ? "high" : "warning",
        reason: "worker_retrying",
        title: `Background job ${r.taskType} has not run`,
        detail: `Due ${Math.round(lagMin)} min ago and still unclaimed — its handler is failing and retrying, or the worker is not running.`,
        matterId: r.matterId,
        dueAt: r.dueAt,
        hours: lagMin / 60,
        clock: "real",
        breached: true,
        canAcknowledge: false,
      });
    } else {
      const heldMin = (now.getTime() - r.claimedAt.getTime()) / 60_000;
      if (heldMin < s.stuckClaimMinutes) continue;
      out.push({
        key: `scheduled_task:${r.id}`,
        source: "scheduled_task",
        id: r.id,
        kind: r.taskType,
        severity: "high",
        reason: "worker_stuck",
        title: `Background job ${r.taskType} is stuck`,
        detail: `Claimed ${Math.round(heldMin)} min ago and never completed.`,
        matterId: r.matterId,
        dueAt: r.dueAt,
        hours: heldMin / 60,
        clock: "real",
        breached: true,
        canAcknowledge: false,
      });
    }
  }
  return out;
}

export interface NotificationLike {
  id: string;
  status: string;
  channel: string;
  templateKey: string;
  matterId: string | null;
  lastError: string | null;
  createdAt: Date;
}

/** Failed/bounced deliveries individually; held rows as one summary per template. */
export function notificationAttention(rows: readonly NotificationLike[], now: Date): AttentionItem[] {
  const out: AttentionItem[] = [];
  const held = new Map<string, { count: number; oldest: Date; reason: string | null }>();
  for (const r of rows) {
    if (r.status === "failed" || r.status === "bounced") {
      out.push({
        key: `notification:${r.id}`,
        source: "notification",
        id: r.id,
        kind: `${r.channel}.${r.status}`,
        severity: "warning",
        reason: "delivery_failed",
        title: `${r.channel === "sms" ? "Text" : r.channel === "email" ? "Email" : "Notification"} ${r.status}`,
        // lastError is a provider/system message; never client content (payloads are ids only).
        detail: r.lastError ? r.lastError.slice(0, 200) : `Template ${r.templateKey}`,
        matterId: r.matterId,
        dueAt: null,
        hours: (now.getTime() - r.createdAt.getTime()) / 3_600_000,
        clock: "real",
        breached: true,
        canAcknowledge: false,
      });
    } else if (r.status === "held") {
      const g = held.get(r.templateKey) ?? { count: 0, oldest: r.createdAt, reason: r.lastError };
      g.count += 1;
      if (r.createdAt < g.oldest) g.oldest = r.createdAt;
      held.set(r.templateKey, g);
    }
  }
  for (const [templateKey, g] of held) {
    out.push({
      key: `notification:held:${templateKey}`,
      source: "notification",
      id: null,
      kind: "held",
      severity: "info",
      reason: "delivery_held",
      title: `${g.count} notification${g.count === 1 ? "" : "s"} held (${templateKey})`,
      detail: g.reason ? g.reason.slice(0, 200) : "Held until the required approval is recorded.",
      matterId: null,
      dueAt: null,
      hours: (now.getTime() - g.oldest.getTime()) / 3_600_000,
      clock: "real",
      breached: false,
      canAcknowledge: false,
    });
  }
  return out;
}

/** Sort: severity, then breached, then longest waiting. Pure, stable. */
export function sortAttention(items: readonly AttentionItem[]): AttentionItem[] {
  return [...items].sort(
    (a, b) =>
      severityRank(b.severity) - severityRank(a.severity) ||
      Number(b.breached) - Number(a.breached) ||
      b.hours - a.hours ||
      a.key.localeCompare(b.key)
  );
}

export interface AttentionSummary {
  total: number;
  breached: number;
  bySeverity: Record<FlagSeverity, number>;
  bySource: Record<AttentionSource, number>;
}

export function summarizeAttention(items: readonly AttentionItem[]): AttentionSummary {
  const bySeverity: Record<FlagSeverity, number> = { critical: 0, high: 0, warning: 0, info: 0 };
  const bySource: Record<AttentionSource, number> = { task: 0, flag: 0, scheduled_task: 0, notification: 0 };
  let breached = 0;
  for (const i of items) {
    bySeverity[i.severity] += 1;
    bySource[i.source] += 1;
    if (i.breached) breached += 1;
  }
  return { total: items.length, breached, bySeverity, bySource };
}

export function buildAttentionQueue(input: {
  tasks: readonly TaskLike[];
  flags: readonly FlagLike[];
  scheduled: readonly ScheduledLike[];
  notifications: readonly NotificationLike[];
  now: Date;
  calendar: BusinessCalendar;
  settings: OpsSlaSettings;
}): { items: AttentionItem[]; summary: AttentionSummary } {
  const items = sortAttention([
    ...taskAttention(input.tasks, input.now, input.calendar, input.settings),
    ...flagAttention(input.flags, input.now, input.calendar, input.settings),
    ...scheduledTaskAttention(input.scheduled, input.now, input.settings),
    ...notificationAttention(input.notifications, input.now),
  ]);
  return { items, summary: summarizeAttention(items) };
}

function round(h: number): number {
  return Math.round(h * 10) / 10;
}
