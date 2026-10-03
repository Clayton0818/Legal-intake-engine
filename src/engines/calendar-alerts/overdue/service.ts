// c45 / c46 — the overdue scan (database side) and the staff views of
// overdue work. Runs every worker tick per firm; every step is idempotent
// (one open flag per task, due-soon notices deduplicated per due time,
// ladders unique per task), so a restarted worker never double-flags (c45
// acceptance 6).

import { and, eq, inArray, isNull } from "drizzle-orm";
import { matters, users } from "@/db/schema";
import { calendarEvents, flags, notificationOutbox } from "@/db/tables/foundation";
import { clientChaseLadders } from "@/db/tables/calendar-alerts";
import type { TenantTx } from "@/tenancy/withTenant";
import { NOTIFY_COPY_GATES } from "@/compliance/gates";
import { audit, type Actor } from "@/core/audit";
import { toBusinessCalendar } from "@/core/firmSettings";
import { enqueueNotification } from "@/core/notify";
import { escalateFlag } from "@/core/flags";
import { changeTaskDue, getTask, listClientTasks, listOpenTasks, type TaskRow } from "@/core/tasks";
import { legalCopy } from "@/compliance/approvals";
import { ALERT_COPY_GATES } from "../gates";
import { AlertRuleError, loadPeople, notifyClient, raiseAlert, type EngineContext } from "../common";
import { CLOCK_MANAGED_KINDS, FLAG_TYPES } from "../kinds";
import { ENGINE } from "../settings";
import { startLadderForTask } from "../ladder/service";
import { checkRedate, overdueRecipients, overdueSummary, planOverdue, taskTiming, type OverdueSettings } from "./plan";

/** How far ahead the scan looks for due-soon work (covers a long weekend of business hours). */
const LOOKAHEAD_MS = 14 * 86_400_000;

export function overdueFlagKey(taskId: string): string {
  return `${FLAG_TYPES.taskOverdue}:${taskId}`;
}

function dueSoonKey(task: Pick<TaskRow, "id" | "dueAt">): string {
  return `calendar-alerts.due_soon:${task.id}:${task.dueAt.toISOString()}`;
}

function overdueSettings(ctx: EngineContext): OverdueSettings {
  return {
    dueSoonBusinessHours: ctx.firm.dueSoonBusinessHours,
    overdueGraceBusinessHours: ctx.firm.overdueGraceBusinessHours,
    deadlineDueSoonRealHours: ctx.alerts.deadlineDueSoonRealHours,
    clientTaskDueSoonReminder: ctx.alerts.clientTaskDueSoonReminder,
  };
}

export interface ScanSummary {
  examined: number;
  dueSoon: number;
  flagged: number;
  escalated: number;
  critical: number;
  clientLapsed: number;
  clientDueSoon: number;
}

