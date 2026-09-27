// c69 — speed-to-lead clock (pure). Firm BUSINESS hours (founder decision).
//
// In hours: target = arrival + N business minutes (firm setting, default 15).
// After hours: target = next business opening + M business minutes
// ("first thing next business morning", default 60).
// Only a real human contact stops the clock; AI messages never do.

import { addBusinessMinutes, businessHoursBetween, isBusinessTime, nextBusinessStart, type BusinessCalendar } from "@/core/businessHours";

export function computeResponseTarget(
  arrivedAt: Date,
  cal: BusinessCalendar,
  targets: { inHoursMinutes: number; afterHoursMinutesAfterOpen: number }
): Date {
  if (isBusinessTime(arrivedAt, cal)) return addBusinessMinutes(arrivedAt, targets.inHoursMinutes, cal);
  return addBusinessMinutes(nextBusinessStart(arrivedAt, cal), targets.afterHoursMinutesAfterOpen, cal);
}

/** When the "due soon" warning fires: `fraction` of the business time between start and target. */
export function computeDueSoonAt(start: Date, target: Date, fraction: number, cal: BusinessCalendar): Date {
  const effectiveStart = isBusinessTime(start, cal) ? start : nextBusinessStart(start, cal);
  const totalMinutes = Math.max(0, businessHoursBetween(effectiveStart, target, cal) * 60);
  return addBusinessMinutes(effectiveStart, totalMinutes * fraction, cal);
}

/** Business minutes remaining until the target (negative when overdue). */
export function businessMinutesRemaining(now: Date, target: Date, cal: BusinessCalendar): number {
  return Math.round(businessHoursBetween(now, target, cal) * 60);
}

export interface ContactAttempt {
  at: Date;
  channel: string;
}

/**
 * c69 §4.6: logged unanswered attempts complete the task as `attempted` once
 * `needed` qualifying attempts exist, where each further attempt must be on
 * a different channel OR at least `minSpacingMinutes` business minutes after
 * the previous qualifying one.
 */
export function attemptsSatisfy(
  attempts: readonly ContactAttempt[],
  rule: { needed: number; minSpacingMinutes: number },
  cal: BusinessCalendar
): boolean {
  const sorted = [...attempts].sort((a, b) => a.at.getTime() - b.at.getTime());
  const counted: ContactAttempt[] = [];
  for (const a of sorted) {
    const last = counted[counted.length - 1];
    if (!last) {
      counted.push(a);
      continue;
    }
    const differentChannel = !counted.some((c) => c.channel === a.channel);
    const spaced = businessHoursBetween(last.at, a.at, cal) * 60 >= rule.minSpacingMinutes;
    if (differentChannel || spaced) counted.push(a);
  }
  return counted.length >= rule.needed;
}

export type ResponseOutcome = "contacted" | "attempted" | "bypassed_emergency" | "not_an_inquiry" | "declined";

export interface ResponseRecord {
  channel: string;
  startedAt: Date;
  targetAt: Date;
  firstHumanContactAt: Date | null;
  outcome: ResponseOutcome | null;
}

export interface ResponseMetrics {
  channel: string;
  inquiries: number;
  contacted: number;
  attempted: number;
  metTarget: number;
  /** Median business minutes to first human contact (contacted only). */
  medianBusinessMinutes: number | null;
}

/** c69 rule 9: aggregates for insights (c33) and conversion (c74). Spam/not-an-inquiry and emergencies are excluded. */
export function summarizeResponseTimes(rows: readonly ResponseRecord[], cal: BusinessCalendar): ResponseMetrics[] {
  const byChannel = new Map<string, ResponseRecord[]>();
  for (const r of rows) {
    if (r.outcome === "not_an_inquiry" || r.outcome === "bypassed_emergency") continue;
    byChannel.set(r.channel, [...(byChannel.get(r.channel) ?? []), r]);
  }
  return [...byChannel.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([channel, list]) => {
      const contacted = list.filter((r) => r.outcome === "contacted" && r.firstHumanContactAt);
      const minutes = contacted
        .map((r) => Math.max(0, businessHoursBetween(r.startedAt, r.firstHumanContactAt!, cal) * 60))
        .sort((a, b) => a - b);
      const mid = Math.floor(minutes.length / 2);
      const median =
        minutes.length === 0 ? null : minutes.length % 2 === 1 ? minutes[mid]! : (minutes[mid - 1]! + minutes[mid]!) / 2;
      return {
        channel,
        inquiries: list.length,
        contacted: contacted.length,
        attempted: list.filter((r) => r.outcome === "attempted").length,
        metTarget: contacted.filter((r) => r.firstHumanContactAt!.getTime() <= r.targetAt.getTime()).length,
        medianBusinessMinutes: median === null ? null : Math.round(median),
      };
    });
}
