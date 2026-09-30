// Small shared pieces of the Document engine: the engine slug, a typed error
// that routes turn into HTTP responses, business-day arithmetic, hashing and
// firm settings (engineSettings["document"]) with defaults.

import { createHash } from "node:crypto";
import { engineSetting, fromLocal, toLocal, type BusinessCalendar, type FirmSettings } from "@/core";
import type { Weekday } from "@/db/types";

export const ENGINE = "document";

/** A handled failure with an HTTP status (4xx). Routes return it inside the transaction. */
export class DocumentError extends Error {
  constructor(
    message: string,
    readonly status: number = 422,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "DocumentError";
  }
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function requireReason(reason: string | null | undefined, what: string): string {
  const r = (reason ?? "").trim();
  if (!r) throw new DocumentError(`A reason is required to ${what}.`, 422);
  return r;
}

// ---------------------------------------------------------------------------
// Business days (firm calendar). Pure.
// ---------------------------------------------------------------------------

const WEEKDAYS: readonly Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

interface Civil {
  y: number;
  m: number;
  d: number;
}

function civilOf(at: Date, timeZone: string): Civil {
  const l = toLocal(at, timeZone);
  return { y: l.year, m: l.month, d: l.day };
}

function nextCivil(c: Civil): Civil {
  const t = new Date(Date.UTC(c.y, c.m - 1, c.d + 1));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

function civilString(c: Civil): string {
  return `${String(c.y).padStart(4, "0")}-${String(c.m).padStart(2, "0")}-${String(c.d).padStart(2, "0")}`;
}

function isBusinessDay(c: Civil, cal: BusinessCalendar): boolean {
  const weekday = WEEKDAYS[new Date(Date.UTC(c.y, c.m - 1, c.d)).getUTCDay()] as Weekday;
  if ((cal.weekly[weekday] ?? []).length === 0) return false;
  const key = civilString(c);
  return !cal.holidays.some((h) => (typeof h === "string" ? h : h.date) === key);
}

function instantAt(c: Civil, hhmm: string, timeZone: string): Date {
  const [hh, mm] = hhmm.split(":").map(Number) as [number, number];
  return fromLocal(c.y, c.m, c.d, hh, mm, timeZone);
}

/**
 * The end of the firm's business day that is `days` business days after
 * `start`'s local date (the start date itself does not count). E.g. 10
 * business days from Friday → close of business on the second Friday after.
 */
export function addBusinessDays(start: Date, days: number, cal: BusinessCalendar): Date {
  if (!Number.isFinite(days) || days < 1) throw new Error("addBusinessDays: days must be >= 1.");
  let c = civilOf(start, cal.timeZone);
  let counted = 0;
  for (let i = 0; i < 366 * 5; i++) {
    c = nextCivil(c);
    if (isBusinessDay(c, cal)) counted++;
    if (counted === Math.floor(days)) {
      const weekday = WEEKDAYS[new Date(Date.UTC(c.y, c.m - 1, c.d)).getUTCDay()] as Weekday;
      const intervals = cal.weekly[weekday] ?? [];
      const end = intervals.reduce((max, iv) => (iv.end > max ? iv.end : max), "00:00");
      return end === "24:00" ? instantAt(nextCivil(c), "00:00", cal.timeZone) : instantAt(c, end, cal.timeZone);
    }
  }
  throw new Error("addBusinessDays: the firm calendar has no business days.");
}

/** `years` calendar years after `at` (Feb 29 → Feb 28). Real clock (c90 rule 11). */
export function addYears(at: Date, years: number): Date {
  const d = new Date(at.getTime());
  const month = d.getUTCMonth();
  d.setUTCFullYear(d.getUTCFullYear() + years);
  if (d.getUTCMonth() !== month) d.setUTCDate(0);
  return d;
}

// ---------------------------------------------------------------------------
// Firm settings for this engine (engineSettings.document). None of these are
// legal rules; they are the firm's own operating choices with spec defaults.
// ---------------------------------------------------------------------------

export interface DocumentSettings {
  /** c84: folder template per practice area ('default' when none matches). */
  folderTemplates: Record<string, string[]>;
  /** c49 rule 9: what a client may upload. */
  clientUploadMimeTypes: string[];
  /** Staff uploads additionally allow these. */
  staffUploadMimeTypes: string[];
  maxUploadBytes: number;
  /** c4 rule 6. */
  envelopeExpiryBusinessDays: number;
  /** c39 rule 5. */
  signingOrder: "client_first" | "lawyer_first";
  /** c4 rule 8. */
  identityMethod: "portal_login" | "one_time_code";
  envelopeMaxSendAttempts: number;
  /** c39 rule 7 (business hours; 8 = one business day). */
  countersignDueBusinessHours: number;
  /** c40 rules 4–6. */
  deliveryFirstAskBusinessHours: number;
  deliveryReaskBusinessHours: number;
  deliveryAskCap: number;
  notNeededNeedsAttorney: boolean;
  staffSentNeedsConfirmation: boolean;
  onboardingSets: Record<string, string[]>;
  /** c41 rules 4, 6, 7, 9. */
  signoffRequiredDocumentTypes: string[];
  /** c41 rule 5: types the client signs as a party (e-signature); others use a recorded approval. */
  signoffESignatureDocumentTypes: string[];
  signoffResponseBusinessDays: number;
  deadlineAlertHours: number;
  allowFileWithoutSignoff: boolean;
  /** c49 rules 6–8. */
  checklistAcceptRoles: string[];
  checklistAutoRequest: boolean;
  clientItemDueBusinessDays: number;
  /** c87 rules 2, 7. */
  emailSuggestionWindowDays: number;
  emailStartsReplyClock: boolean;
  /** c90 rule 4: per practice area, NO product default (the firm must set it). */
  retentionYearsByPracticeArea: Record<string, number>;
  /** c86: follow-up to record service after acceptance (a firm reminder, not a legal deadline). */
  serviceFollowUpBusinessHours: number;
  efilingMaxAttempts: number;
}

export const DEFAULT_DOCUMENT_SETTINGS: Readonly<DocumentSettings> = Object.freeze({
  folderTemplates: {
    default: ["Correspondence", "Pleadings", "Discovery", "Client uploads", "Email", "Signed", "Court", "Closing"],
  },
  clientUploadMimeTypes: [
    "application/pdf",
    "image/jpeg",
    "image/png",
    "image/heic",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ],
  staffUploadMimeTypes: ["text/plain", "message/rfc822", "application/json", "text/markdown"],
  maxUploadBytes: 50 * 1024 * 1024,
  envelopeExpiryBusinessDays: 10,
  signingOrder: "client_first",
  identityMethod: "portal_login",
  envelopeMaxSendAttempts: 3,
  countersignDueBusinessHours: 8,
  deliveryFirstAskBusinessHours: 8,
  deliveryReaskBusinessHours: 16,
  deliveryAskCap: 3,
  notNeededNeedsAttorney: true,
  staffSentNeedsConfirmation: false,
  onboardingSets: { default: ["Copy of signed engagement agreement", "Welcome letter", "Client portal instructions"] },
  signoffRequiredDocumentTypes: ["petition", "pleading", "answer", "motion", "affidavit", "inventory", "decree", "order"],
  signoffESignatureDocumentTypes: ["affidavit", "inventory", "declaration", "verification"],
  signoffResponseBusinessDays: 3,
  deadlineAlertHours: 72,
  allowFileWithoutSignoff: true,
  checklistAcceptRoles: ["attorney"],
  checklistAutoRequest: false,
  clientItemDueBusinessDays: 5,
  emailSuggestionWindowDays: 7,
  emailStartsReplyClock: true,
  retentionYearsByPracticeArea: {},
  serviceFollowUpBusinessHours: 16,
  efilingMaxAttempts: 3,
});

type Keys = keyof DocumentSettings;

function pick<K extends Keys>(fs: Pick<FirmSettings, "engineSettings">, key: K, ok: (v: unknown) => boolean): DocumentSettings[K] {
  const v = engineSetting<unknown>(fs, ENGINE, key, undefined);
  return (v !== undefined && ok(v) ? v : DEFAULT_DOCUMENT_SETTINGS[key]) as DocumentSettings[K];
}

const isPosNum = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v > 0;
const isBool = (v: unknown) => typeof v === "boolean";
const isStrArr = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string");
const isRecordOf = (inner: (v: unknown) => boolean) => (v: unknown) =>
  !!v && typeof v === "object" && !Array.isArray(v) && Object.values(v as Record<string, unknown>).every(inner);

/** Pure: the engine's settings with defaults for anything unset or malformed. */
export function readDocumentSettings(fs: Pick<FirmSettings, "engineSettings">): DocumentSettings {
  return {
    folderTemplates: pick(fs, "folderTemplates", isRecordOf(isStrArr)),
    clientUploadMimeTypes: pick(fs, "clientUploadMimeTypes", isStrArr),
    staffUploadMimeTypes: pick(fs, "staffUploadMimeTypes", isStrArr),
    maxUploadBytes: pick(fs, "maxUploadBytes", isPosNum),
    envelopeExpiryBusinessDays: pick(fs, "envelopeExpiryBusinessDays", isPosNum),
    signingOrder: pick(fs, "signingOrder", (v) => v === "client_first" || v === "lawyer_first"),
    identityMethod: pick(fs, "identityMethod", (v) => v === "portal_login" || v === "one_time_code"),
    envelopeMaxSendAttempts: pick(fs, "envelopeMaxSendAttempts", isPosNum),
    countersignDueBusinessHours: pick(fs, "countersignDueBusinessHours", isPosNum),
    deliveryFirstAskBusinessHours: pick(fs, "deliveryFirstAskBusinessHours", isPosNum),
    deliveryReaskBusinessHours: pick(fs, "deliveryReaskBusinessHours", isPosNum),
    deliveryAskCap: pick(fs, "deliveryAskCap", isPosNum),
    notNeededNeedsAttorney: pick(fs, "notNeededNeedsAttorney", isBool),
    staffSentNeedsConfirmation: pick(fs, "staffSentNeedsConfirmation", isBool),
    onboardingSets: pick(fs, "onboardingSets", isRecordOf(isStrArr)),
    signoffRequiredDocumentTypes: pick(fs, "signoffRequiredDocumentTypes", isStrArr),
    signoffESignatureDocumentTypes: pick(fs, "signoffESignatureDocumentTypes", isStrArr),
    signoffResponseBusinessDays: pick(fs, "signoffResponseBusinessDays", isPosNum),
    deadlineAlertHours: pick(fs, "deadlineAlertHours", isPosNum),
    allowFileWithoutSignoff: pick(fs, "allowFileWithoutSignoff", isBool),
    checklistAcceptRoles: pick(fs, "checklistAcceptRoles", isStrArr),
    checklistAutoRequest: pick(fs, "checklistAutoRequest", isBool),
    clientItemDueBusinessDays: pick(fs, "clientItemDueBusinessDays", isPosNum),
    emailSuggestionWindowDays: pick(fs, "emailSuggestionWindowDays", isPosNum),
    emailStartsReplyClock: pick(fs, "emailStartsReplyClock", isBool),
    retentionYearsByPracticeArea: pick(fs, "retentionYearsByPracticeArea", isRecordOf(isPosNum)),
    serviceFollowUpBusinessHours: pick(fs, "serviceFollowUpBusinessHours", isPosNum),
    efilingMaxAttempts: pick(fs, "efilingMaxAttempts", isPosNum),
  };
}

/** The value for a practice area, else the 'default' entry. */
export function forPracticeArea<T>(map: Record<string, T>, practiceArea: string | null | undefined): T | undefined {
  return (practiceArea ? map[practiceArea] : undefined) ?? map.default;
}
