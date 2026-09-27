// Tasks: ONE mechanism for everything that is due (c45): firm replies (c43,
// c44), confirmations (c40), client sign-offs (c41), client to-dos (c46),
// document requests (c49), installments (c52), update cadence (c54), speed to
// lead (c69) … Each engine creates tasks here instead of running its own
// timers; overdue detection is shared (computeTaskTiming).
//
// Clocks: normal tasks count the firm's BUSINESS hours (founder decision).
// deadlineCritical tasks (court date, filing deadline, limitation date) use
// the REAL clock, have no grace period and flag at the highest severity.

import { and, asc, eq, inArray, lte } from "drizzle-orm";
import { tasks } from "@/db/tables/foundation";
import type { TenantTx } from "@/tenancy/withTenant";
import {
  addClockHours,
  hoursBetweenOnClock,
  type BusinessCalendar,
  type Clock,
} from "./businessHours";
import { getFirmSettings, toBusinessCalendar } from "./firmSettings";
import { audit, SYSTEM_ACTOR, type Actor } from "./audit";
import { resolveFlagsForTask, type FlagSeverity } from "./flags";
import { clientVisible, type TaskVisibility } from "./visibility";

export { clientVisible, type TaskVisibility } from "./visibility";

export type TaskRow = typeof tasks.$inferSelect;
export type TaskStatus = "open" | "done" | "cancelled";

export type TaskOwner = { type: "user"; userId: string } | { type: "client"; partyId: string } | { type: "firm" };

export type TaskDue =
  /** An exact instant (e.g. a confirmed filing deadline). */
  | { at: Date; clock?: Clock }
  /** Relative: `hours` on the given clock from `from` (default now). */
  | { hours: number; clock: Clock; from?: Date };

