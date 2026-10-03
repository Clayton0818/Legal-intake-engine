// Calendar-date arithmetic on 'YYYY-MM-DD' strings. Legal dates (limitation
// dates, court deadlines) are whole local days in a court's or firm's zone, so
// they are never stored as instants; these helpers convert to an instant only
// at the edge (instantAt). Pure; time zones via src/core/businessHours.ts.

import { fromLocal, localDateString, toLocal, type Weekday } from "@/core";

export const WEEKDAY_KEYS: readonly Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAY_MS = 86_400_000;

export interface Civil {
  y: number;
  m: number;
  d: number;
}

export function parseDate(date: string): Civil {
  const m = ISO_DATE.exec(date);
  if (!m) throw new Error(`Invalid date '${date}': expected YYYY-MM-DD.`);
  const c = { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
  const t = new Date(Date.UTC(c.y, c.m - 1, c.d));
  if (t.getUTCFullYear() !== c.y || t.getUTCMonth() !== c.m - 1 || t.getUTCDate() !== c.d) {
    throw new Error(`Invalid date '${date}': no such day.`);
  }
  return c;
}

export function formatDate(c: Civil): string {
  return `${String(c.y).padStart(4, "0")}-${String(c.m).padStart(2, "0")}-${String(c.d).padStart(2, "0")}`;
}

function toUtcMs(date: string): number {
  const c = parseDate(date);
  return Date.UTC(c.y, c.m - 1, c.d);
}

function fromUtcMs(ms: number): string {
  const t = new Date(ms);
  return formatDate({ y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() });
}

export function addDays(date: string, days: number): string {
  return fromUtcMs(toUtcMs(date) + days * DAY_MS);
}

/**
 * Add calendar months. A day that does not exist in the target month clamps
 * to the month's last day (Jan 31 + 1 month = Feb 28/29). Whether a court or
 * statute counts months this way is part of the gated rule, not settled here.
 */
export function addMonths(date: string, months: number): string {
  const c = parseDate(date);
  const total = c.y * 12 + (c.m - 1) + months;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return formatDate({ y, m, d: Math.min(c.d, last) });
}

export function addYears(date: string, years: number): string {
  return addMonths(date, years * 12);
}

export function weekdayOf(date: string): Weekday {
  return WEEKDAY_KEYS[new Date(toUtcMs(date)).getUTCDay()] as Weekday;
}

/** Whole days from `a` to `b` (negative when b is earlier). */
export function daysBetween(a: string, b: string): number {
  return Math.round((toUtcMs(b) - toUtcMs(a)) / DAY_MS);
}

export function compareDates(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Today's date in a zone. */
export function todayIn(timeZone: string, now: Date): string {
  return localDateString(now, timeZone);
}

export function parseHHMM(value: string): { hour: number; minute: number } {
  const m = HHMM.exec(value);
  if (!m) throw new Error(`Invalid time '${value}': expected 24h "HH:MM".`);
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

export function isHHMM(value: unknown): value is string {
  return typeof value === "string" && HHMM.test(value);
}

/** The instant a local date + 'HH:MM' falls on in `timeZone`. */
export function instantAt(date: string, time: string, timeZone: string): Date {
  const c = parseDate(date);
  const t = parseHHMM(time);
  return fromLocal(c.y, c.m, c.d, t.hour, t.minute, timeZone);
}

/** The last instant of a local day (23:59:59.999), used for all-day deadlines. */
export function endOfLocalDay(date: string, timeZone: string): Date {
  const next = parseDate(addDays(date, 1));
  return new Date(fromLocal(next.y, next.m, next.d, 0, 0, timeZone).getTime() - 1);
}

/** Minutes since local midnight of an instant in `timeZone`. */
export function localMinutes(at: Date, timeZone: string): number {
  const l = toLocal(at, timeZone);
  return l.hour * 60 + l.minute;
}
