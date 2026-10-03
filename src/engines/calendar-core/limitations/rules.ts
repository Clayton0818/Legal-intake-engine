// c93 — statute-of-limitations tracking: pure rules.
//
// - A limitation date is ENTERED BY A LAWYER. The product never computes the
//   date it relies on; an optional suggestion from the firm's own period
//   table is gated ('rules.limitation_periods') and still has to be typed in.
// - A SECOND person (another lawyer, or staff the firm lists as trained)
//   verifies it independently: they enter the date they worked out without
//   being shown the lawyer's date; a match verifies, a mismatch disputes.
// - Only a lawyer changes the date, always with a logged reason, and every
//   change needs a fresh verification.
// - Unverified (or disputed) dates are flagged every day; escalating
//   reminders go out at firm-set intervals. All on the REAL clock — missed
//   limitation dates are a leading cause of malpractice claims.

import type { FlagSeverity } from "@/core";
import { canVerifyLimitations, type Staff } from "../actors";
import { addDays, addMonths, addYears, compareDates, daysBetween, instantAt, parseDate } from "../dates";
import type { CalendarCoreSettings, LimitationPeriodEntry } from "../settings";

export const LIMITATION_STATUSES = ["unverified", "verified", "disputed", "satisfied", "withdrawn"] as const;
export type LimitationStatus = (typeof LIMITATION_STATUSES)[number];
/** Statuses that still need watching (reminders run, filing task open). */
export const OPEN_LIMITATION_STATUSES: readonly LimitationStatus[] = ["unverified", "verified", "disputed"];
/** Statuses flagged daily until a second person verifies. */
export const NEEDS_VERIFICATION: readonly LimitationStatus[] = ["unverified", "disputed"];

export const FLAG_TYPES = {
  unverified: "calendar-core.limitation_unverified",
  reminder: "calendar-core.limitation_reminder",
  passed: "calendar-core.limitation_passed",
  disputed: "calendar-core.limitation_disputed",
  decisionNeeded: "calendar-core.limitation_decision_needed",
  intakeRisk: "calendar-core.limitation_intake_risk",
} as const;

export const TASK_KINDS = {
  filing: "calendar-core.limitation_filing",
  verify: "calendar-core.limitation_verify",
} as const;

export interface LimitationEntryInput {
  claimDescription: string;
  limitationDate: string;
  accrualDate?: string | null;
  basis?: string | null;
}

function validDate(v: string | null | undefined): boolean {
  if (!v) return false;
  try {
    parseDate(v);
    return true;
  } catch {
    return false;
  }
}

/** Validate a lawyer's entry. Errors block; warnings are shown and logged. Pure. */
export function validateLimitationEntry(input: LimitationEntryInput, today: string): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const claim = input.claimDescription?.trim() ?? "";
  if (!claim) errors.push("Describe the claim this date limits.");
  else if (claim.length > 300) errors.push("The claim description is too long (300 characters at most).");
  if (!validDate(input.limitationDate)) errors.push("The limitation date must be a real date 'YYYY-MM-DD'.");
  if (input.accrualDate && !validDate(input.accrualDate)) errors.push("The accrual date must be a real date 'YYYY-MM-DD'.");
  if (errors.length === 0) {
    if (input.accrualDate && compareDates(input.accrualDate, input.limitationDate) >= 0) {
      errors.push("The limitation date must be after the accrual date.");
    }
    const left = daysBetween(today, input.limitationDate);
    if (left < 0) warnings.push(`This date passed ${-left} day(s) ago. It is flagged at the highest level immediately.`);
    else if (left <= 30) warnings.push(`Only ${left} day(s) remain. Reminders start at the most urgent level.`);
  }
  if ((input.basis ?? "").length > 2000) errors.push("The basis note is too long (2000 characters at most).");
  return { errors, warnings };
}

/** Independence of the verifier. Pure. */
export function checkVerifierIndependence(
  record: { enteredByUserId: string; lastChangedByUserId: string | null; status: string },
  verifier: Pick<Staff, "userId" | "role">,
  trainedStaffIds: readonly string[]
): { ok: true } | { ok: false; reason: string } {
  if (!(NEEDS_VERIFICATION as readonly string[]).includes(record.status)) {
    return { ok: false, reason: `This date is ${record.status}; there is nothing to verify.` };
  }
  if (!canVerifyLimitations(verifier, trainedStaffIds)) {
    return { ok: false, reason: "Only another lawyer, or staff the firm has listed as trained, can verify a limitation date." };
  }
  if (verifier.userId === record.enteredByUserId) {
    return { ok: false, reason: "The lawyer who entered the date cannot verify it; a second person must." };
  }
  if (record.lastChangedByUserId && verifier.userId === record.lastChangedByUserId) {
    return { ok: false, reason: "The lawyer who last changed the date cannot verify it; a second person must." };
  }
  return { ok: true };
}

export function verificationOutcome(recordDate: string, verifierDate: string): "match" | "mismatch" {
  return recordDate === verifierDate ? "match" : "mismatch";
}

