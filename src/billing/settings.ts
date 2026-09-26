// Firm-configurable billing settings and their defaults. At runtime these are
// read from `firm_config_versions.config.billing` (existing table) and merged
// over the defaults below, so every decision can be traced to the config
// version in force.

import type { Cents } from "./money";

export type RoundingMode = "up" | "nearest";

export interface BillingSettings {
  /** c50: minimum trust balance for retainer matters. Founder default $4,500. */
  retainerFloorCents: Cents;
  /** c50: optional early warning threshold; null = off. Proposed default $6,000. */
  retainerEarlyWarningCents: Cents | null;
  /** c77: billing increment in minutes. Default 6 (0.1 hour). */
  timeIncrementMinutes: number;
  /** c77: how durations are rounded to the increment. PLACEHOLDER default pending Clayton/attorney decision. */
  timeRounding: RoundingMode;
  /** c79: days from invoice issue to due date. Proposed default 15. */
  invoiceNetDays: number;
  /** c79: invoice number format; {YYYY} and {SEQ} are replaced. */
  invoiceNumberFormat: string;
  /** c79: zero-pad width for {SEQ}. */
  invoiceNumberPad: number;
  /** c52: days before each installment a reminder goes out. */
  installmentReminderDaysBefore: number[];
  /**
   * c81: reminder sequence as day offsets from the invoice due date
   * (negative = before due). Sent on the next firm business day.
   */
  invoiceReminderOffsetsDays: number[];
  /**
   * c78: markup on billable costs in basis points (100 bp = 1%).
   * PLACEHOLDER: stays 0 until gate "cost_markup_disclosure_c78" is approved
   * AND the matter's engagement agreement allows a markup.
   */
  costMarkupBasisPoints: number;
  /** c78: mileage rate in cents per mile. PLACEHOLDER: firm must set; no product default. */
  mileageRateCentsPerMile: Cents | null;
}

export const DEFAULT_BILLING_SETTINGS: BillingSettings = {
  retainerFloorCents: 450_000,
  retainerEarlyWarningCents: 600_000,
  timeIncrementMinutes: 6,
  timeRounding: "up",
  invoiceNetDays: 15,
  invoiceNumberFormat: "INV-{YYYY}-{SEQ}",
  invoiceNumberPad: 5,
  installmentReminderDaysBefore: [7, 1],
  invoiceReminderOffsetsDays: [-3, 7, 21, 45],
  costMarkupBasisPoints: 0,
  mileageRateCentsPerMile: null,
};

export function resolveBillingSettings(overrides: Partial<BillingSettings> | undefined): BillingSettings {
  const s = { ...DEFAULT_BILLING_SETTINGS, ...(overrides ?? {}) };
  if (s.retainerFloorCents < 0) throw new Error("retainerFloorCents must be >= 0");
  if (s.retainerEarlyWarningCents !== null && s.retainerEarlyWarningCents <= s.retainerFloorCents) {
    throw new Error("retainerEarlyWarningCents must be above the floor (or null to disable)");
  }
  if (!Number.isInteger(s.timeIncrementMinutes) || s.timeIncrementMinutes < 1 || s.timeIncrementMinutes > 60) {
    throw new Error("timeIncrementMinutes must be an integer between 1 and 60");
  }
  if (s.invoiceNetDays < 0) throw new Error("invoiceNetDays must be >= 0");
  return s;
}
