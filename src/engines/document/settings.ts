// Document engine firm settings — ordinary, firm-editable numbers and lists
// (founder rule: settings, not approval gates). Stored in
// firm_settings.engine_settings.document and merged over these defaults.
// Retention PERIODS are not here: they are legal/policy rules kept in
// document_retention_rules and applied only through rules.retention_periods.

import { engineSetting, type FirmSettings } from "@/core/firmSettings";
import { isPrivilegeTag, type PrivilegeTag } from "@/core/documents";

export const ENGINE = "document" as const;

export interface DocumentSettings {
  /** Largest single upload, in bytes. */
  maxUploadBytes: number;
  /** MIME types accepted for upload. Detected type must be on this list. */
  allowedMimeTypes: string[];
  /** Characters of extracted text kept for search (tsvector is capped at 1 MB). */
  maxIndexedChars: number;
  /** Privilege tags only these roles may open (default: sealed → attorney and firm admin). */
  restrictedTags: Partial<Record<PrivilegeTag, string[]>>;
  /** Search results per page. */
  searchPageSize: number;
  /** Characters around a hit in a search snippet. */
  snippetChars: number;
  /** Max matters per worker tick that get their folders provisioned. */
  provisionBatchSize: number;
  /** Max versions per worker tick whose text is extracted. */
  extractionBatchSize: number;
  /** Give up extracting a version after this many failed attempts. */
  extractionMaxAttempts: number;
  /**
   * Whether staff may download a file no approved scanner has checked
   * ('not_scanned'). Infected / pending files are never served. Clients never
   * get unscanned files whatever this says.
   */
  staffMayDownloadUnscanned: boolean;
}

export const DEFAULT_DOCUMENT_SETTINGS: Readonly<DocumentSettings> = Object.freeze({
  maxUploadBytes: 50 * 1024 * 1024,
  allowedMimeTypes: [
    "application/pdf",
    "image/jpeg",
    "image/png",
    "image/tiff",
    "image/heic",
    "text/plain",
    "text/csv",
    "text/markdown",
    "text/html",
    "application/rtf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "message/rfc822",
  ],
  maxIndexedChars: 400_000,
  restrictedTags: { sealed: ["attorney", "firm_admin"] },
  searchPageSize: 25,
  snippetChars: 160,
  provisionBatchSize: 50,
  extractionBatchSize: 20,
  extractionMaxAttempts: 3,
  staffMayDownloadUnscanned: true,
});

function num(v: unknown, fallback: number, min: number, max: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? Math.floor(v) : fallback;
}

/** Pure: read and sanitise the engine's settings bag. Invalid values fall back to defaults. */
export function readDocumentSettings(settings: Pick<FirmSettings, "engineSettings">): DocumentSettings {
  const d = DEFAULT_DOCUMENT_SETTINGS;
  const get = <T>(key: keyof DocumentSettings, fallback: T): T => engineSetting<T>(settings, ENGINE, key, fallback);

  const mimes = get<unknown>("allowedMimeTypes", d.allowedMimeTypes);
  const allowedMimeTypes =
    Array.isArray(mimes) && mimes.length > 0 && mimes.every((m) => typeof m === "string" && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(m))
      ? (mimes as string[]).map((m) => m.toLowerCase())
      : [...d.allowedMimeTypes];

  const tagsRaw = get<unknown>("restrictedTags", d.restrictedTags);
  const restrictedTags: Partial<Record<PrivilegeTag, string[]>> = {};
  if (tagsRaw && typeof tagsRaw === "object" && !Array.isArray(tagsRaw)) {
    for (const [tag, roles] of Object.entries(tagsRaw as Record<string, unknown>)) {
      if (isPrivilegeTag(tag) && Array.isArray(roles) && roles.every((r) => typeof r === "string")) {
        restrictedTags[tag] = roles as string[];
      }
    }
  } else {
    Object.assign(restrictedTags, d.restrictedTags);
  }

  const unscanned = get<unknown>("staffMayDownloadUnscanned", d.staffMayDownloadUnscanned);

  return {
    maxUploadBytes: num(get("maxUploadBytes", d.maxUploadBytes), d.maxUploadBytes, 1, 2 * 1024 * 1024 * 1024),
    allowedMimeTypes,
    maxIndexedChars: num(get("maxIndexedChars", d.maxIndexedChars), d.maxIndexedChars, 1_000, 900_000),
    restrictedTags,
    searchPageSize: num(get("searchPageSize", d.searchPageSize), d.searchPageSize, 1, 100),
    snippetChars: num(get("snippetChars", d.snippetChars), d.snippetChars, 40, 1_000),
    provisionBatchSize: num(get("provisionBatchSize", d.provisionBatchSize), d.provisionBatchSize, 1, 1_000),
    extractionBatchSize: num(get("extractionBatchSize", d.extractionBatchSize), d.extractionBatchSize, 1, 500),
    extractionMaxAttempts: num(get("extractionMaxAttempts", d.extractionMaxAttempts), d.extractionMaxAttempts, 1, 20),
    staffMayDownloadUnscanned: typeof unscanned === "boolean" ? unscanned : d.staffMayDownloadUnscanned,
  };
}