export interface NewTaskInput {
  tenantId: string;
  /** Namespaced kind, e.g. 'calendar.firm_reply_due'. */
  kind: string;
  title: string;
  description?: string | null;
  owner: TaskOwner;
  due: TaskDue;
  matterId?: string | null;
  intakeSessionId?: string | null;
  supervisorUserId?: string | null;
  /** Court date / filing deadline / limitation date: real clock, no grace, critical. */
  deadlineCritical?: boolean;
  /** 'client' only for tasks owned by the client (c46); default 'internal'. */
  visibility?: TaskVisibility;
  sourceCard?: string | null;
  sourceRef?: string | null;
  relatedCalendarEventId?: string | null;
  metadata?: Record<string, unknown>;
  createdBy?: Actor;
  engine?: string;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function validateNewTask(input: NewTaskInput): string[] {
  const errors: string[] = [];
  if (!/^[a-z0-9_-]+(\.[a-z0-9_-]+)+$/.test(input.kind)) {
    errors.push(`kind '${input.kind}' must be namespaced, e.g. 'calendar.firm_reply_due'.`);
  }
  if (!input.title.trim()) errors.push("title is required.");
  const visibility = input.visibility ?? "internal";
  if (visibility === "client" && input.owner.type !== "client") {
    errors.push("only a client's own tasks can be client-visible (c45/c46 boundary).");
  }
  if ("hours" in input.due && (!Number.isFinite(input.due.hours) || input.due.hours < 0)) {
    errors.push("due.hours must be zero or more.");
  }
  if (input.deadlineCritical && "clock" in input.due && input.due.clock === "business") {
    errors.push("deadline-critical tasks run on the real clock, not business hours.");
  }
  return errors;
}

/** Resolve a TaskDue into an instant plus the clock the task is measured on. */
export function resolveDue(
  due: TaskDue,
  calendar: BusinessCalendar,
  now: Date,
  deadlineCritical = false
): { dueAt: Date; usesBusinessHours: boolean } {
  if ("at" in due) {
    const clock = deadlineCritical ? "real" : due.clock ?? "business";
    return { dueAt: new Date(due.at.getTime()), usesBusinessHours: clock === "business" };
  }
  const clock: Clock = deadlineCritical ? "real" : due.clock;
  return { dueAt: addClockHours(due.from ?? now, due.hours, clock, calendar), usesBusinessHours: clock === "business" };
}

export type TaskTimingState = "closed" | "not_due" | "due_soon" | "overdue" | "overdue_escalate";

export interface TaskTiming {
  state: TaskTimingState;
  /** Suggested flag severity for this state (null when nothing to flag). */
  severity: FlagSeverity | null;
  /** Hours past due on the task's clock (0 when not overdue). */
  overdueHours: number;
  /** Hours until due on the task's clock (negative when overdue). */
  hoursUntilDue: number;
  clock: Clock;
}

/**
 * Where a task stands at `now` (c45):
 *  - not_due / due_soon (within dueSoonBusinessHours of the due time);
 *  - overdue (flag the assignee) → overdue_escalate once past the grace period
 *    (flag supervisor + firm admin);
 *  - deadlineCritical tasks skip the grace period and are critical immediately,
 *    measured on the real clock.
 */
export function computeTaskTiming(
  task: Pick<TaskRow, "dueAt" | "status" | "usesBusinessHours" | "deadlineCritical">,
  now: Date,
  calendar: BusinessCalendar,
  settings: { dueSoonBusinessHours: number; overdueGraceBusinessHours: number }
): TaskTiming {
  const clock: Clock = task.deadlineCritical || !task.usesBusinessHours ? "real" : "business";
  const hoursUntilDue = hoursBetweenOnClock(now, task.dueAt, clock, calendar);
  if (task.status !== "open") return { state: "closed", severity: null, overdueHours: 0, hoursUntilDue, clock };

  if (now.getTime() >= task.dueAt.getTime()) {
    const overdueHours = Math.max(0, -hoursUntilDue);
    if (task.deadlineCritical) return { state: "overdue_escalate", severity: "critical", overdueHours, hoursUntilDue, clock };
    const escalate = overdueHours >= settings.overdueGraceBusinessHours;
    return {
      state: escalate ? "overdue_escalate" : "overdue",
      severity: escalate ? "high" : "warning",
      overdueHours,
      hoursUntilDue,
      clock,
    };
  }
  if (hoursUntilDue <= settings.dueSoonBusinessHours) {
    return { state: "due_soon", severity: task.deadlineCritical ? "high" : "info", overdueHours: 0, hoursUntilDue, clock };
  }
  return { state: "not_due", severity: null, overdueHours: 0, hoursUntilDue, clock };
}

function requireReason(reason: string | null | undefined, what: string): string {
  const r = reason?.trim();
  if (!r) throw new Error(`${what}: a reason is required and is logged (c45: no silent clearing).`);
  return r;
}

function ownerColumns(owner: TaskOwner) {
  return {
    ownerType: owner.type,
    ownerUserId: owner.type === "user" ? owner.userId : null,
    ownerPartyId: owner.type === "client" ? owner.partyId : null,
  };
}

// ---------------------------------------------------------------------------
// Database operations
// ---------------------------------------------------------------------------

export async function createTask(
  tx: TenantTx,
  input: NewTaskInput,
  opts: { now?: Date; calendar?: BusinessCalendar } = {}
): Promise<TaskRow> {
  const errors = validateNewTask(input);
  if (errors.length > 0) throw new Error(`createTask: ${errors.join(" ")}`);
  const now = opts.now ?? new Date();
  const calendar = opts.calendar ?? toBusinessCalendar(await getFirmSettings(tx, input.tenantId));
  const { dueAt, usesBusinessHours } = resolveDue(input.due, calendar, now, input.deadlineCritical);
  const createdBy = input.createdBy ?? SYSTEM_ACTOR;

  const [row] = await tx
    .insert(tasks)
    .values({
      tenantId: input.tenantId,
      matterId: input.matterId ?? null,
      intakeSessionId: input.intakeSessionId ?? null,
      kind: input.kind,
      title: input.title,
      description: input.description ?? null,
      ...ownerColumns(input.owner),
      supervisorUserId: input.supervisorUserId ?? null,
      dueAt,
      usesBusinessHours,
      deadlineCritical: input.deadlineCritical ?? false,
      visibility: input.visibility ?? "internal",
      sourceCard: input.sourceCard ?? null,
      sourceRef: input.sourceRef ?? null,
      relatedCalendarEventId: input.relatedCalendarEventId ?? null,
      metadata: input.metadata ?? {},
      createdByUserId: createdBy.type === "user" ? createdBy.userId : null,
    })
    .returning();
  if (!row) throw new Error("createTask: insert failed.");
  await audit(tx, {
    tenantId: input.tenantId,
    engine: input.engine ?? "core",
    action: "task.created",
    entityType: "task",
    entityId: row.id,
    matterId: row.matterId,
    intakeSessionId: row.intakeSessionId,
    actor: createdBy,
    payload: { kind: row.kind, dueAt: row.dueAt.toISOString(), ownerType: row.ownerType, deadlineCritical: row.deadlineCritical },
  });
  return row;
}

export async function getTask(tx: TenantTx, tenantId: string, taskId: string): Promise<TaskRow | undefined> {
  const [row] = await tx.select().from(tasks).where(and(eq(tasks.tenantId, tenantId), eq(tasks.id, taskId))).limit(1);
  return row;
}

async function updateOpenTask(
  tx: TenantTx,
  tenantId: string,
  taskId: string,
  set: Partial<typeof tasks.$inferInsert>
): Promise<TaskRow> {
  const [row] = await tx
    .update(tasks)
    .set({ ...set, updatedAt: new Date() })
    .where(and(eq(tasks.tenantId, tenantId), eq(tasks.id, taskId), eq(tasks.status, "open")))
    .returning();
  if (!row) throw new Error(`Open task ${taskId} not found.`);
  return row;
}

/** Complete a task; its open flags are resolved with the same reason. */
export async function completeTask(
  tx: TenantTx,
  input: { tenantId: string; taskId: string; by: Actor; reason?: string; engine?: string; at?: Date }
): Promise<TaskRow> {
  const reason = input.reason?.trim() || "Task completed";
  const row = await updateOpenTask(tx, input.tenantId, input.taskId, {
    status: "done",
    completedAt: input.at ?? new Date(),
    completedByUserId: input.by.type === "user" ? input.by.userId : null,
    completedByPartyId: input.by.type === "client" ? input.by.partyId : null,
    lastChangeReason: reason,
  });
  await resolveFlagsForTask(tx, { tenantId: input.tenantId, taskId: row.id, by: input.by, reason, engine: input.engine });
  await audit(tx, {
    tenantId: input.tenantId,
    engine: input.engine ?? "core",
    action: "task.completed",
    entityType: "task",
    entityId: row.id,
    matterId: row.matterId,
    actor: input.by,
    reason,
  });
  return row;
}

/** Cancel a task (reason required); its open flags are resolved. */
export async function cancelTask(
  tx: TenantTx,
  input: { tenantId: string; taskId: string; by: Actor; reason: string; engine?: string }
): Promise<TaskRow> {
  const reason = requireReason(input.reason, "cancelTask");
  const row = await updateOpenTask(tx, input.tenantId, input.taskId, { status: "cancelled", lastChangeReason: reason });
  await resolveFlagsForTask(tx, { tenantId: input.tenantId, taskId: row.id, by: input.by, reason: `Task cancelled: ${reason}`, engine: input.engine });
  await audit(tx, {
    tenantId: input.tenantId,
    engine: input.engine ?? "core",
    action: "task.cancelled",
    entityType: "task",
    entityId: row.id,
    matterId: row.matterId,
    actor: input.by,
    reason,
  });
  return row;
}

/** Reassign a task (reason required). Open overdue flags clear; the timing check re-flags if still overdue. */
export async function reassignTask(
  tx: TenantTx,
  input: { tenantId: string; taskId: string; owner: TaskOwner; by: Actor; reason: string; engine?: string }
): Promise<TaskRow> {
  const reason = requireReason(input.reason, "reassignTask");
  const current = await getTask(tx, input.tenantId, input.taskId);
  if (!current) throw new Error(`reassignTask: task ${input.taskId} not found.`);
  if (current.visibility === "client" && input.owner.type !== "client") {
    throw new Error("reassignTask: a client-visible task can only be reassigned to a client.");
  }
  const row = await updateOpenTask(tx, input.tenantId, input.taskId, { ...ownerColumns(input.owner), lastChangeReason: reason });
  await resolveFlagsForTask(tx, { tenantId: input.tenantId, taskId: row.id, by: input.by, reason: `Task reassigned: ${reason}`, engine: input.engine });
  await audit(tx, {
    tenantId: input.tenantId,
    engine: input.engine ?? "core",
    action: "task.reassigned",
    entityType: "task",
    entityId: row.id,
    matterId: row.matterId,
    actor: input.by,
    reason,
    payload: { from: { type: current.ownerType, userId: current.ownerUserId, partyId: current.ownerPartyId }, to: input.owner },
  });
  return row;
}

/** Change a task's due time (reason required). Open flags clear; the timing check re-flags if still overdue. */
export async function changeTaskDue(
  tx: TenantTx,
  input: { tenantId: string; taskId: string; dueAt: Date; by: Actor; reason: string; engine?: string }
): Promise<TaskRow> {
  const reason = requireReason(input.reason, "changeTaskDue");
  const current = await getTask(tx, input.tenantId, input.taskId);
  if (!current) throw new Error(`changeTaskDue: task ${input.taskId} not found.`);
  const row = await updateOpenTask(tx, input.tenantId, input.taskId, { dueAt: input.dueAt, lastChangeReason: reason });
  await resolveFlagsForTask(tx, { tenantId: input.tenantId, taskId: row.id, by: input.by, reason: `Due date changed: ${reason}`, engine: input.engine });
  await audit(tx, {
    tenantId: input.tenantId,
    engine: input.engine ?? "core",
    action: "task.due_changed",
    entityType: "task",
    entityId: row.id,
    matterId: row.matterId,
    actor: input.by,
    reason,
    payload: { from: current.dueAt.toISOString(), to: input.dueAt.toISOString() },
  });
  return row;
}

/** Open tasks, soonest first — the input to overdue scans (the calendar-alerts engine owns the scan, c45/c46). */
export async function listOpenTasks(
  tx: TenantTx,
  tenantId: string,
  filter: { dueBefore?: Date; matterId?: string; ownerUserId?: string; kinds?: string[]; limit?: number } = {}
): Promise<TaskRow[]> {
  const conds = [eq(tasks.tenantId, tenantId), eq(tasks.status, "open")];
  if (filter.dueBefore) conds.push(lte(tasks.dueAt, filter.dueBefore));
  if (filter.matterId) conds.push(eq(tasks.matterId, filter.matterId));
  if (filter.ownerUserId) conds.push(eq(tasks.ownerUserId, filter.ownerUserId));
  if (filter.kinds && filter.kinds.length > 0) conds.push(inArray(tasks.kind, filter.kinds));
  return tx
    .select()
    .from(tasks)
    .where(and(...conds))
    .orderBy(asc(tasks.dueAt))
    .limit(filter.limit ?? 500);
}

/** What a client may see of a task. */
export interface ClientTaskView {
  id: string;
  matterId: string | null;
  kind: string;
  title: string;
  description: string | null;
  dueAt: Date;
  status: string;
  /** True when past due — shown to the client for THEIR OWN tasks only (c46). */
  overdue: boolean;
}

/** A client's own client-visible tasks (never internal tasks, never anyone else's). */
export async function listClientTasks(
  tx: TenantTx,
  tenantId: string,
  partyId: string,
  filter: { matterId?: string; includeClosed?: boolean; now?: Date } = {}
): Promise<ClientTaskView[]> {
  const now = filter.now ?? new Date();
  const conds = [
    eq(tasks.tenantId, tenantId),
    eq(tasks.visibility, "client"),
    eq(tasks.ownerType, "client"),
    eq(tasks.ownerPartyId, partyId),
  ];
  if (!filter.includeClosed) conds.push(eq(tasks.status, "open"));
  if (filter.matterId) conds.push(eq(tasks.matterId, filter.matterId));
  const rows = await tx.select().from(tasks).where(and(...conds)).orderBy(asc(tasks.dueAt));
  return clientVisible(rows)
    .filter((t) => t.ownerPartyId === partyId)
    .map((t) => ({
      id: t.id,
      matterId: t.matterId,
      kind: t.kind,
      title: t.title,
      description: t.description,
      dueAt: t.dueAt,
      status: t.status,
      overdue: t.status === "open" && t.dueAt.getTime() <= now.getTime(),
    }));
}
