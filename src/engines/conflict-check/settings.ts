// Firm-configurable settings of the Conflict-check engine, stored in
// firm_settings.engine_settings["conflict-check"]. These are ordinary firm
// settings with the spec defaults (NOT approval gates). Durations are in firm
// BUSINESS hours unless the name says otherwise (founder decision).

import { engineSetting, type FirmSettings } from "@/core";

export const ENGINE = "conflict-check" as const;

export interface ConflictSettings {
  /** c59 rule 7: decision due for an intake check (default 1 business day = 8 business hours). */
  decisionDueBusinessHoursIntake: number;
  /** c59 rule 7: decision due for a re-check on an open matter (default 2 business days). */
  decisionDueBusinessHoursMatter: number;
  /** c59 rule 8: waiver signer due time (default 5 business days). */
  waiverDueBusinessHours: number;
  /** c59 rule 8: outer limit before the waiver returns to the conflicts attorney (default 15 business days). */
  waiverOuterLimitBusinessHours: number;
  /** Business hours between waiver reminders (default 1 business day). */
  waiverReminderBusinessHours: number;
  /** c59 rule 9: firm countersignature on waivers (default on). */
  waiverCountersignRequired: boolean;
  /** c59 §4.7: e-signature send failing → internal flag after this many business hours. */
  esignFailureFlagBusinessHours: number;
  /** c56 §7: merge queue items older than this create a task (default 5 business days). */
  mergeQueueStaleBusinessHours: number;
  /** c56 rule 10: organisation link depth searched up and down (default 1). */
  orgLinkDepth: number;
  /** c56 §4.7: index-write failures before the check becomes 'possible' (default 3). */
  indexWriteRetryLimit: number;
  /** c56 rule 9: set when the firm confirms its history import (c96). Null = history not loaded. */
  historyImportConfirmedAt: string | null;
  /** c56 open question 1: owner/admin sees party details without the conflicts role (default: counts only). */
  ownerSeesPartyDetails: boolean;
  /** c61 rule 4: lateral list due this many business days before the start date (default 5). */
  lateralDueBusinessDaysBeforeStart: number;
  /** c61 §4.2.2: free-text length limit on lateral entries (default 80). */
  lateralEntryMaxChars: number;
  /** c61 rule 3: matter ids a hire may access before the check completes (default none). */
  lateralAccessExceptionMatterIds: string[];
  /** c62 rule 5: letter send window (default 1 business day). */
  letterSendWindowBusinessHours: number;
  /** c62 rule 4: decline types that may auto-send once the template is approved (never 'conflict'). */
  letterAutoSendTypes: string[];
  /** c62 rule 1: did-not-hire-after-consult also gets a letter (default on). */
  letterForDidNotHire: boolean;
  /** c62 rule 6: referral block on/off, and the firm's referral sources. */
  letterIncludeReferral: boolean;
  referralSources: Array<{ name: string; contact: string; practiceArea?: string }>;
  /** c62 §4.4.2: days before declined-inquiry narrative is purged (c2 default 90; gated by rules.retention_periods). */
  declinedNarrativeRetentionDays: number;
  /** c63 rule 6: default export redaction (default 'summary'). */
  defaultExportRedaction: "full" | "summary";
  /** c63 rule 8: export link lifetime in REAL hours (default 24, max 168). */
  exportLinkHours: number;
  /** c97 rule 5: re-confirmation interval in months (default 12). */
  interestReconfirmMonths: number;
}

export const DEFAULT_CONFLICT_SETTINGS: Readonly<ConflictSettings> = Object.freeze({
  decisionDueBusinessHoursIntake: 8,
  decisionDueBusinessHoursMatter: 16,
  waiverDueBusinessHours: 40,
  waiverOuterLimitBusinessHours: 120,
  waiverReminderBusinessHours: 8,
  waiverCountersignRequired: true,
  esignFailureFlagBusinessHours: 1,
  mergeQueueStaleBusinessHours: 40,
  orgLinkDepth: 1,
  indexWriteRetryLimit: 3,
  historyImportConfirmedAt: null,
  ownerSeesPartyDetails: false,
  lateralDueBusinessDaysBeforeStart: 5,
  lateralEntryMaxChars: 80,
  lateralAccessExceptionMatterIds: [],
  letterSendWindowBusinessHours: 8,
  letterAutoSendTypes: [],
  letterForDidNotHire: true,
  letterIncludeReferral: true,
  referralSources: [],
  declinedNarrativeRetentionDays: 90,
  defaultExportRedaction: "summary",
  exportLinkHours: 24,
  interestReconfirmMonths: 12,
});

export const MAX_EXPORT_LINK_HOURS = 168;

