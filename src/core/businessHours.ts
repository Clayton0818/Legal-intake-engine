// Business-hours arithmetic (founder decision, c43/c44/c45: firm timers count
// the firm's BUSINESS hours — its own weekly hours, time zone and holidays).
// Court notices and deadline safety nets use the REAL clock instead; see
// addClockHours() for the switch between the two.
//
// Pure functions, no dependencies: time-zone conversion uses the built-in
// Intl API (full ICU ships with Node 20+ and every modern browser), so DST
// transitions follow the IANA database for the firm's zone.

import type { BusinessInterval, FirmHoliday, Weekday, WeeklyHours } from "@/db/types";

export type { BusinessInterval, FirmHoliday, Weekday, WeeklyHours };

export interface BusinessCalendar {
  /** IANA time zone, e.g. 'America/Chicago'. */
  timeZone: string;
  weekly: WeeklyHours;
  /** Whole local days with no business hours: 'YYYY-MM-DD' strings or FirmHoliday objects. */
  holidays: readonly (string | FirmHoliday)[];
}

export type Clock = "business" | "real";

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
/** Safety bound for day-walking loops (≈ 5 years). */
const MAX_DAYS = 366 * 5;
const WEEKDAYS: readonly Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

// ---------------------------------------------------------------------------
// Time-zone helpers
// ---------------------------------------------------------------------------

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

export interface LocalDateTime {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Wall-clock parts of an instant in a time zone. */
export function toLocal(at: Date | number, timeZone: string): LocalDateTime {
  const parts = formatterFor(timeZone).formatToParts(new Date(at));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour") % 24,
    minute: get("minute"),
    second: get("second"),
  };
}

