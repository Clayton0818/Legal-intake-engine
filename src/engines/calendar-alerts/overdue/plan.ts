// c45 / c46 — what the overdue scan does with one open task. Pure, no I/O.
//
// One mechanism for every due item in the product (c45): firm replies,
// confirmations, sign-offs, client to-dos, other engines' tasks … The scan
// reads the shared `tasks` table and decides, per task:
//
//   due_soon   owner gets an in-app + email notice (no flag yet);
//   flag_l1    overdue → flag the owner (pool / disabled owner → firm admin);
//   escalate   past the grace period → add supervisor + firm admin (L2);
//   flag_l3    deadline-critical → owner + supervisor + admin at once,
//              critical, urgent, REAL clock, no grace;
//   client     a CLIENT-owned task lapsed → the c42/c46 chase ladder;
//   client_due_soon  optional neutral reminder to the client (c46 §4.3).
//
// A deadline-critical task whose linked calendar entry was cancelled or is no
// longer confirmed drops to standard severity (c45 rule 15) and the owner is
// told once.
//
// Visibility: every flag here is INTERNAL. Client tasks show as overdue only
// in the client's own portal list (core listClientTasks), never as a flag.

import { computeTaskTiming, type TaskRow, type TaskTiming } from "@/core/tasks";
import type { BusinessCalendar } from "@/core/businessHours";

export type OverdueAction =
  | { kind: "none" }
  | { kind: "due_soon" }
  | { kind: "client_due_soon" }
  | { kind: "client_lapsed" }
  | { kind: "flag_l1" }
  | { kind: "escalate" }
  | { kind: "flag_l3" };

export interface OverdueState {
  /** The open 'task.overdue' flag for this task, if any. */
  openFlag: { escalationLevel: number; severity: string } | null;
  dueSoonSent: boolean;
  ladderExists: boolean;
  /** For tasks with a linked calendar entry: is it still a confirmed, live entry? null = no link. */
  linkedEventLive: boolean | null;
}

export interface OverdueSettings {
  dueSoonBusinessHours: number;
  overdueGraceBusinessHours: number;
  deadlineDueSoonRealHours: number;
  clientTaskDueSoonReminder: boolean;
}

/** Deadline-critical only while its linked entry (if any) is still confirmed and live. */
export function effectiveDeadlineCritical(task: Pick<TaskRow, "deadlineCritical" | "relatedCalendarEventId">, linkedEventLive: boolean | null): boolean {
  if (!task.deadlineCritical) return false;
  if (task.relatedCalendarEventId && linkedEventLive === false) return false;
  return true;
}

export function taskTiming(
  task: Pick<TaskRow, "dueAt" | "status" | "usesBusinessHours" | "deadlineCritical" | "relatedCalendarEventId">,
  state: Pick<OverdueState, "linkedEventLive">,
  now: Date,
  calendar: BusinessCalendar,
  s: OverdueSettings
): TaskTiming {
  const critical = effectiveDeadlineCritical(task, state.linkedEventLive);
  return computeTaskTiming({ ...task, deadlineCritical: critical }, now, calendar, {
    dueSoonBusinessHours: critical ? s.deadlineDueSoonRealHours : s.dueSoonBusinessHours,
    overdueGraceBusinessHours: s.overdueGraceBusinessHours,
  });
}

