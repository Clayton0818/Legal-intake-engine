// Firm-configurable settings of the calendar-core engine, stored in
// firm_settings.engine_settings["calendar-core"]. Ordinary firm settings
// (founder: "escalating reminders at firm-set intervals"), NOT approval gates.
// Legal-rule VALUES (court rules, limitation periods) are not here: they live
// in gated, lawyer-approved config (deadline_rule_sets, limitationPeriods
// below is applied only under 'rules.limitation_periods').

import { engineSetting, type FirmHoliday, type FirmSettings } from "@/core";

export const ENGINE = "calendar-core" as const;

/** A firm-entered limitation period used only to SUGGEST a date (gated; the lawyer still enters the date). */
export interface LimitationPeriodEntry {
  key: string;
  label: string;
  years: number;
  months: number;
  days: number;
  /** Statute / source the firm's attorney relied on. */
  citation: string;
}

export interface CalendarCoreSettings {
  /** c93: days before the limitation date at which escalating reminders go out. */
  limitationReminderDays: number[];
  /** c93: at or below this many days the supervisor/escalation users are added (default 30). */
  limitationSupervisorAtDays: number;
  /** c93: at or below this many days reminders are critical and go to the firm admins too (default 7). */
  limitationCriticalAtDays: number;
  /** c93: an unverified date this close (days) is flagged critical (default 30). */
  unverifiedCriticalWithinDays: number;
  /** c93: the independent verification task is due this many business hours after entry (default 8). */
  verificationDueBusinessHours: number;
  /** c93: trained staff (non-lawyers) allowed to verify limitation dates. Lawyers may always verify. */
  limitationVerifierUserIds: string[];
  /** c93: extra users added to escalated reminders (default: the firm admins). */
  limitationEscalationUserIds: string[];
  /** c93: local time on the limitation date at which the filing task falls due (default '00:00' — start of the day, conservative). */
  limitationTaskDueLocalTime: string;
  /** c93: ask a lawyer to decide "applies / not applicable" for every retained matter (default on). */
  requireLimitationDecision: boolean;
  /** c93: firm-entered limitation periods for date SUGGESTIONS (applied only under rules.limitation_periods). */
  limitationPeriods: LimitationPeriodEntry[];
  /** c92: court holidays (whole days) added to every rule set's own list. */
  courtHolidays: FirmHoliday[];
  /** c91: when a lawyer confirms a deadline event, create a deadline-critical task for the assigned lawyer (default on). */
  deadlineTaskOnConfirm: boolean;
  /** c91: how far back/forward external sync pulls (days). */
  syncWindowDays: number;
  /** c91: max push attempts before a link is marked failed. */
  syncMaxAttempts: number;
}

export const DEFAULT_CALENDAR_CORE_SETTINGS: Readonly<CalendarCoreSettings> = Object.freeze({
  limitationReminderDays: [180, 90, 60, 30, 14, 7],
  limitationSupervisorAtDays: 30,
  limitationCriticalAtDays: 7,
  unverifiedCriticalWithinDays: 30,
  verificationDueBusinessHours: 8,
  limitationVerifierUserIds: [],
  limitationEscalationUserIds: [],
  limitationTaskDueLocalTime: "00:00",
  requireLimitationDecision: true,
  limitationPeriods: [],
  courtHolidays: [],
  deadlineTaskOnConfirm: true,
  syncWindowDays: 60,
  syncMaxAttempts: 5,
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

/** Reminder thresholds: unique positive whole days, largest first. Pure. */
export function normaliseReminderDays(value: unknown): number[] {
  if (!Array.isArray(value)) return [...DEFAULT_CALENDAR_CORE_SETTINGS.limitationReminderDays];
  const days = [...new Set(value.filter((v): v is number => typeof v === "number" && Number.isInteger(v) && v > 0 && v <= 3650))];
  if (days.length === 0) return [...DEFAULT_CALENDAR_CORE_SETTINGS.limitationReminderDays];
  return days.sort((a, b) => b - a);
}

function isPeriodEntry(v: unknown): v is LimitationPeriodEntry {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  const n = (x: unknown) => typeof x === "number" && Number.isInteger(x) && x >= 0 && x <= 100;
  return (
    typeof o.key === "string" &&
    /^[a-z0-9_-]{2,60}$/.test(o.key) &&
    typeof o.label === "string" &&
    o.label.trim().length > 0 &&
    n(o.years) &&
    n(o.months) &&
    n(o.days) &&
    (o.years as number) + (o.months as number) + (o.days as number) > 0 &&
    typeof o.citation === "string" &&
    o.citation.trim().length > 0
  );
}

function isHoliday(v: unknown): v is FirmHoliday {
  return !!v && typeof v === "object" && typeof (v as FirmHoliday).date === "string" && ISO_DATE.test((v as FirmHoliday).date);
}

/** The engine's settings with defaults, unsafe values clamped. Pure. */
export function readCalendarCoreSettings(settings: Pick<FirmSettings, "engineSettings">): CalendarCoreSettings {
  const raw = {} as Record<string, unknown>;
  for (const [key, fallback] of Object.entries(DEFAULT_CALENDAR_CORE_SETTINGS)) {
    raw[key] = engineSetting(settings, ENGINE, key, fallback);
  }
  const s = raw as unknown as CalendarCoreSettings;
  const uuidList = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && UUID.test(x)) : []);
  return {
    limitationReminderDays: normaliseReminderDays(s.limitationReminderDays),
    limitationSupervisorAtDays: clampInt(s.limitationSupervisorAtDays, 1, 3650, 30),
    limitationCriticalAtDays: clampInt(s.limitationCriticalAtDays, 1, 3650, 7),
    unverifiedCriticalWithinDays: clampInt(s.unverifiedCriticalWithinDays, 1, 3650, 30),
    verificationDueBusinessHours: clampInt(s.verificationDueBusinessHours, 1, 400, 8),
    limitationVerifierUserIds: uuidList(s.limitationVerifierUserIds),
    limitationEscalationUserIds: uuidList(s.limitationEscalationUserIds),
    limitationTaskDueLocalTime:
      typeof s.limitationTaskDueLocalTime === "string" && HHMM.test(s.limitationTaskDueLocalTime) ? s.limitationTaskDueLocalTime : "00:00",
    requireLimitationDecision: typeof s.requireLimitationDecision === "boolean" ? s.requireLimitationDecision : true,
    limitationPeriods: Array.isArray(s.limitationPeriods) ? s.limitationPeriods.filter(isPeriodEntry) : [],
    courtHolidays: Array.isArray(s.courtHolidays) ? s.courtHolidays.filter(isHoliday) : [],
    deadlineTaskOnConfirm: typeof s.deadlineTaskOnConfirm === "boolean" ? s.deadlineTaskOnConfirm : true,
    syncWindowDays: clampInt(s.syncWindowDays, 1, 365, 60),
    syncMaxAttempts: clampInt(s.syncMaxAttempts, 1, 50, 5),
  };
}

