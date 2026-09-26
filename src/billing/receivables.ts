// c81 — Unpaid-invoice tracking (aging) and polite reminders.
// c52 — Installment reminders and missed-installment detection.
//
// Reminders are planned here as dates; the worker (ADR-0001 D6) turns each
// into a `scheduled_tasks` row. The client-facing text comes only from
// copy.ts (placeholder until attorney-approved). Anything beyond reminders
// (collections referral, suing a client, withdrawing) is never automated:
// it becomes a task for the lawyer.

import { addBusinessDays, addDays, daysBetween, onOrNextBusinessDay, type FirmCalendar, type IsoDate } from "./calendar";
import type { Cents } from "./money";
import type { PayScheduleLine } from "./feeArrangements";

export type AgingBucket = "current" | "1_30" | "31_60" | "61_90" | "90_plus";

export const AGING_BUCKETS: AgingBucket[] = ["current", "1_30", "31_60", "61_90", "90_plus"];

/** Days past the due date (calendar days); 0 or negative = current. */
export function agingBucket(dueDate: IsoDate, asOf: IsoDate): AgingBucket {
  const late = daysBetween(dueDate, asOf);
  if (late <= 0) return "current";
  if (late <= 30) return "1_30";
  if (late <= 60) return "31_60";
  if (late <= 90) return "61_90";
  return "90_plus";
}

export interface ReceivableRow {
  invoiceId: string;
  clientId: string;
  matterId: string;
  lawyerId: string;
  dueDate: IsoDate;
  openCents: Cents;
  /** Disputed invoices are shown separately and not reminded. */
  disputed: boolean;
}

export type AgingReport = Record<string, Record<AgingBucket, Cents>>;

/** Aging totals grouped by client, matter or lawyer. Disputed amounts excluded (reported apart). */
export function agingReport(rows: ReceivableRow[], asOf: IsoDate, groupBy: "clientId" | "matterId" | "lawyerId"): AgingReport {
  const out: AgingReport = {};
  for (const r of rows) {
    if (r.openCents <= 0 || r.disputed) continue;
    const key = r[groupBy];
    const g = (out[key] ??= { current: 0, "1_30": 0, "31_60": 0, "61_90": 0, "90_plus": 0 });
    g[agingBucket(r.dueDate, asOf)] += r.openCents;
  }
  return out;
}

export interface PlannedReminder {
  sendOn: IsoDate;
  step: number; // 1-based
  kind: "before_due" | "after_due";
}

/**
 * Invoice reminder dates from the firm's offsets (days relative to due date),
 * each moved to the next firm business day. Past dates are dropped.
 */
export function planInvoiceReminders(dueDate: IsoDate, offsets: number[], today: IsoDate, cal: FirmCalendar): PlannedReminder[] {
  const sorted = [...offsets].sort((a, b) => a - b);
  const seen = new Set<string>();
  const out: PlannedReminder[] = [];
  sorted.forEach((off, i) => {
    const sendOn = onOrNextBusinessDay(addDays(dueDate, off), cal);
    if (daysBetween(today, sendOn) < 0 || seen.has(sendOn)) return;
    seen.add(sendOn);
    out.push({ sendOn, step: i + 1, kind: off < 0 ? "before_due" : "after_due" });
  });
  return out;
}

/** Reminders stop when any of these is true. */
export function shouldStopReminders(state: { openCents: Cents; disputed: boolean; onPaymentPlan: boolean; lawyerPaused: boolean }): boolean {
  return state.openCents <= 0 || state.disputed || state.onPaymentPlan || state.lawyerPaused;
}

/** After the last reminder, the lawyer gets a decision task; nothing further is automatic. */
export function lawyerDecisionTaskDue(lastReminderSentOn: IsoDate, cal: FirmCalendar, businessDays = 2): IsoDate {
  return addBusinessDays(lastReminderSentOn, businessDays, cal);
}

// ---------------------------------------------------------------------------
// c52 installments
// ---------------------------------------------------------------------------

export function planInstallmentReminders(line: PayScheduleLine, daysBefore: number[], today: IsoDate, cal: FirmCalendar): IsoDate[] {
  const dates = daysBefore
    .map((d) => onOrNextBusinessDay(addDays(line.dueDate, -d), cal))
    // moving to the next business day must not push a reminder past the due date
    .filter((d) => daysBetween(d, line.dueDate) >= 0 && daysBetween(today, d) >= 0);
  return [...new Set(dates)].sort();
}

export type InstallmentState = "upcoming" | "due_today" | "paid" | "missed";

/**
 * An installment is "missed" once the whole due date has passed unpaid. The
 * c46 client-overdue rules then take over (business-hours grace, flags to
 * client portal + email and to lawyer + billing admin).
 */
export function installmentState(line: PayScheduleLine, paidCents: Cents, today: IsoDate): InstallmentState {
  if (paidCents >= line.amountCents) return "paid";
  const d = daysBetween(line.dueDate, today);
  if (d < 0) return "upcoming";
  if (d === 0) return "due_today";
  return "missed";
}