export async function runOverdueScan(tx: TenantTx, ctx: EngineContext, tenantId: string, now: Date): Promise<ScanSummary> {
  const summary: ScanSummary = { examined: 0, dueSoon: 0, flagged: 0, escalated: 0, critical: 0, clientLapsed: 0, clientDueSoon: 0 };
  const skip = new Set([...CLOCK_MANAGED_KINDS, ...ctx.alerts.selfManagedTaskKinds]);
  const open = (await listOpenTasks(tx, tenantId, { dueBefore: new Date(now.getTime() + LOOKAHEAD_MS), limit: 2000 })).filter((t) => !skip.has(t.kind));
  if (open.length === 0) return summary;
  const ids = open.map((t) => t.id);

  // Batch-load the state the plan needs.
  const flagRows = await tx
    .select({ dedupeKey: flags.dedupeKey, id: flags.id, escalationLevel: flags.escalationLevel, severity: flags.severity })
    .from(flags)
    .where(and(eq(flags.tenantId, tenantId), isNull(flags.resolvedAt), inArray(flags.dedupeKey, ids.map(overdueFlagKey))));
  const flagByKey = new Map(flagRows.map((f) => [f.dedupeKey, f]));
  const sentRows = await tx
    .select({ dedupeKey: notificationOutbox.dedupeKey })
    .from(notificationOutbox)
    .where(and(eq(notificationOutbox.tenantId, tenantId), inArray(notificationOutbox.dedupeKey, open.flatMap((t) => [`${dueSoonKey(t)}:in_app`]))));
  const sent = new Set(sentRows.map((r) => r.dedupeKey));
  const ladderRows = await tx
    .select({ taskId: clientChaseLadders.taskId })
    .from(clientChaseLadders)
    .where(and(eq(clientChaseLadders.tenantId, tenantId), inArray(clientChaseLadders.taskId, ids)));
  const ladders = new Set(ladderRows.map((r) => r.taskId));
  const eventIds = [...new Set(open.map((t) => t.relatedCalendarEventId).filter((x): x is string => Boolean(x)))];
  const events = eventIds.length
    ? await tx
        .select({ id: calendarEvents.id, status: calendarEvents.status, cancelledAt: calendarEvents.cancelledAt, startsAt: calendarEvents.startsAt })
        .from(calendarEvents)
        .where(and(eq(calendarEvents.tenantId, tenantId), inArray(calendarEvents.id, eventIds)))
    : [];
  const eventById = new Map(events.map((e) => [e.id, e]));
  const matterIds = [...new Set(open.map((t) => t.matterId).filter((x): x is string => Boolean(x)))];
  const matterRows = matterIds.length
    ? await tx.select({ id: matters.id, assignedUserId: matters.assignedUserId }).from(matters).where(and(eq(matters.tenantId, tenantId), inArray(matters.id, matterIds)))
    : [];
  const lawyerByMatter = new Map(matterRows.map((m) => [m.id, m.assignedUserId]));
  const userRows = await tx.select({ id: users.id, status: users.status }).from(users).where(eq(users.tenantId, tenantId));
  const activeUsers = new Set(userRows.filter((u) => u.status === "active").map((u) => u.id));
  const people = await loadPeople(tx, tenantId, ctx.alerts);
  const cal = toBusinessCalendar(ctx.firm);
  const settings = overdueSettings(ctx);

  for (const task of open) {
    summary.examined++;
    const flag = flagByKey.get(overdueFlagKey(task.id)) ?? null;
    const ev = task.relatedCalendarEventId ? eventById.get(task.relatedCalendarEventId) : undefined;
    const linkedEventLive = task.relatedCalendarEventId ? Boolean(ev && ev.status === "confirmed" && !ev.cancelledAt) : null;
    const { action, timing, critical } = planOverdue(
      task,
      { openFlag: flag, dueSoonSent: sent.has(`${dueSoonKey(task)}:in_app`), ladderExists: ladders.has(task.id), linkedEventLive },
      now,
      cal,
      settings
    );
    if (action.kind === "none") continue;

    // c45 rule 15: tell the owner once that the deadline link no longer holds.
    if (task.deadlineCritical && !critical) await noteLinkDropped(tx, ctx, task, people.admins, activeUsers, now);

    const supervisorId = [task.supervisorUserId, task.matterId ? lawyerByMatter.get(task.matterId) ?? null : null].find((id) => id && activeUsers.has(id)) ?? null;
    const route = (level: 1 | 2 | 3) =>
      overdueRecipients({
        level,
        ownerType: task.ownerType,
        ownerUserId: task.ownerUserId,
        ownerActive: Boolean(task.ownerUserId && activeUsers.has(task.ownerUserId)),
        supervisorId,
        adminIds: people.admins,
        managingIds: people.managing,
      });

    switch (action.kind) {
      case "due_soon": {
        const to = route(1);
        for (const userId of to.userIds) {
          for (const channel of ["in_app", "email"] as const) {
            await enqueueNotification(
              tx,
              {
                tenantId,
                channel,
                recipient: { type: "user", userId },
                templateKey: "calendar-alerts.task_due_soon",
                payload: {
                  taskId: task.id,
                  subject: critical ? `Due soon (deadline): ${task.title}` : `Due soon: ${task.title}`,
                  body: `"${task.title}" is due ${task.dueAt.toISOString()}.${critical ? " It is tied to a court date or deadline." : ""}`,
                },
                matterId: task.matterId,
                urgent: critical,
                // One notice per task per due time; the first recipient's in_app row is the marker.
                dedupeKey: userId === to.userIds[0] ? `${dueSoonKey(task)}:${channel}` : `${dueSoonKey(task)}:${userId}:${channel}`,
              },
              { now }
            );
          }
        }
        summary.dueSoon++;
        break;
      }
      case "flag_l1":
      case "flag_l3": {
        const level = action.kind === "flag_l3" ? 3 : 1;
        const to = route(level);
        await raiseAlert(
          tx,
          ctx,
          {
            tenantId,
            type: FLAG_TYPES.taskOverdue,
            severity: level === 3 ? "critical" : "warning",
            urgent: level === 3,
            audience: "internal",
            title: level === 3 ? `Deadline task overdue: ${task.title}` : `Task overdue: ${task.title}`,
            summary: overdueSummary({ title: task.title, timing, critical, pooled: to.pooled, noSupervisor: level === 3 && to.noSupervisor }),
            details: { taskId: task.id, kind: task.kind, dueAt: task.dueAt.toISOString(), level, clock: timing.clock },
            matterId: task.matterId,
            taskId: task.id,
            recipients: { userIds: to.userIds },
            dedupeKey: overdueFlagKey(task.id),
            sourceCard: "c45",
          },
          now
        );
        if (level === 3) summary.critical++;
        else summary.flagged++;
        break;
      }
      case "escalate": {
        if (!flag) break;
        const to = route(critical ? 3 : 2);
        await escalateFlag(tx, {
          tenantId,
          flagId: flag.id,
          addUserIds: to.userIds,
          severity: critical ? "critical" : "high",
          note: overdueSummary({ title: task.title, timing, critical, pooled: to.pooled, noSupervisor: to.noSupervisor }),
          engine: ENGINE,
          at: now,
        });
        summary.escalated++;
        break;
      }
      case "client_lapsed": {
        await startLadderForTask(tx, ctx, task, now);
        summary.clientLapsed++;
        break;
      }
      case "client_due_soon": {
        if (!task.ownerPartyId) break;
        await notifyClient(tx, ctx, {
          tenantId,
          partyId: task.ownerPartyId,
          matterId: task.matterId,
          templateKey: NOTIFY_COPY_GATES.reminder.key,
          payload: { taskId: task.id },
          dedupeKey: dueSoonKey(task),
          now,
          admins: people.admins,
        });
        summary.clientDueSoon++;
        break;
      }
    }
  }
  return summary;
}

