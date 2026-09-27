// Small calendar helpers on top of src/core/businessHours.ts (pure).

import { fromLocal, localDateString, toLocal, type BusinessCalendar, type Weekday } from "@/core/businessHours";

const WEEKDAYS: readonly Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DAY_MS = 86_400_000;

function holidayDates(cal: BusinessCalendar): Set<string> {
  return new Set(cal.holidays.map((h) => (typeof h === "string" ? h : h.date)));
}

function civilAdd(y: number, m: number, d: number, days: number): { y: number; m: number; d: number } {
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

function civilString(c: { y: number; m: number; d: number }): string {
  return `${String(c.y).padStart(4, "0")}-${String(c.m).padStart(2, "0")}-${String(c.d).padStart(2, "0")}`;
}

/** Local weekday of an instant in a time zone. */
export function localWeekday(at: Date, timeZone: string): Weekday {
  const l = toLocal(at, timeZone);
  return WEEKDAYS[new Date(Date.UTC(l.year, l.month - 1, l.day)).getUTCDay()] as Weekday;
}

/**
 * Absolute business intervals between `from` and `to` (clipped), in order.
 * Used to build booking slots and to count business days.
 */
export function businessWindows(cal: BusinessCalendar, from: Date, to: Date): Array<{ start: Date; end: Date; date: string }> {
  if (to.getTime() <= from.getTime()) return [];
  const holidays = holidayDates(cal);
  const out: Array<{ start: Date; end: Date; date: string }> = [];
  const l = toLocal(from, cal.timeZone);
  const lastDate = localDateString(to, cal.timeZone);
  // Start a day early so an overnight/DST edge never drops the first window.
  let c = civilAdd(l.year, l.month, l.day, -1);
  for (let i = 0; i < 400; i++) {
    const date = civilString(c);
    if (!holidays.has(date)) {
      const weekday = WEEKDAYS[new Date(Date.UTC(c.y, c.m - 1, c.d)).getUTCDay()] as Weekday;
      for (const iv of cal.weekly[weekday] ?? []) {
        const [sh, sm] = iv.start.split(":").map(Number) as [number, number];
        const [eh, em] = iv.end.split(":").map(Number) as [number, number];
        const start = fromLocal(c.y, c.m, c.d, sh, sm, cal.timeZone);
        const next = civilAdd(c.y, c.m, c.d, 1);
        const end = eh === 24 ? fromLocal(next.y, next.m, next.d, 0, 0, cal.timeZone) : fromLocal(c.y, c.m, c.d, eh, em, cal.timeZone);
        const s = Math.max(start.getTime(), from.getTime());
        const e = Math.min(end.getTime(), to.getTime());
        if (e > s) out.push({ start: new Date(s), end: new Date(e), date });
      }
    }
    if (date === lastDate) break;
    c = civilAdd(c.y, c.m, c.d, 1);
  }
  return out;
}

/**
 * The end of the Nth business day after `start`'s local date (days with at
 * least one business interval). "Deadlines in the next 3 business days"
 * (c48) and "5 business days to re-book" (c67) use this.
 */
export function addBusinessDays(start: Date, days: number, cal: BusinessCalendar): Date {
  if (days <= 0) return new Date(start.getTime());
  const windows = businessWindows(cal, new Date(start.getTime() + 1), new Date(start.getTime() + (days * 3 + 30) * DAY_MS));
  const startDate = localDateString(start, cal.timeZone);
  const dates: string[] = [];
  const lastEnd = new Map<string, Date>();
  for (const w of windows) {
    if (w.date <= startDate) continue;
    if (!lastEnd.has(w.date)) dates.push(w.date);
    lastEnd.set(w.date, w.end);
  }
  const target = dates[days - 1];
  if (!target) throw new Error("addBusinessDays: no business days found — check the firm's calendar.");
  return lastEnd.get(target)!;
}

/** Do two half-open intervals overlap? */
export function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart.getTime() < bEnd.getTime() && bStart.getTime() < aEnd.getTime();
}

export function addMinutes(at: Date, minutes: number): Date {
  return new Date(at.getTime() + Math.round(minutes * 60_000));
}

export function addHours(at: Date, hours: number): Date {
  return new Date(at.getTime() + Math.round(hours * 3_600_000));
}