/** Read the engine's settings with defaults; clamps values that would be unsafe. Pure. */
export function readConflictSettings(settings: Pick<FirmSettings, "engineSettings">): ConflictSettings {
  const out = {} as Record<string, unknown>;
  for (const [key, fallback] of Object.entries(DEFAULT_CONFLICT_SETTINGS)) {
    out[key] = engineSetting(settings, ENGINE, key, fallback);
  }
  const s = out as unknown as ConflictSettings;
  return {
    ...s,
    orgLinkDepth: clampInt(s.orgLinkDepth, 0, 3, DEFAULT_CONFLICT_SETTINGS.orgLinkDepth),
    exportLinkHours: clampInt(s.exportLinkHours, 1, MAX_EXPORT_LINK_HOURS, DEFAULT_CONFLICT_SETTINGS.exportLinkHours),
    lateralEntryMaxChars: clampInt(s.lateralEntryMaxChars, 20, 200, DEFAULT_CONFLICT_SETTINGS.lateralEntryMaxChars),
    // Conflict declines ALWAYS need individual lawyer approval (c62 rule 4), whatever the firm sets.
    letterAutoSendTypes: (Array.isArray(s.letterAutoSendTypes) ? s.letterAutoSendTypes : []).filter((t) => t !== "conflict"),
    defaultExportRedaction: s.defaultExportRedaction === "full" ? "full" : "summary",
  };
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

type SettingKind = "hours" | "int" | "bool" | "stringList" | "uuidList" | "referrals" | "redaction";

const SETTING_KINDS: Readonly<Record<Exclude<keyof ConflictSettings, "historyImportConfirmedAt">, SettingKind>> = {
  decisionDueBusinessHoursIntake: "hours",
  decisionDueBusinessHoursMatter: "hours",
  waiverDueBusinessHours: "hours",
  waiverOuterLimitBusinessHours: "hours",
  waiverReminderBusinessHours: "hours",
  waiverCountersignRequired: "bool",
  esignFailureFlagBusinessHours: "hours",
  mergeQueueStaleBusinessHours: "hours",
  orgLinkDepth: "int",
  indexWriteRetryLimit: "int",
  ownerSeesPartyDetails: "bool",
  lateralDueBusinessDaysBeforeStart: "int",
  lateralEntryMaxChars: "int",
  lateralAccessExceptionMatterIds: "uuidList",
  letterSendWindowBusinessHours: "hours",
  letterAutoSendTypes: "stringList",
  letterForDidNotHire: "bool",
  letterIncludeReferral: "bool",
  referralSources: "referrals",
  declinedNarrativeRetentionDays: "int",
  defaultExportRedaction: "redaction",
  exportLinkHours: "int",
  interestReconfirmMonths: "int",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AUTO_SEND_TYPES = new Set(["not_eligible", "out_of_scope", "firm_choice", "did_not_hire"]);

/**
 * Validate a firm admin's settings patch. Unknown keys are refused, and
 * `historyImportConfirmedAt` can only be set through confirmHistoryImport()
 * (it changes whether checks may come back clear). Pure.
 */
export function validateConflictSettingsPatch(patch: Record<string, unknown>): { values: Partial<ConflictSettings>; errors: string[] } {
  const values: Record<string, unknown> = {};
  const errors: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const kind = (SETTING_KINDS as Record<string, SettingKind | undefined>)[key];
    if (!kind) {
      errors.push(`Unknown or read-only setting '${key}'.`);
      continue;
    }
    const bad = () => errors.push(`Invalid value for '${key}'.`);
    switch (kind) {
      case "hours":
        if (typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 2000) values[key] = value;
        else bad();
        break;
      case "int":
        if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 10_000) values[key] = value;
        else bad();
        break;
      case "bool":
        if (typeof value === "boolean") values[key] = value;
        else bad();
        break;
      case "stringList":
        if (Array.isArray(value) && value.every((v) => typeof v === "string" && AUTO_SEND_TYPES.has(v))) values[key] = value;
        else errors.push(`'${key}' may only list: ${[...AUTO_SEND_TYPES].join(", ")} (never 'conflict').`);
        break;
      case "uuidList":
        if (Array.isArray(value) && value.every((v) => typeof v === "string" && UUID.test(v))) values[key] = value;
        else bad();
        break;
      case "referrals":
        if (
          Array.isArray(value) &&
          value.every(
            (r) =>
              r &&
              typeof r === "object" &&
              typeof (r as { name?: unknown }).name === "string" &&
              typeof (r as { contact?: unknown }).contact === "string" &&
              ((r as { practiceArea?: unknown }).practiceArea === undefined || typeof (r as { practiceArea?: unknown }).practiceArea === "string")
          )
        ) {
          values[key] = value;
        } else bad();
        break;
      case "redaction":
        if (value === "full" || value === "summary") values[key] = value;
        else bad();
        break;
    }
  }
  return { values: values as Partial<ConflictSettings>, errors };
}