async function noteLinkDropped(tx: TenantTx, ctx: EngineContext, task: TaskRow, admins: string[], active: Set<string>, now: Date): Promise<void> {
  const owner = task.ownerUserId && active.has(task.ownerUserId) ? task.ownerUserId : null;
  const recipients = owner ? [owner] : admins;
  if (recipients.length === 0) return;
  const res = await raiseAlert(
    tx,
    ctx,
    {
      tenantId: task.tenantId,
      type: FLAG_TYPES.deadlineLinkDropped,
      severity: "info",
      audience: "internal",
      title: `Deadline link removed: ${task.title}`,
      summary: "The calendar entry this task was tied to was cancelled or is no longer confirmed. The task is now treated as a standard task.",
      details: { taskId: task.id, calendarEventId: task.relatedCalendarEventId },
      matterId: task.matterId,
      taskId: task.id,
      recipients: { userIds: recipients },
      dedupeKey: `${FLAG_TYPES.deadlineLinkDropped}:${task.id}`,
      sourceCard: "c45",
      channels: ["in_app"],
    },
    now
  );
  if (res.created) {
    await audit(tx, { tenantId: task.tenantId, engine: ENGINE, action: "task.deadline_link_dropped", entityType: "task", entityId: task.id, matterId: task.matterId, reason: "Linked calendar entry cancelled or unconfirmed" });
  }
}

