// Date helpers for billing. Dates are plain ISO calendar dates ("YYYY-MM-DD")
// interpreted in the firm's time zone; nothing here depends on the server's
// local zone.
//
// Founder decision: response/overdue timers count firm BUSINESS time (firm
// working days + holidays). Contractual dates (installment due dates, invoice
// due dates, aging) are calendar dates. This file supports both.

export type IsoDate = string;

export interface FirmCalendar {
  /** 0 = Sunday ... 6 = Saturday. Default Monday-Friday. */
  workingWeekdays: number[];
  /** Firm holidays as ISO dates. */
  holidays: IsoDate[];
}

export const DEFAULT_FIRM_CALENDAR: FirmCalendar = {
  workingWeekdays: [1, 2, 3, 4, 5],
  holidays: [],
};

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseIsoDate(d: IsoDate): Date {
  if (!ISO_RE.test(d)) throw new Error(`Expected YYYY-MM-DD, got "${d}"`);
  const [y, m, day] = d.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, day));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== day) {
    throw new Error(`Invalid calendar date "${d}"`);
  }
  return dt;
}

export function toIsoDate(dt: Date): IsoDate {
  return dt.toISOString().slice(0, 10);
}

export function addDays(d: IsoDate, n: number): IsoDate {
  const dt = parseIsoDate(d);
  dt.setUTCDate(dt.getUTCDate() + n);
  return toIsoDate(dt);
}

/** Add calendar months, clamping to the last day of the target month (Jan 31 + 1 month = Feb 28/29). */
export function addMonths(d: IsoDate, n: number): IsoDate {
  const dt = parseIsoDate(d);
  const day = dt.getUTCDate();
  const target = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + n, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return toIsoDate(target);
}

/** Whole calendar days from a to b (b - a). */
export function daysBetween(a: IsoDate, b: IsoDate): number {
  return Math.round((parseIsoDate(b).getTime() - parseIsoDate(a).getTime()) / 86_400_000);
}

export function isBusinessDay(d: IsoDate, cal: FirmCalendar = DEFAULT_FIRM_CALENDAR): boolean {
  const wd = parseIsoDate(d).getUTCDay();
  return cal.workingWeekdays.includes(wd) && !cal.holidays.includes(d);
}

/** The same day if it is a business day, otherwise the next one. */
export function onOrNextBusinessDay(d: IsoDate, cal: FirmCalendar = DEFAULT_FIRM_CALENDAR): IsoDate {
  let cur = d;
  for (let i = 0; i < 366; i++) {
    if (isBusinessDay(cur, cal)) return cur;
    cur = addDays(cur, 1);
  }
  throw new Error("Firm calendar has no business days in a year");
}

/** Move n business days forward (n > 0) or backward (n < 0). n = 0 returns onOrNextBusinessDay(d). */
export function addBusinessDays(d: IsoDate, n: number, cal: FirmCalendar = DEFAULT_FIRM_CALENDAR): IsoDate {
  if (n === 0) return onOrNextBusinessDay(d, cal);
  const step = n > 0 ? 1 : -1;
  let remaining = Math.abs(n);
  let cur = d;
  let guard = 0;
  while (remaining > 0) {
    cur = addDays(cur, step);
    if (isBusinessDay(cur, cal)) remaining--;
    if (++guard > 3660) throw new Error("Firm calendar has too few business days");
  }
  return cur;
}