/**
 * Validate a firm admin's settings patch. Unknown keys and bad values are
 * refused (never silently clamped on write). Pure.
 */
export function validateCalendarCoreSettingsPatch(patch: Record<string, unknown>): {
  values: Partial<CalendarCoreSettings>;
  errors: string[];
} {
  const values: Record<string, unknown> = {};
  const errors: string[] = [];
  const bad = (key: string, why: string) => errors.push(`'${key}' ${why}`);
  for (const [key, value] of Object.entries(patch)) {
    switch (key) {
      case "limitationReminderDays":
        if (Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "number" && Number.isInteger(v) && v > 0 && v <= 3650)) {
          values[key] = normaliseReminderDays(value);
        } else bad(key, "must be a list of whole days between 1 and 3650.");
        break;
      case "limitationSupervisorAtDays":
      case "limitationCriticalAtDays":
      case "unverifiedCriticalWithinDays":
        if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 3650) values[key] = value;
        else bad(key, "must be a whole number of days between 1 and 3650.");
        break;
      case "verificationDueBusinessHours":
        if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 400) values[key] = value;
        else bad(key, "must be between 1 and 400 business hours.");
        break;
      case "limitationVerifierUserIds":
      case "limitationEscalationUserIds":
        if (Array.isArray(value) && value.every((v) => typeof v === "string" && UUID.test(v))) values[key] = [...new Set(value)];
        else bad(key, "must be a list of user ids.");
        break;
      case "limitationTaskDueLocalTime":
        if (typeof value === "string" && HHMM.test(value)) values[key] = value;
        else bad(key, "must be a 24h time 'HH:MM'.");
        break;
      case "requireLimitationDecision":
      case "deadlineTaskOnConfirm":
        if (typeof value === "boolean") values[key] = value;
        else bad(key, "must be true or false.");
        break;
      case "limitationPeriods":
        if (Array.isArray(value) && value.every(isPeriodEntry)) values[key] = value;
        else bad(key, "must be a list of { key, label, years, months, days, citation } (citation required).");
        break;
      case "courtHolidays":
        if (Array.isArray(value) && value.every(isHoliday)) values[key] = value;
        else bad(key, "must be a list of { date: 'YYYY-MM-DD', name? }.");
        break;
      case "syncWindowDays":
        if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 365) values[key] = value;
        else bad(key, "must be between 1 and 365.");
        break;
      case "syncMaxAttempts":
        if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 50) values[key] = value;
        else bad(key, "must be between 1 and 50.");
        break;
      default:
        errors.push(`Unknown setting '${key}'.`);
    }
  }
  const supervisor = (values.limitationSupervisorAtDays as number | undefined) ?? undefined;
  const critical = (values.limitationCriticalAtDays as number | undefined) ?? undefined;
  if (supervisor !== undefined && critical !== undefined && critical > supervisor) {
    errors.push("'limitationCriticalAtDays' must not be larger than 'limitationSupervisorAtDays'.");
  }
  return { values: values as Partial<CalendarCoreSettings>, errors };
}
