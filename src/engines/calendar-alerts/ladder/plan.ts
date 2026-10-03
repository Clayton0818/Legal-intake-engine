// c42 / c46 — the client chase ladder. Pure, no I/O.
//
// When a client-owned item lapses (an unanswered request, c42; an unfinished
// client task, c46) the firm's ladder runs: neutral reminders, then a task for
// the lawyer to decide the next step. Nothing after that is automatic, and
// the system never takes a legal step (withdrawal, non-engagement letter).
// Gaps between steps count BUSINESS hours; the deadline safety net is REAL.

import { addBusinessHours, type BusinessCalendar } from "@/core/businessHours";
import type { LadderStep } from "../settings";

export type LadderDecision = "personal_message" | "phone_call_logged" | "extend_window" | "no_reply_needed" | "close_with_note";
export const LADDER_DECISIONS: readonly LadderDecision[] = [
  "personal_message",
  "phone_call_logged",
  "extend_window",
  "no_reply_needed",
  "close_with_note",
];

export interface LadderStepPlan {
  step: LadderStep;
  index: number;
  /** Ordinal of this reminder (1-based), or null for the lawyer step. */
  reminderNumber: number | null;
  /** When the step after this one is due (null when this is the last step). */
  nextAt: Date | null;
  /** 1 for the first reminder (lapse), 2 afterwards (c42 §7). */
  flagLevel: 1 | 2;
}

/** When the first step runs: the lapse (task due time) plus its gap. */
export function firstStepAt(lapsedAt: Date, steps: readonly LadderStep[], cal: BusinessCalendar): Date {
  const first = steps[0];
  if (!first) throw new Error("Empty ladder.");
  return addBusinessHours(lapsedAt, first.afterBusinessHours, cal);
}

/** What step `index` does when it runs at `now`. Pure. */
export function planStep(steps: readonly LadderStep[], index: number, remindersSent: number, now: Date, cal: BusinessCalendar): LadderStepPlan | null {
  const step = steps[index];
  if (!step) return null;
  const next = steps[index + 1];
  return {
    step,
    index,
    reminderNumber: step.action === "reminder" ? remindersSent + 1 : null,
    nextAt: next ? addBusinessHours(now, next.afterBusinessHours, cal) : null,
    flagLevel: index === 0 ? 1 : 2,
  };
}

/**
 * Real-clock safety net (c42 §8, c46 §4.6): a linked confirmed deadline that
 * arrives before the next step (or has already arrived) alerts the lawyer now.
 */
export function deadlineBeatsLadder(deadlineAt: Date | null, nextAt: Date | null, now: Date): boolean {
  if (!deadlineAt) return false;
  if (deadlineAt.getTime() <= now.getTime()) return true;
  // Last step: the lawyer already has a decision task; only an arrived deadline alerts.
  return nextAt !== null && deadlineAt.getTime() < nextAt.getTime();
}

export function isLadderDecision(v: unknown): v is LadderDecision {
  return typeof v === "string" && (LADDER_DECISIONS as readonly string[]).includes(v);
}
