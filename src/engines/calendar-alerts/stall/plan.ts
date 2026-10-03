// c47 — the stalled-workflow catch-all. Pure, no I/O.
//
// An item is stalled when it has sat in a stage with no activity for longer
// than that stage's expected duration (firm setting, BUSINESS hours). Rules:
//  - a stage with no configured duration is never flagged (rule 1);
//  - an item another rule already watches (an open task on it) is skipped (rule 3);
//  - one live episode per item; no daily repeats (rules 4, 6);
//  - it clears when the item moves stage or shows new activity, or when a
//    person records a reason + check-back date (rule 5); on that date, if
//    nothing changed, it is flagged again.

import { businessHoursBetween, type BusinessCalendar } from "@/core/businessHours";
import { stallDurationFor, type AlertSettings } from "../settings";

export const STALL_ITEM_TYPES = ["intake_session", "conflict_check", "matter", "document"] as const;
export type StallItemType = (typeof STALL_ITEM_TYPES)[number];

export interface StallCandidate {
  itemType: StallItemType;
  itemId: string;
  matterId: string | null;
  stage: string;
  lastActivityAt: Date;
  lastActivityLabel: string;
  ownerUserId: string | null;
  /** True when another rule (an open task on the item) is already watching it. */
  watchedElsewhere: boolean;
}

export interface LiveWatch {
  id: string;
  status: "flagged" | "check_back";
  stage: string;
  lastActivityAt: Date;
  checkBackAt: Date | null;
}

export type StallDecision =
  | { kind: "none" }
  | { kind: "flag"; stuckBusinessHours: number; expectedBusinessHours: number }
  | { kind: "reflag_after_check_back"; stuckBusinessHours: number; expectedBusinessHours: number }
  | { kind: "clear"; reason: string };

/**
 * Decide what to do with one item. `candidate` is null when the item is no
 * longer in a watchable state (finished, resolved, deleted).
 */
export function decideStall(
  candidate: StallCandidate | null,
  watch: LiveWatch | null,
  now: Date,
  settings: Pick<AlertSettings, "stallDurations">,
  calendar: BusinessCalendar
): StallDecision {
  if (watch) {
    if (!candidate) return { kind: "clear", reason: "The item is no longer waiting (finished or resolved)." };
    if (candidate.stage !== watch.stage) return { kind: "clear", reason: `The item moved from '${watch.stage}' to '${candidate.stage}'.` };
    if (candidate.lastActivityAt.getTime() > watch.lastActivityAt.getTime()) return { kind: "clear", reason: "New activity on the item." };
    if (watch.status === "check_back" && watch.checkBackAt && now.getTime() >= watch.checkBackAt.getTime()) {
      const expected = stallDurationFor(settings, candidate.itemType, candidate.stage) ?? 0;
      return { kind: "reflag_after_check_back", stuckBusinessHours: stuck(candidate, now, calendar), expectedBusinessHours: expected };
    }
    return { kind: "none" };
  }
  if (!candidate || candidate.watchedElsewhere) return { kind: "none" };
  const expected = stallDurationFor(settings, candidate.itemType, candidate.stage);
  if (expected === null) return { kind: "none" };
  const hours = stuck(candidate, now, calendar);
  return hours >= expected ? { kind: "flag", stuckBusinessHours: hours, expectedBusinessHours: expected } : { kind: "none" };
}

function stuck(c: StallCandidate, now: Date, calendar: BusinessCalendar): number {
  return Math.max(0, businessHoursBetween(c.lastActivityAt, now, calendar));
}

const LABELS: Record<StallItemType, string> = {
  intake_session: "Intake session",
  conflict_check: "Conflict check",
  matter: "Matter",
  document: "Document in review",
};

/** Factual flag text (c47 rule 7): stage, time stuck, last activity, owner. */
export function stallSummary(c: StallCandidate, stuckBusinessHours: number, expectedBusinessHours: number, now: Date, ownerName: string | null): string {
  const days = Math.floor((now.getTime() - c.lastActivityAt.getTime()) / 86_400_000);
  return [
    `${LABELS[c.itemType]} has been at stage '${c.stage}' for ${Math.round(stuckBusinessHours * 10) / 10} business hours (${days} calendar days); expected at most ${expectedBusinessHours}.`,
    `Last activity: ${c.lastActivityLabel} on ${c.lastActivityAt.toISOString()}.`,
    ownerName ? `Owner: ${ownerName}.` : "Owner: no owner.",
  ].join(" ");
}

/** A check-back date needs a reason and must be in the future, within the firm's horizon (c47 rule 5). */
export function validateCheckBack(reason: string | null | undefined, checkBackAt: Date, now: Date, maxDays: number): string | null {
  if (!reason?.trim()) return "A reason is required (for example 'waiting on the court until Oct 10').";
  if (Number.isNaN(checkBackAt.getTime())) return "The check-back date is not valid.";
  if (checkBackAt.getTime() <= now.getTime()) return "The check-back date must be in the future.";
  if (checkBackAt.getTime() - now.getTime() > maxDays * 86_400_000) return `The check-back date can be at most ${maxDays} days ahead.`;
  return null;
}

export function stallFlagKey(itemType: string, itemId: string): string {
  return `calendar-alerts.stalled:${itemType}:${itemId}`;
}