/** Re-date a task with a logged reason, refusing to move a deadline task past its court date (c45 rule 10). */
export async function redateTask(tx: TenantTx, input: { tenantId: string; taskId: string; dueAt: Date; by: Actor; reason: string }): Promise<TaskRow> {
  const reason = input.reason?.trim();
  if (!reason) throw new AlertRuleError("A reason is required to change a due time (c45: no silent clearing).");
  const task = await getTask(tx, input.tenantId, input.taskId);
  if (!task) throw new AlertRuleError("Task not found.", 404);
  let linked: { startsAt: Date; status: string; cancelledAt: Date | null } | null = null;
  if (task.relatedCalendarEventId) {
    const [ev] = await tx
      .select({ startsAt: calendarEvents.startsAt, status: calendarEvents.status, cancelledAt: calendarEvents.cancelledAt })
      .from(calendarEvents)
      .where(and(eq(calendarEvents.tenantId, input.tenantId), eq(calendarEvents.id, task.relatedCalendarEventId)))
      .limit(1);
    linked = ev ?? null;
  }
  const refusal = checkRedate(task, input.dueAt, linked);
  if (refusal) throw new AlertRuleError(refusal, 409);
  return changeTaskDue(tx, { tenantId: input.tenantId, taskId: task.id, dueAt: input.dueAt, by: input.by, reason, engine: ENGINE });
}

export interface OverdueView {
  task: Pick<TaskRow, "id" | "kind" | "title" | "matterId" | "dueAt" | "ownerType" | "ownerUserId" | "deadlineCritical" | "visibility">;
  state: string;
  overdueHours: number;
  clock: string;
}

/** Firm-side list of overdue / due-soon work. `userId` limits it to one person's own tasks (lawyers see their own; admins all). */
export async function listOverdueWork(tx: TenantTx, ctx: EngineContext, tenantId: string, now: Date, filter: { userId?: string; matterId?: string } = {}): Promise<OverdueView[]> {
  const rows = await listOpenTasks(tx, tenantId, { dueBefore: new Date(now.getTime() + LOOKAHEAD_MS), ownerUserId: filter.userId, matterId: filter.matterId, limit: 1000 });
  const cal = toBusinessCalendar(ctx.firm);
  const settings = overdueSettings(ctx);
  const eventIds = [...new Set(rows.map((t) => t.relatedCalendarEventId).filter((x): x is string => Boolean(x)))];
  const events = eventIds.length
    ? await tx.select({ id: calendarEvents.id, status: calendarEvents.status, cancelledAt: calendarEvents.cancelledAt }).from(calendarEvents).where(and(eq(calendarEvents.tenantId, tenantId), inArray(calendarEvents.id, eventIds)))
    : [];
  const live = new Map(events.map((e) => [e.id, e.status === "confirmed" && !e.cancelledAt]));
  const out: OverdueView[] = [];
  for (const t of rows) {
    const timing = taskTiming(t, { linkedEventLive: t.relatedCalendarEventId ? live.get(t.relatedCalendarEventId) ?? false : null }, now, cal, settings);
    if (timing.state === "not_due" || timing.state === "closed") continue;
    out.push({
      task: { id: t.id, kind: t.kind, title: t.title, matterId: t.matterId, dueAt: t.dueAt, ownerType: t.ownerType, ownerUserId: t.ownerUserId, deadlineCritical: t.deadlineCritical, visibility: t.visibility },
      state: timing.state,
      overdueHours: Math.round(timing.overdueHours * 10) / 10,
      clock: timing.clock,
    });
  }
  return out;
}

/** c46 client portal: the client's OWN tasks, past-due ones labelled with the approved neutral wording. */
export interface PortalTaskView {
  id: string;
  matterId: string | null;
  title: string;
  description: string | null;
  dueAt: Date;
  pastDue: boolean;
  /** legalCopy() — a visible placeholder until the attorney approves the wording. */
  pastDueLabel: string | null;
}

export async function listPortalTasks(tx: TenantTx, tenantId: string, partyId: string, now: Date, matterId?: string): Promise<PortalTaskView[]> {
  const rows = await listClientTasks(tx, tenantId, partyId, { matterId, now });
  return rows.map((t) => ({
    id: t.id,
    matterId: t.matterId,
    title: t.title,
    description: t.description,
    dueAt: t.dueAt,
    pastDue: t.overdue,
    pastDueLabel: t.overdue ? legalCopy(ALERT_COPY_GATES.portalPastDueLabel.key) : null,
  }));
}
