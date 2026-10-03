// Shared fixtures for the calendar-alerts unit tests.
import type { BusinessCalendar } from "@/core/businessHours";
import { DEFAULT_WEEKLY_HOURS } from "@/db/tables/foundation";

export const TZ = "America/Chicago";

/** Mon–Fri 09:00–17:00 America/Chicago (the firm_settings default). */
export const CAL: BusinessCalendar = { timeZone: TZ, weekly: DEFAULT_WEEKLY_HOURS, holidays: [] };

/** A Chicago wall-clock time in October 2026 (CDT, UTC-5). */
export function chicago(day: number, hour: number, minute = 0): Date {
  return new Date(Date.UTC(2026, 9, day, hour + 5, minute));
}

export const CLOCK_SETTINGS = {
  firmReplyHours: 24,
  clientPromiseHours: 48,
  deadlineQuestionFlagHours: 12,
  deadlineQuestionReplyHours: 24,
};