export function planOverdue(
  task: Pick<TaskRow, "dueAt" | "status" | "usesBusinessHours" | "deadlineCritical" | "relatedCalendarEventId" | "ownerType">,
  state: OverdueState,
  now: Date,
  calendar: BusinessCalendar,
  s: OverdueSettings
): { action: OverdueAction; timing: TaskTiming; critical: boolean } {
  const timing = taskTiming(task, state, now, calendar, s);
  const critical = effectiveDeadlineCritical(task, state.linkedEventLive);
  const none = { action: { kind: "none" } as OverdueAction, timing, critical };
  if (timing.state === "closed" || timing.state === "not_due") return none;

  if (task.ownerType === "client") {
    if (timing.state === "due_soon") {
      return s.clientTaskDueSoonReminder && !state.dueSoonSent ? { action: { kind: "client_due_soon" }, timing, critical } : none;
    }
    return state.ladderExists ? none : { action: { kind: "client_lapsed" }, timing, critical };
  }

  if (timing.state === "due_soon") return state.dueSoonSent ? none : { action: { kind: "due_soon" }, timing, critical };
  if (critical) {
    // Highest level at once. An existing lower flag (e.g. raised before the link was confirmed) is escalated.
    if (!state.openFlag) return { action: { kind: "flag_l3" }, timing, critical };
    return state.openFlag.severity === "critical" ? none : { action: { kind: "escalate" }, timing, critical };
  }
  if (!state.openFlag) return { action: { kind: "flag_l1" }, timing, critical };
  if (timing.state === "overdue_escalate" && state.openFlag.escalationLevel === 0) return { action: { kind: "escalate" }, timing, critical };
  return none;
}

/**
 * Who each level goes to (c45 §4 rules 4–7, 13, 14). Pure. Never empty while
 * the firm has an admin — a flag must never go nowhere (c51).
 *  - pooled or disabled owner → L1 to the firm admin, L2 to the managing attorney;
 *  - L2 adds the supervising lawyer (task supervisor, else the matter's lawyer) + admin;
 *  - L3 is everyone at once.
 */
export function overdueRecipients(input: {
  level: 1 | 2 | 3;
  ownerType: string;
  ownerUserId: string | null;
  ownerActive: boolean;
  supervisorId: string | null;
  adminIds: readonly string[];
  managingIds: readonly string[];
}): { userIds: string[]; pooled: boolean; noSupervisor: boolean } {
  const pooled = input.ownerType === "firm" || !input.ownerUserId || !input.ownerActive;
  const owner = pooled ? null : input.ownerUserId;
  const supervisor = input.supervisorId && input.supervisorId !== owner ? input.supervisorId : null;
  const uniq = (ids: ReadonlyArray<string | null>) => [...new Set(ids.filter((x): x is string => Boolean(x)))];
  let ids: string[];
  if (input.level === 1) ids = pooled ? uniq([...input.adminIds]) : uniq([owner]);
  else if (input.level === 2) ids = pooled ? uniq([...input.managingIds, ...input.adminIds]) : uniq([supervisor, ...input.adminIds]);
  else ids = uniq([owner, supervisor, ...input.adminIds]);
  if (ids.length === 0) ids = uniq([...input.adminIds]);
  return { userIds: ids, pooled, noSupervisor: !supervisor };
}

/**
 * c45 rule 10: a deadline-linked task may not be moved past its linked court
 * deadline (the deadline itself moves only in the calendar, by a lawyer).
 * Returns a refusal message, or null when the change is allowed. Pure.
 */
export function checkRedate(
  task: Pick<TaskRow, "deadlineCritical" | "relatedCalendarEventId" | "status">,
  newDueAt: Date,
  linked: { startsAt: Date; status: string; cancelledAt: Date | null } | null
): string | null {
  if (task.status !== "open") return "Only an open task can be re-dated.";
  if (Number.isNaN(newDueAt.getTime())) return "The new due time is not a valid date.";
  if (task.deadlineCritical && linked && linked.status === "confirmed" && !linked.cancelledAt && newDueAt.getTime() > linked.startsAt.getTime()) {
    return "This task is tied to a confirmed court deadline and cannot be due after it. Move the deadline in the calendar (a lawyer's decision) instead.";
  }
  return null;
}

/** Plain, factual flag text (internal; discoverable records — no judgments). */
export function overdueSummary(input: { title: string; timing: TaskTiming; critical: boolean; pooled: boolean; noSupervisor: boolean }): string {
  const hours = Math.round(input.timing.overdueHours * 10) / 10;
  const clock = input.timing.clock === "business" ? "business hours" : "hours";
  const parts = [`"${input.title}" is ${hours} ${clock} past its due time.`];
  if (input.critical) parts.push("It is tied to a court date, filing deadline or limitation date.");
  if (input.pooled) parts.push("It has no active individual owner.");
  if (input.noSupervisor) parts.push("No supervising or responsible lawyer is set.");
  return parts.join(" ");
}
