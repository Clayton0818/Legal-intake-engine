// c95 — matter stages and closing per practice area: pure rules.
//
// Each practice area has its own lifecycle (e.g. filed, discovery, mediation,
// trial, closed). A stage change can run task lists (c94), create a task for
// the lawyer to send a client update (c54 sends it — this engine never writes
// to the client) and record a billing event for the Billing engine (c79 — a
// record, never a charge). Reaching the closing stage goes through the closing
// flow: the Document engine's closing checklist (c90) and trust at zero (c82)
// must both be confirmed first.

import type { StageDef } from "@/db/tables/calendar-core";

export type { StageDef };

const STAGE_KEY = /^[a-z0-9][a-z0-9_-]{0,59}$/;
const BILLING_EVENT = /^[a-z][a-z0-9_.]{1,59}$/;

/** Validate a stage definition. Pure. */
export function validateStageDefinition(stages: readonly StageDef[]): string[] {
  const errors: string[] = [];
  if (!Array.isArray(stages) || stages.length < 2) return ["A lifecycle needs at least two stages (one of them the closing stage)."];
  if (stages.length > 40) errors.push("At most 40 stages.");
  const keys = new Set<string>();
  const orders = new Set<number>();
  stages.forEach((s, i) => {
    const at = `Stage ${i + 1}`;
    if (!STAGE_KEY.test(s.key ?? "")) errors.push(`${at}: key is not valid.`);
    if (keys.has(s.key)) errors.push(`${at}: duplicate key '${s.key}'.`);
    keys.add(s.key);
    if (!s.label?.trim() || s.label.length > 80) errors.push(`${at}: label must be 1–80 characters.`);
    if (!Number.isInteger(s.order)) errors.push(`${at}: order must be a whole number.`);
    if (orders.has(s.order)) errors.push(`${at}: duplicate order ${s.order}.`);
    orders.add(s.order);
    if (s.expectedBusinessHours !== null && (typeof s.expectedBusinessHours !== "number" || s.expectedBusinessHours <= 0)) {
      errors.push(`${at}: expected time must be a positive number of business hours or empty.`);
    }
    if (!s.onEnter || !Array.isArray(s.onEnter.taskLists)) errors.push(`${at}: onEnter.taskLists must be a list.`);
    else if (s.onEnter.taskLists.some((k: unknown) => typeof k !== "string" || !/^[a-z0-9][a-z0-9_.-]{1,79}$/.test(k))) errors.push(`${at}: a task-list key is not valid.`);
    if (s.onEnter?.billingEvent !== null && s.onEnter?.billingEvent !== undefined && !BILLING_EVENT.test(s.onEnter.billingEvent)) {
      errors.push(`${at}: billing event name is not valid.`);
    }
  });
  const closing = stages.filter((s) => s.closing);
  if (closing.length !== 1) errors.push("Exactly one stage must be the closing stage.");
  else {
    const maxOrder = Math.max(...stages.map((s) => s.order));
    if (closing[0]!.order !== maxOrder) errors.push("The closing stage must be the last stage.");
  }
  return errors;
}

export function sortedStages(stages: readonly StageDef[]): StageDef[] {
  return [...stages].sort((a, b) => a.order - b.order);
}

export function firstStage(stages: readonly StageDef[]): StageDef {
  const first = sortedStages(stages).find((s) => !s.closing);
  if (!first) throw new Error("The lifecycle has no open stage.");
  return first;
}

/**
 * Can a matter move from `fromKey` to `toKey`? Moving back is allowed (with a
 * reason); the closing stage is only reached through the closing flow. Pure.
 */
export function checkTransition(
  stages: readonly StageDef[],
  fromKey: string | null,
  toKey: string,
  lifecycleStatus: "open" | "closing" | "closed",
  reason: string | null
): { ok: true; to: StageDef; backwards: boolean } | { ok: false; reason: string } {
  if (lifecycleStatus === "closed") return { ok: false, reason: "The matter is closed." };
  const to = stages.find((s) => s.key === toKey);
  if (!to) return { ok: false, reason: `Unknown stage '${toKey}'.` };
  if (to.closing) return { ok: false, reason: "Use the closing flow to close a matter (closing checklist and trust at zero)." };
  if (fromKey === toKey) return { ok: false, reason: "The matter is already at that stage." };
  const from = fromKey ? stages.find((s) => s.key === fromKey) : undefined;
  const backwards = !!from && to.order < from.order;
  if (backwards && !reason?.trim()) return { ok: false, reason: "Moving a matter back a stage needs a reason; it is logged." };
  return { ok: true, to, backwards };
}

export interface ClosingState {
  checklistDone: boolean;
  trustZeroConfirmed: boolean;
  openDeadlineTasks: number;
  futureEvents: number;
  openLimitations: number;
}

/** Everything still stopping a matter from closing, in plain words. Empty = may close. Pure. */
export function closingBlockers(s: ClosingState): string[] {
  const out: string[] = [];
  if (!s.checklistDone) out.push("The closing checklist (Document engine) is not complete.");
  if (!s.trustZeroConfirmed) out.push("Trust at zero has not been confirmed.");
  if (s.openDeadlineTasks > 0) out.push(`${s.openDeadlineTasks} deadline task(s) are still open.`);
  if (s.futureEvents > 0) out.push(`${s.futureEvents} future calendar event(s) are not cancelled.`);
  if (s.openLimitations > 0) out.push(`${s.openLimitations} limitation date(s) are still open (mark satisfied or withdrawn).`);
  return out;
}
