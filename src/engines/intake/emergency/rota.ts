// c66 — on-call rota and escalation chain (pure). Real clock throughout:
// emergencies are never measured in business hours.

import { toLocal, type Weekday } from "@/core/businessHours";
import { localWeekday } from "../common/time";

export type RotaRole = "primary" | "backup" | "staff";

export interface RotaShift {
  userId: string;
  role: RotaRole;
  active: boolean;
  startsAt: Date | null;
  endsAt: Date | null;
  weekday: string | null;
  startTime: string | null;
  endTime: string | null;
}

const WEEKDAYS: readonly Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function minutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return h * 60 + m;
}

function previousWeekday(d: Weekday): Weekday {
  return WEEKDAYS[(WEEKDAYS.indexOf(d) + 6) % 7] as Weekday;
}

/** Does the shift cover this instant? Weekly shifts may run past midnight. Pure. */
export function shiftCovers(shift: RotaShift, at: Date, timeZone: string): boolean {
  if (!shift.active) return false;
  if (shift.startsAt && shift.endsAt) return at.getTime() >= shift.startsAt.getTime() && at.getTime() < shift.endsAt.getTime();
  if (!shift.weekday || !shift.startTime || !shift.endTime) return false;
  const l = toLocal(at, timeZone);
  const nowM = l.hour * 60 + l.minute;
  const day = localWeekday(at, timeZone);
  const s = minutes(shift.startTime);
  const e = minutes(shift.endTime);
  if (e > s) return shift.weekday === day && nowM >= s && nowM < e;
  // Overnight: covers [start, 24:00) on its day and [00:00, end) on the next day.
  if (shift.weekday === day && nowM >= s) return true;
  return shift.weekday === previousWeekday(day) && nowM < e;
}

export interface OnCall {
  primary: string[];
  backup: string[];
  staff: string[];
}

export function onCallAt(shifts: readonly RotaShift[], at: Date, timeZone: string): OnCall {
  const out: OnCall = { primary: [], backup: [], staff: [] };
  for (const s of shifts) {
    if (shiftCovers(s, at, timeZone) && !out[s.role].includes(s.userId)) out[s.role].push(s.userId);
  }
  return out;
}

/** Periods (sampled every `stepMinutes`) with no primary on call between `from` and `to`. Pure. */
export function findCoverageGaps(
  shifts: readonly RotaShift[],
  from: Date,
  to: Date,
  timeZone: string,
  stepMinutes = 30
): Array<{ start: Date; end: Date }> {
  const gaps: Array<{ start: Date; end: Date }> = [];
  const step = stepMinutes * 60_000;
  let open: Date | null = null;
  for (let t = from.getTime(); t < to.getTime(); t += step) {
    const covered = onCallAt(shifts, new Date(t), timeZone).primary.length > 0;
    if (!covered && !open) open = new Date(t);
    if (covered && open) {
      gaps.push({ start: open, end: new Date(t) });
      open = null;
    }
  }
  if (open) gaps.push({ start: open, end: new Date(to.getTime()) });
  return gaps;
}

export interface EscalationStep {
  step: number;
  userIds: string[];
  label: "on_call" | "backup" | "owners" | "whole_chain";
  /** True when this step had nobody to page and fell through to owners/admins. */
  rotaGap: boolean;
}

/**
 * Who to page at each step (c66 urgent track §3 and failure paths):
 *  0 — on-call primary (+ on-call staff for safety alerts);
 *  1 — backup;
 *  2 — firm owner/admin;
 *  3+ — the whole chain again, every ack window, until someone acknowledges.
 * An empty step falls through to owners/admins so a page never goes nowhere.
 */
export function escalationStep(step: number, onCall: OnCall, owners: readonly string[], track: "safety" | "urgent_legal"): EscalationStep {
  const uniq = (xs: string[]) => [...new Set(xs)];
  let users: string[];
  let label: EscalationStep["label"];
  if (step <= 0) {
    users = uniq([...onCall.primary, ...(track === "safety" ? onCall.staff : [])]);
    label = "on_call";
  } else if (step === 1) {
    users = uniq(onCall.backup);
    label = "backup";
  } else if (step === 2) {
    users = uniq([...owners]);
    label = "owners";
  } else {
    users = uniq([...onCall.primary, ...onCall.staff, ...onCall.backup, ...owners]);
    label = "whole_chain";
  }
  if (users.length === 0) return { step, userIds: uniq([...owners]), label: "owners", rotaGap: step <= 1 };
  return { step, userIds: users, label, rotaGap: false };
}
