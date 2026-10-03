// c94 — standard task lists per practice area and stage: pure rules.
//
// A template is a firm-built checklist. When a matter reaches a stage (c95)
// every ACTIVE template triggered by that stage runs: items with no
// prerequisites become tasks at once; the rest wait until the items they
// depend on are completed (the worker releases them). Tasks have owners, due
// times on the business clock by default (deadline-critical items run on the
// real clock) and land in the shared `tasks` table, so the overdue flags
// (c45, c46) track them like any other task.

import { isPracticeAreaId } from "@/core";
import type { TaskTemplateItem, TemplateOwner } from "@/db/tables/calendar-core";

export type { TaskTemplateItem, TemplateOwner };

export interface TaskListTemplateInput {
  key: string;
  name: string;
  practiceArea: string;
  triggerStageKey: string | null;
  items: TaskTemplateItem[];
}

const KEY = /^[a-z0-9][a-z0-9_.-]{1,79}$/;
const ITEM_KEY = /^[a-z0-9][a-z0-9_-]{0,59}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function ownerValid(o: unknown): o is TemplateOwner {
  if (o === "responsible_lawyer" || o === "firm" || o === "client") return true;
  return !!o && typeof o === "object" && typeof (o as { userId?: unknown }).userId === "string" && UUID.test((o as { userId: string }).userId);
}

/** Item keys in dependency order; null when there is a cycle. Pure. */
export function topologicalOrder(items: readonly Pick<TaskTemplateItem, "key" | "dependsOn">[]): string[] | null {
  const deps = new Map(items.map((i) => [i.key, new Set(i.dependsOn)]));
  const order: string[] = [];
  const done = new Set<string>();
  while (order.length < items.length) {
    const next = items.find((i) => !done.has(i.key) && [...(deps.get(i.key) ?? [])].every((d) => done.has(d)));
    if (!next) return null;
    done.add(next.key);
    order.push(next.key);
  }
  return order;
}

/** Validate a template. Errors block saving. Pure. */
export function validateTaskListTemplate(t: TaskListTemplateInput): string[] {
  const errors: string[] = [];
  if (!KEY.test(t.key)) errors.push(`Template key '${t.key}' must be 2–80 lowercase letters, digits, '.', '_' or '-'.`);
  if (!t.name?.trim()) errors.push("The template needs a name.");
  if (!isPracticeAreaId(t.practiceArea)) errors.push(`Unknown practice area '${t.practiceArea}'.`);
  if (t.triggerStageKey !== null && !ITEM_KEY.test(t.triggerStageKey)) errors.push("The trigger stage key is not valid.");
  if (!Array.isArray(t.items) || t.items.length === 0) {
    errors.push("A task list needs at least one item.");
    return errors;
  }
  if (t.items.length > 100) errors.push("A task list can hold at most 100 items.");
  const keys = new Set<string>();
  t.items.forEach((item, i) => {
    const at = `Item ${i + 1}`;
    if (!ITEM_KEY.test(item.key ?? "")) errors.push(`${at}: key is not valid.`);
    if (keys.has(item.key)) errors.push(`${at}: duplicate key '${item.key}'.`);
    keys.add(item.key);
    if (!item.title?.trim() || item.title.length > 200) errors.push(`${at}: title must be 1–200 characters.`);
    if (!ownerValid(item.owner)) errors.push(`${at}: owner must be responsible_lawyer, firm, client or { userId }.`);
    if (typeof item.dueHours !== "number" || !Number.isFinite(item.dueHours) || item.dueHours < 0 || item.dueHours > 10_000) {
      errors.push(`${at}: dueHours must be between 0 and 10000.`);
    }
    if (item.clock !== "business" && item.clock !== "real") errors.push(`${at}: clock must be 'business' or 'real'.`);
    if (item.deadlineCritical && item.clock !== "real") errors.push(`${at}: deadline-critical items run on the real clock.`);
    if (item.deadlineCritical && item.owner === "client") errors.push(`${at}: a client task cannot be deadline-critical; give the lawyer the deadline task.`);
    if (!Array.isArray(item.dependsOn)) errors.push(`${at}: dependsOn must be a list.`);
  });
  for (const item of t.items) {
    for (const d of item.dependsOn ?? []) {
      if (!keys.has(d)) errors.push(`Item '${item.key}' depends on unknown item '${d}'.`);
      if (d === item.key) errors.push(`Item '${item.key}' cannot depend on itself.`);
    }
  }
  if (errors.length === 0 && topologicalOrder(t.items) === null) errors.push("The dependencies form a loop.");
  return errors;
}

export type ResolvedOwner =
  | { owner: { type: "user"; userId: string }; visibility: "internal" }
  | { owner: { type: "firm" }; visibility: "internal" }
  | { owner: { type: "client"; partyId: string }; visibility: "client" };

/** Who a templated task goes to on this matter. Unresolvable owners fall back to the firm pool. Pure. */
export function resolveOwner(owner: TemplateOwner, matter: { responsibleUserId: string | null; clientPartyId: string | null }): ResolvedOwner {
  if (owner === "responsible_lawyer") {
    return matter.responsibleUserId ? { owner: { type: "user", userId: matter.responsibleUserId }, visibility: "internal" } : { owner: { type: "firm" }, visibility: "internal" };
  }
  if (owner === "client") {
    return matter.clientPartyId ? { owner: { type: "client", partyId: matter.clientPartyId }, visibility: "client" } : { owner: { type: "firm" }, visibility: "internal" };
  }
  if (owner === "firm") return { owner: { type: "firm" }, visibility: "internal" };
  return { owner: { type: "user", userId: owner.userId }, visibility: "internal" };
}

export interface RunItemState {
  itemKey: string;
  dependsOn: string[];
  status: "waiting" | "released" | "skipped";
  /** For released items: is the task finished (done or cancelled)? */
  taskClosed?: boolean;
}

/**
 * Waiting items whose prerequisites are all finished (released and closed, or
 * skipped). Pure.
 */
export function readyToRelease(items: readonly RunItemState[]): string[] {
  const finished = new Set(items.filter((i) => i.status === "skipped" || (i.status === "released" && i.taskClosed)).map((i) => i.itemKey));
  return items.filter((i) => i.status === "waiting" && i.dependsOn.every((d) => finished.has(d))).map((i) => i.itemKey);
}

/** A run is complete when nothing waits and every released task is closed. Pure. */
export function runComplete(items: readonly RunItemState[]): boolean {
  return items.every((i) => i.status === "skipped" || (i.status === "released" && i.taskClosed));
}

/** Namespaced task kind for a templated task (shared tasks.kind format). */
export function taskKindFor(templateKey: string, itemKey: string): string {
  const safe = (s: string) => s.replace(/[^a-z0-9_-]/g, "_");
  return `calendar-core.tl.${safe(templateKey)}.${safe(itemKey)}`;
}