/** Whole days left until the limitation date (negative once it has passed). */
export function daysRemaining(limitationDate: string, today: string): number {
  return daysBetween(today, limitationDate);
}

/**
 * Which reminder threshold to send now. Only the most urgent crossed and
 * not-yet-recorded threshold is sent; any less urgent ones crossed at the same
 * time (a date entered late, or changed) are recorded as skipped so they never
 * fire later out of order. Pure.
 */
export function remindersDue(
  thresholds: readonly number[],
  days: number,
  recorded: ReadonlySet<number>
): { send: number | null; skip: number[] } {
  if (days < 0) return { send: null, skip: [] }; // passed: handled by the daily "passed" flag
  const crossed = thresholds.filter((t) => days <= t && !recorded.has(t)).sort((a, b) => a - b);
  if (crossed.length === 0) return { send: null, skip: [] };
  const [send, ...skip] = crossed;
  return { send: send ?? null, skip };
}

export interface ReminderLevel {
  severity: FlagSeverity;
  /** Add the firm's escalation users (supervising lawyers / admins). */
  escalate: boolean;
  /** Add every firm admin as well. */
  allAdmins: boolean;
  /** Ignore quiet hours / digests. */
  urgent: boolean;
}

/** How loud a reminder is, by days remaining. Escalates as the date nears. Pure. */
export function reminderLevel(days: number, s: Pick<CalendarCoreSettings, "limitationSupervisorAtDays" | "limitationCriticalAtDays">): ReminderLevel {
  if (days <= s.limitationCriticalAtDays) return { severity: "critical", escalate: true, allAdmins: true, urgent: true };
  if (days <= s.limitationSupervisorAtDays) return { severity: "high", escalate: true, allAdmins: false, urgent: true };
  if (days <= s.limitationSupervisorAtDays * 3) return { severity: "warning", escalate: false, allAdmins: false, urgent: false };
  return { severity: "info", escalate: false, allAdmins: false, urgent: false };
}

/** Severity of the daily "not yet independently verified" flag. Pure. */
export function unverifiedLevel(days: number, status: string, s: Pick<CalendarCoreSettings, "unverifiedCriticalWithinDays">): ReminderLevel {
  if (days <= s.unverifiedCriticalWithinDays || status === "disputed") {
    return { severity: "critical", escalate: true, allAdmins: days <= s.unverifiedCriticalWithinDays, urgent: true };
  }
  return { severity: "high", escalate: false, allAdmins: false, urgent: false };
}

/** One daily flag per record per local day. */
export function dailyDedupeKey(type: string, limitationId: string, today: string): string {
  return `${type}:${limitationId}:${today}`;
}

export function dedupePrefix(type: string, limitationId: string): string {
  return `${type}:${limitationId}:`;
}

/** When the filing task falls due: the firm-set local time ON the limitation date (default 00:00 — conservative). */
export function filingTaskDueAt(limitationDate: string, timeZone: string, localTime: string): Date {
  return instantAt(limitationDate, localTime, timeZone);
}

/** Recipients, de-duplicated, never empty if any fallback exists. Pure. */
export function reminderRecipients(input: {
  responsibleUserId: string | null;
  enteredByUserId: string;
  escalationUserIds: readonly string[];
  adminUserIds: readonly string[];
  level: Pick<ReminderLevel, "escalate" | "allAdmins">;
}): string[] {
  const out = new Set<string>();
  if (input.responsibleUserId) out.add(input.responsibleUserId);
  out.add(input.enteredByUserId);
  if (input.level.escalate) for (const id of input.escalationUserIds.length > 0 ? input.escalationUserIds : input.adminUserIds) out.add(id);
  if (input.level.allAdmins) for (const id of input.adminUserIds) out.add(id);
  return [...out];
}

export interface LimitationSuggestion {
  suggestedDate: string;
  explanation: string[];
  warnings: string[];
}

/**
 * A SUGGESTION from the firm's own period table (accrual + period). Applied
 * only under 'rules.limitation_periods' by the service; the lawyer must still
 * enter the date themselves and a second person verifies it. Pure.
 */
export function suggestLimitationDate(accrualDate: string, period: LimitationPeriodEntry): LimitationSuggestion {
  let date = accrualDate;
  const explanation = [`Accrual date entered: ${accrualDate}.`];
  if (period.years) {
    date = addYears(date, period.years);
    explanation.push(`+ ${period.years} year(s) → ${date}.`);
  }
  if (period.months) {
    date = addMonths(date, period.months);
    explanation.push(`+ ${period.months} month(s) → ${date}.`);
  }
  if (period.days) {
    date = addDays(date, period.days);
    explanation.push(`+ ${period.days} day(s) → ${date}.`);
  }
  explanation.push(`Period from the firm's table: '${period.label}' (${period.citation}).`);
  return {
    suggestedDate: date,
    explanation,
    warnings: [
      "Suggestion only — not legal advice and not a calendared date.",
      "It does not account for tolling, the discovery rule, minority/disability, notice requirements, or how the last day is counted if it falls on a weekend or holiday.",
      "A lawyer must decide the date and enter it; a second person must verify it independently.",
    ],
  };
}