/** Offset (local - UTC) in ms for an instant, at whole-second precision. */
function offsetMs(utcMs: number, timeZone: string): number {
  const l = toLocal(utcMs, timeZone);
  const asUtc = Date.UTC(l.year, l.month - 1, l.day, l.hour, l.minute, l.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/**
 * The instant at which the wall clock in `timeZone` reads the given local
 * time. Nonexistent local times (inside a spring-forward gap) resolve to the
 * equivalent instant after the gap; ambiguous ones (fall-back) resolve to the
 * first occurrence.
 */
export function fromLocal(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string
): Date {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const o1 = offsetMs(wall, timeZone);
  const t1 = wall - o1;
  const o2 = offsetMs(t1, timeZone);
  if (o2 === o1) return new Date(t1);
  // Near a DST transition the two offsets disagree. Keep the candidates that
  // actually reproduce the wall time; if both do (fall-back overlap) take the
  // earlier, if neither does (spring-forward gap) take the later, which is
  // the same wall time expressed after the jump.
  const candidates = [t1, wall - o2];
  const consistent = candidates.filter((c) => c + offsetMs(c, timeZone) === wall);
  return new Date(consistent.length > 0 ? Math.min(...consistent) : Math.max(...candidates));
}

/** 'YYYY-MM-DD' of an instant in the given zone. */
export function localDateString(at: Date | number, timeZone: string): string {
  const l = toLocal(at, timeZone);
  return civilToString(l.year, l.month, l.day);
}

function civilToString(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

interface Civil {
  y: number;
  m: number;
  d: number;
}

function nextCivil(c: Civil): Civil {
  const t = new Date(Date.UTC(c.y, c.m - 1, c.d + 1));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

function weekdayOf(c: Civil): Weekday {
  return WEEKDAYS[new Date(Date.UTC(c.y, c.m - 1, c.d)).getUTCDay()] as Weekday;
}

// ---------------------------------------------------------------------------
// Calendar validation and daily intervals
// ---------------------------------------------------------------------------

const HHMM = /^([01]\d|2[0-4]):([0-5]\d)$/;

function parseHHMM(value: string): { hour: number; minute: number } {
  const m = HHMM.exec(value);
  if (!m) throw new Error(`Invalid time '${value}': expected 24h "HH:MM".`);
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour === 24 && minute !== 0) throw new Error(`Invalid time '${value}': only "24:00" is allowed past 23:59.`);
  return { hour, minute };
}

/** Throws a descriptive error if the calendar is unusable. */
export function validateCalendar(cal: BusinessCalendar): void {
  if (!isValidTimeZone(cal.timeZone)) throw new Error(`Unknown time zone '${cal.timeZone}'.`);
  let any = false;
  for (const [day, intervals] of Object.entries(cal.weekly)) {
    if (!WEEKDAYS.includes(day as Weekday)) throw new Error(`Unknown weekday key '${day}'.`);
    for (const iv of intervals ?? []) {
      const s = parseHHMM(iv.start);
      const e = parseHHMM(iv.end);
      if (s.hour * 60 + s.minute >= e.hour * 60 + e.minute) {
        throw new Error(`Business interval ${iv.start}-${iv.end} on '${day}' must end after it starts.`);
      }
      any = true;
    }
  }
  if (!any) throw new Error("Business calendar has no business hours on any weekday.");
  for (const h of cal.holidays) {
    const date = typeof h === "string" ? h : h.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Invalid holiday date '${date}': expected YYYY-MM-DD.`);
  }
}

function holidaySet(cal: BusinessCalendar): Set<string> {
  return new Set(cal.holidays.map((h) => (typeof h === "string" ? h : h.date)));
}

/** Business intervals [startMs, endMs) for one local date, merged and sorted. */
function intervalsFor(c: Civil, cal: BusinessCalendar, holidays: Set<string>): Array<[number, number]> {
  if (holidays.has(civilToString(c.y, c.m, c.d))) return [];
  const defs = cal.weekly[weekdayOf(c)] ?? [];
  const out: Array<[number, number]> = [];
  for (const iv of defs) {
    const s = parseHHMM(iv.start);
    const e = parseHHMM(iv.end);
    const startMs = fromLocal(c.y, c.m, c.d, s.hour, s.minute, cal.timeZone).getTime();
    const endMs =
      e.hour === 24
        ? (() => {
            const n = nextCivil(c);
            return fromLocal(n.y, n.m, n.d, 0, 0, cal.timeZone).getTime();
          })()
        : fromLocal(c.y, c.m, c.d, e.hour, e.minute, cal.timeZone).getTime();
    if (endMs > startMs) out.push([startMs, endMs]);
  }
  out.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const iv of out) {
    const last = merged[merged.length - 1];
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else merged.push([iv[0], iv[1]]);
  }
  return merged;
}

function civilOf(at: number, timeZone: string): Civil {
  const l = toLocal(at, timeZone);
  return { y: l.year, m: l.month, d: l.day };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** True when `at` falls inside the firm's business hours (holidays excluded). */
export function isBusinessTime(at: Date, cal: BusinessCalendar): boolean {
  validateCalendar(cal);
  const t = at.getTime();
  return intervalsFor(civilOf(t, cal.timeZone), cal, holidaySet(cal)).some(([s, e]) => t >= s && t < e);
}

/** `at` itself if it is business time, otherwise the start of the next business interval. */
export function nextBusinessStart(at: Date, cal: BusinessCalendar): Date {
  validateCalendar(cal);
  const holidays = holidaySet(cal);
  const t = at.getTime();
  let c = civilOf(t, cal.timeZone);
  for (let i = 0; i < MAX_DAYS; i++) {
    for (const [s, e] of intervalsFor(c, cal, holidays)) {
      if (t >= s && t < e) return new Date(t);
      if (s > t) return new Date(s);
    }
    c = nextCivil(c);
  }
  throw new Error("No business time found within five years — check the firm's holidays.");
}

/**
 * The instant `hours` business hours after `start`. Time outside business
 * hours does not count: a Friday 6pm start with 24 business hours on a
 * Mon–Fri 9–5 calendar lands on Wednesday 5pm. `hours` may be fractional;
 * 0 returns `start` unchanged. Landing exactly on a closing time returns that
 * closing time (not the next opening).
 */
export function addBusinessHours(start: Date, hours: number, cal: BusinessCalendar): Date {
  if (!Number.isFinite(hours) || hours < 0) throw new Error(`addBusinessHours: hours must be >= 0 (got ${hours}).`);
  validateCalendar(cal);
  if (hours === 0) return new Date(start.getTime());
  const holidays = holidaySet(cal);
  let remaining = Math.round(hours * HOUR_MS);
  let cursor = start.getTime();
  let c = civilOf(cursor, cal.timeZone);
  for (let i = 0; i < MAX_DAYS; i++) {
    for (const [s, e] of intervalsFor(c, cal, holidays)) {
      if (e <= cursor) continue;
      const from = Math.max(s, cursor);
      const available = e - from;
      if (remaining <= available) return new Date(from + remaining);
      remaining -= available;
      cursor = e;
    }
    c = nextCivil(c);
  }
  throw new Error("addBusinessHours: result is more than five years out — check the firm's holidays.");
}

/**
 * Business hours elapsed between `a` and `b` (fractional). Negative when `b`
 * is before `a`.
 */
export function businessHoursBetween(a: Date, b: Date, cal: BusinessCalendar): number {
  validateCalendar(cal);
  const from = a.getTime();
  const to = b.getTime();
  if (to < from) return -businessHoursBetween(b, a, cal);
  if (to === from) return 0;
  const holidays = holidaySet(cal);
  let total = 0;
  let c = civilOf(from, cal.timeZone);
  const last = localDateString(to, cal.timeZone);
  for (let i = 0; i < MAX_DAYS + 1; i++) {
    for (const [s, e] of intervalsFor(c, cal, holidays)) {
      const lo = Math.max(s, from);
      const hi = Math.min(e, to);
      if (hi > lo) total += hi - lo;
    }
    if (civilToString(c.y, c.m, c.d) === last) break;
    c = nextCivil(c);
  }
  return total / HOUR_MS;
}

/** Add hours on either clock: 'business' (firm calendar) or 'real' (wall time). */
export function addClockHours(start: Date, hours: number, clock: Clock, cal: BusinessCalendar): Date {
  if (clock === "real") {
    if (!Number.isFinite(hours) || hours < 0) throw new Error(`addClockHours: hours must be >= 0 (got ${hours}).`);
    return new Date(start.getTime() + Math.round(hours * HOUR_MS));
  }
  return addBusinessHours(start, hours, cal);
}

/** Hours between two instants on either clock. */
export function hoursBetweenOnClock(a: Date, b: Date, clock: Clock, cal: BusinessCalendar): number {
  return clock === "real" ? (b.getTime() - a.getTime()) / HOUR_MS : businessHoursBetween(a, b, cal);
}

/** Minutes variant for short timers (e.g. 15-minute speed-to-lead, c69). */
export function addBusinessMinutes(start: Date, minutes: number, cal: BusinessCalendar): Date {
  return addBusinessHours(start, (minutes * MINUTE_MS) / HOUR_MS, cal);
}

// ---------------------------------------------------------------------------
// Quiet hours (non-urgent client messages, c42/c51)
// ---------------------------------------------------------------------------

export interface QuietWindow {
  start: string;
  end: string;
}

function minutesOfDay(at: Date, timeZone: string): number {
  const l = toLocal(at, timeZone);
  return l.hour * 60 + l.minute;
}

/** True when `at` is within quiet hours (the window may wrap midnight, e.g. 21:00–08:00). */
export function isQuietTime(at: Date, quiet: QuietWindow, timeZone: string): boolean {
  const s = parseHHMM(quiet.start);
  const e = parseHHMM(quiet.end);
  const startM = s.hour * 60 + s.minute;
  const endM = e.hour * 60 + e.minute;
  if (startM === endM) return false;
  const m = minutesOfDay(at, timeZone);
  return startM < endM ? m >= startM && m < endM : m >= startM || m < endM;
}

/** The instant quiet hours end, if `at` is inside them; otherwise `at`. */
export function endOfQuietTime(at: Date, quiet: QuietWindow, timeZone: string): Date {
  if (!isQuietTime(at, quiet, timeZone)) return new Date(at.getTime());
  const e = parseHHMM(quiet.end);
  const l = toLocal(at, timeZone);
  const endM = e.hour * 60 + e.minute;
  const nowM = l.hour * 60 + l.minute;
  let c: Civil = { y: l.year, m: l.month, d: l.day };
  if (nowM >= endM) c = nextCivil(c);
  return fromLocal(c.y, c.m, c.d, e.hour % 24, e.minute, timeZone);
}
