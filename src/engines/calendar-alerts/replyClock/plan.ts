// c43 / c44 — reply clocks. Pure planning, no I/O.
//
// Every inbound client message starts (or joins) one clock per matter thread:
//   standard (c43): flag lawyer + admin at firm_reply_hours (24 BH), the client
//                   is promised client_promise_hours (48 BH); at the promise the
//                   firm admin + managing attorney are told it was missed.
//   deadline (c44): flag the lawyer at deadline_question_flag_hours (12 BH),
//                   the client is promised deadline_question_reply_hours (24 BH);
//                   at the promise lawyer + firm admin are flagged.
// Both count BUSINESS hours (founder decision). The SAFETY NETS use the REAL
// clock: a confirmed court deadline inside the window (c43 rule 8) or — for a
// deadline question — any relevant deadline earlier than the reply due time
// (c44 §4.4) alerts the lawyer immediately, weekend or not.

import { addBusinessHours, type BusinessCalendar } from "@/core/businessHours";

export type ClockTier = "standard" | "deadline";

export interface ClockSettings {
  firmReplyHours: number;
  clientPromiseHours: number;
  deadlineQuestionFlagHours: number;
  deadlineQuestionReplyHours: number;
}

export interface RelevantDeadline {
  at: Date;
  /** 'calendar' = a CONFIRMED calendar entry; 'client_stated' = what the client said (not verified). */
  source: "calendar" | "client_stated";
  title: string;
  calendarEventId?: string | null;
}

export type ImmediateReason = "safety" | "deadline_in_window" | "deadline_before_reply" | "deadline_passed";

export interface ClockPlan {
  tier: ClockTier;
  flagHours: number;
  promiseHours: number;
  flagAt: Date;
  promiseAt: Date;
  earliestDeadline: RelevantDeadline | null;
  immediate: { reason: ImmediateReason; deadline: RelevantDeadline | null } | null;
}

export function clockHours(tier: ClockTier, s: ClockSettings): { flagHours: number; promiseHours: number } {
  return tier === "deadline"
    ? { flagHours: s.deadlineQuestionFlagHours, promiseHours: s.deadlineQuestionReplyHours }
    : { flagHours: s.firmReplyHours, promiseHours: s.clientPromiseHours };
}

export function earliest(deadlines: readonly RelevantDeadline[]): RelevantDeadline | null {
  let best: RelevantDeadline | null = null;
  for (const d of deadlines) if (!best || d.at.getTime() < best.at.getTime()) best = d;
  return best;
}

/**
 * Plan a clock that started at `startedAt` (the earliest unanswered message).
 * Re-tagging calls this again with the ORIGINAL start time (c44 §4.9).
 */
export function planReplyClock(input: {
  startedAt: Date;
  tier: ClockTier;
  settings: ClockSettings;
  calendar: BusinessCalendar;
  /** Calendar deadlines must already be filtered to CONFIRMED entries; client-stated dates are allowed for the deadline tier only. */
  deadlines: readonly RelevantDeadline[];
  safetyUrgent: boolean;
  now: Date;
}): ClockPlan {
  const { flagHours, promiseHours } = clockHours(input.tier, input.settings);
  if (flagHours > promiseHours) throw new Error("The internal flag must come before the client promise.");
  const flagAt = addBusinessHours(input.startedAt, flagHours, input.calendar);
  const promiseAt = addBusinessHours(input.startedAt, promiseHours, input.calendar);

  const considered =
    input.tier === "deadline" ? input.deadlines : input.deadlines.filter((d) => d.source === "calendar");
  const first = earliest(considered);

  let immediate: ClockPlan["immediate"] = null;
  if (first) {
    const t = first.at.getTime();
    if (input.tier === "deadline") {
      if (t <= input.now.getTime()) immediate = { reason: "deadline_passed", deadline: first };
      else if (t < promiseAt.getTime()) immediate = { reason: "deadline_before_reply", deadline: first };
    } else if (t <= promiseAt.getTime()) {
      immediate = { reason: "deadline_in_window", deadline: first };
    }
  }
  if (input.safetyUrgent) immediate = { reason: "safety", deadline: immediate?.deadline ?? first };
  return { tier: input.tier, flagHours, promiseHours, flagAt, promiseAt, earliestDeadline: first, immediate };
}

export type CheckpointStep = "flag" | "promise";

/** Pure: should a checkpoint fire now? Idempotent — a step that already fired never fires again. */
export function checkpointDue(
  clock: { status: string; flagAt: Date; promiseAt: Date; flaggedAt: Date | null; promiseMissedAt: Date | null },
  step: CheckpointStep,
  now: Date
): boolean {
  if (clock.status !== "open") return false;
  if (step === "flag") return clock.flaggedAt === null && now.getTime() >= clock.flagAt.getTime();
  return clock.promiseMissedAt === null && now.getTime() >= clock.promiseAt.getTime();
}

function uniq(ids: ReadonlyArray<string | null | undefined>): string[] {
  return [...new Set(ids.filter((x): x is string => typeof x === "string" && x.length > 0))];
}

/**
 * Who a reply-clock flag goes to. Pure. Firm-admin fallback whenever a named
 * person is missing — a flag must never go nowhere (c51).
 *  standard flag   → lawyer + admin (c43 §4.6)
 *  standard promise→ admin + managing attorney (c43 §4.7)
 *  deadline flag   → lawyer (c44 §4.7, L1)
 *  deadline promise→ lawyer + admin (c44 §4.7, L2)
 *  immediate       → lawyer + backup (admin when neither exists) (c44 §4 edge case)
 */
export function replyFlagRecipients(input: {
  tier: ClockTier;
  step: CheckpointStep | "immediate";
  lawyerId: string | null;
  backupId?: string | null;
  adminIds: readonly string[];
  managingIds: readonly string[];
}): string[] {
  const { tier, step, lawyerId, adminIds, managingIds } = input;
  let ids: string[];
  if (step === "immediate") ids = uniq([lawyerId, input.backupId]);
  else if (step === "flag") ids = tier === "deadline" ? uniq([lawyerId]) : uniq([lawyerId, ...adminIds]);
  else ids = tier === "deadline" ? uniq([lawyerId, ...adminIds]) : uniq([...adminIds, ...managingIds]);
  return ids.length > 0 ? ids : uniq([...adminIds]);
}

/** "Wednesday, October 7 at 5:00 PM CDT" in the firm's zone — the concrete promise (c43 rule 6). */
export function formatReplyBy(at: Date, timeZone: string): string {
  const date = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long", month: "long", day: "numeric" }).format(at);
  const time = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(at);
  return `${date} at ${time}`;
}

/** Plain-words reason for the immediate alert (internal). */
export function immediateReasonText(reason: ImmediateReason, deadline: RelevantDeadline | null, timeZone: string): string {
  const when = deadline ? `${deadline.title} on ${formatReplyBy(deadline.at, timeZone)}${deadline.source === "client_stated" ? " (client-stated, not verified)" : ""}` : "";
  switch (reason) {
    case "safety":
      return "The client's message may involve a safety concern. Please review it now.";
    case "deadline_passed":
      return `The client asked about a date that has already arrived or passed: ${when}.`;
    case "deadline_before_reply":
      return `A deadline falls before the reply would be due under business hours: ${when}.`;
    case "deadline_in_window":
      return `A confirmed court date or deadline falls inside the reply window: ${when}.`;
  }
}
