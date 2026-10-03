// Gated rule config and firm settings for the trust ledger. Pure.
//
// Rule VALUES (retention, cadence, tolerance) come from the approved text of
// 'rules.billing-trust.rule_values' — or, while it is pending, from its draft,
// marked `approved: false` so every screen shows them as PROPOSED. Nothing in
// the ledger depends on these values to stay safe: entries are never deleted
// whatever the retention value, and reconciliation tolerance is clamped to
// zero (a variance is never accepted).
//
// Founder/firm numbers (when a reconciliation is due, matching windows, who
// signs off) are firm settings in engineSettings['billing-trust'], not gates.

import { gateStatus } from "@/compliance/approvals";
import { engineSetting } from "@/core/firmSettings";
import type { FirmSettingsValues } from "@/core/firmSettings";
import { TRUST_RULE_GATES, TRUST_RULE_VALUES_DRAFT } from "./gates";
import { ENGINE, isSignoffRole, type SignoffRole } from "./types";

export interface TrustRuleValues {
  retentionYearsAfterRepresentationEnds: number;
  reconciliationCadence: "monthly";
  reconciliationToleranceCents: 0;
}

export interface GatedRuleValues {
  values: TrustRuleValues;
  approved: boolean;
  pendingReviewers: string[];
  gateKey: string;
}

/** Parse rule values; anything unparseable or unsafe falls back to the (stricter) draft values. */
export function parseRuleValues(text: string | null | undefined): TrustRuleValues {
  const fallback = JSON.parse(TRUST_RULE_VALUES_DRAFT) as TrustRuleValues;
  if (!text) return fallback;
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    const years = raw.retentionYearsAfterRepresentationEnds;
    return {
      retentionYearsAfterRepresentationEnds:
        typeof years === "number" && Number.isInteger(years) && years >= 1 && years <= 100 ? years : fallback.retentionYearsAfterRepresentationEnds,
      reconciliationCadence: "monthly",
      // Zero tolerance is not configurable downward or upward in this product.
      reconciliationToleranceCents: 0,
    };
  } catch {
    return fallback;
  }
}

export function trustRuleValues(): GatedRuleValues {
  const status = gateStatus(TRUST_RULE_GATES.ruleValues.key);
  return {
    values: parseRuleValues(status.approved ? status.approvedText : TRUST_RULE_VALUES_DRAFT),
    approved: status.approved,
    pendingReviewers: status.pendingReviewers,
    gateKey: status.gate.key,
  };
}

/** Retention end date for trust records of a matter: never shorter than the rule value, firms may set longer. */
export function trustRecordsRetainUntil(
  representationEndedOn: string | null,
  ruleYears: number,
  firmYears: number | null
): string | null {
  if (!representationEndedOn) return null; // the clock starts at the closing event (c75 §5)
  const years = Math.max(ruleYears, firmYears ?? 0);
  const [y, m, d] = representationEndedOn.slice(0, 10).split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y + years, m - 1, d)).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Firm settings (engineSettings['billing-trust'])
// ---------------------------------------------------------------------------

export interface TrustSettings {
  /** A month's reconciliation is overdue this many days after month end. */
  reconciliationDueDays: number;
  /** Deposits may appear on the bank statement up to this many days after the book date. */
  depositToleranceDays: number;
  /** Checks / withdrawals may clear up to this many days after the book date. */
  withdrawalClearDays: number;
  /** Outstanding items older than this are called out on the worksheet. */
  staleOutstandingDays: number;
  /** Sign-offs required to close a month. */
  signoffRoles: SignoffRole[];
  /** Firms may keep trust records longer than the rule value (never shorter). */
  retentionYears: number | null;
}

export const DEFAULT_TRUST_SETTINGS: Readonly<TrustSettings> = Object.freeze<TrustSettings>({
  reconciliationDueDays: 15,
  depositToleranceDays: 5,
  withdrawalClearDays: 180,
  staleOutstandingDays: 90,
  signoffRoles: ["bookkeeper", "lawyer"],
  retentionYears: null,
});

function intSetting(s: Pick<FirmSettingsValues, "engineSettings">, key: keyof TrustSettings, min: number, max: number): number {
  const fallback = DEFAULT_TRUST_SETTINGS[key] as number;
  const v = engineSetting<unknown>(s, ENGINE, key, fallback);
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : fallback;
}

export function readTrustSettings(s: Pick<FirmSettingsValues, "engineSettings">): TrustSettings {
  const roles = engineSetting<unknown>(s, ENGINE, "signoffRoles", DEFAULT_TRUST_SETTINGS.signoffRoles);
  const cleanRoles = Array.isArray(roles) ? [...new Set(roles.filter(isSignoffRole))] : [];
  const retention = engineSetting<unknown>(s, ENGINE, "retentionYears", null);
  return {
    reconciliationDueDays: intSetting(s, "reconciliationDueDays", 1, 60),
    depositToleranceDays: intSetting(s, "depositToleranceDays", 0, 30),
    withdrawalClearDays: intSetting(s, "withdrawalClearDays", 1, 730),
    staleOutstandingDays: intSetting(s, "staleOutstandingDays", 1, 730),
    // At least one sign-off is always required; an empty/invalid list falls back to the default pair.
    signoffRoles: cleanRoles.length > 0 ? cleanRoles : [...DEFAULT_TRUST_SETTINGS.signoffRoles],
    retentionYears: typeof retention === "number" && Number.isInteger(retention) && retention > 0 && retention <= 100 ? retention : null,
  };
}
