// Versioning, checksums and upload checks (c84). Pure apart from hashing.
//
// Rule: every upload is a NEW `documents` row; bytes are never overwritten.
// A new version of an existing file gets version = latest + 1 in the same
// version group (versionGroupId = id of version 1). Uploading bytes that are
// identical to the current version creates nothing (no silent duplicate).

import { createHash, timingSafeEqual } from "node:crypto";

/** Hex SHA-256 of some bytes. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function isSha256Hex(v: unknown): v is string {
  return typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
}

/** Constant-time comparison of two hex digests. */
export function checksumsMatch(a: string, b: string): boolean {
  if (!isSha256Hex(a) || !isSha256Hex(b)) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

// ---------------------------------------------------------------------------
// MIME detection from magic bytes
// ---------------------------------------------------------------------------

const ZIP_OFFICE: Record<string, string> = {
  "word/": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "xl/": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "ppt/": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

function startsWith(bytes: Uint8Array, sig: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + sig.length) return false;
  return sig.every((b, i) => bytes[offset + i] === b);
}

function asciiAt(bytes: Uint8Array, offset: number, len: number): string {
  return Buffer.from(bytes.subarray(offset, offset + len)).toString("latin1");
}

/** True when the bytes look like text (UTF-8, no NULs, few control chars). */
export function looksLikeText(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, 8192);
  if (sample.length === 0) return true;
  let control = 0;
  for (const b of sample) {
    if (b === 0) return false;
    if (b < 9 || (b > 13 && b < 32)) control++;
  }
  if (control / sample.length > 0.02) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample.subarray(0, Math.max(0, sample.length - 4)));
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect a file's real type from its first bytes. Returns null when unknown.
 * The declared (browser-supplied) type is only a hint: a file claiming to be
 * a PDF that is really an executable must not be accepted as a PDF.
 */
export function sniffMimeType(bytes: Uint8Array, declared?: string | null, filename?: string | null): string | null {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf"; // %PDF-
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])) return "image/tiff";
  if (asciiAt(bytes, 4, 4) === "ftyp" && /^(heic|heix|mif1|msf1|hevc)$/.test(asciiAt(bytes, 8, 4))) return "image/heic";
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif";
  if (startsWith(bytes, [0x4d, 0x5a])) return "application/x-msdownload"; // MZ: Windows executable
  if (startsWith(bytes, [0x7f, 0x45, 0x4c, 0x46])) return "application/x-executable"; // ELF
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    // OLE2 compound file: legacy Word/Excel/Outlook. Trust a matching declared type.
    if (declared && /^application\/(msword|vnd\.ms-excel|vnd\.ms-outlook)$/.test(declared)) return declared;
    return "application/x-ole-storage";
  }
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    const head = Buffer.from(bytes.subarray(0, Math.min(bytes.length, 64 * 1024))).toString("latin1");
    for (const [prefix, mime] of Object.entries(ZIP_OFFICE)) if (head.includes(prefix)) return mime;
    return "application/zip";
  }
  if (startsWith(bytes, [0x7b, 0x5c, 0x72, 0x74, 0x66])) return "application/rtf"; // {\rtf
  if (looksLikeText(bytes)) {
    const lowerName = (filename ?? "").toLowerCase();
    const text = Buffer.from(bytes.subarray(0, 2048)).toString("utf8").trimStart().toLowerCase();
    if (text.startsWith("<!doctype html") || text.startsWith("<html")) return "text/html";
    if (declared === "message/rfc822" || lowerName.endsWith(".eml")) return "message/rfc822";
    if (declared === "text/csv" || lowerName.endsWith(".csv")) return "text/csv";
    if (declared === "text/markdown" || lowerName.endsWith(".md")) return "text/markdown";
    return "text/plain";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Filenames
// ---------------------------------------------------------------------------

/**
 * Make a user-supplied filename safe to store and show: strip any path,
 * control characters and reserved characters, collapse whitespace, cap the
 * length (keeping the extension). Never used in a storage key.
 */
export function sanitizeFilename(raw: string | null | undefined): string {
  const base = (raw ?? "").split(/[/\\]/).pop() ?? "";
  let name = base.normalize("NFKC").replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "").replace(/\s+/g, " ").trim();
  name = name.replace(/^\.+/, "");
  if (!name) return "Untitled";
  if (name.length > 180) {
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 && name.length - dot <= 10 ? name.slice(dot) : "";
    name = name.slice(0, 180 - ext.length) + ext;
  }
  return name;
}

// ---------------------------------------------------------------------------
// Upload checks
// ---------------------------------------------------------------------------

export interface UploadCandidate {
  bytes: Uint8Array;
  filename: string | null;
  declaredMimeType: string | null;
  /** Optional checksum the uploader computed; verified when given. */
  expectedSha256?: string | null;
}

export interface UploadPolicy {
  maxUploadBytes: number;
  allowedMimeTypes: readonly string[];
}

export type UploadCheck =
  | { ok: true; sha256: string; sizeBytes: number; detectedMimeType: string; filename: string; mismatchWarning: string | null }
  | { ok: false; code: "empty" | "too_large" | "checksum_mismatch" | "type_not_allowed" | "unknown_type"; message: string };

/** Validate an upload against the firm's policy. Pure apart from hashing. */
export function checkUpload(c: UploadCandidate, policy: UploadPolicy): UploadCheck {
  if (c.bytes.length === 0) return { ok: false, code: "empty", message: "The file is empty." };
  if (c.bytes.length > policy.maxUploadBytes) {
    return {
      ok: false,
      code: "too_large",
      message: `The file is larger than the firm's limit of ${Math.floor(policy.maxUploadBytes / (1024 * 1024))} MB.`,
    };
  }
  const sha256 = sha256Hex(c.bytes);
  if (c.expectedSha256 && !checksumsMatch(sha256, c.expectedSha256.toLowerCase())) {
    return { ok: false, code: "checksum_mismatch", message: "The file arrived damaged (checksum mismatch). Please upload it again." };
  }
  const declared = c.declaredMimeType?.split(";")[0]?.trim().toLowerCase() || null;
  const detected = sniffMimeType(c.bytes, declared, c.filename);
  if (!detected) return { ok: false, code: "unknown_type", message: "This file type is not recognised." };
  if (!policy.allowedMimeTypes.includes(detected)) {
    return { ok: false, code: "type_not_allowed", message: `Files of type ${detected} are not accepted.` };
  }
  const mismatchWarning =
    declared && declared !== "application/octet-stream" && declared !== detected
      ? `Declared type ${declared} does not match the file's contents (${detected}); stored as ${detected}.`
      : null;
  return { ok: true, sha256, sizeBytes: c.bytes.length, detectedMimeType: detected, filename: sanitizeFilename(c.filename), mismatchWarning };
}

// ---------------------------------------------------------------------------
// Version planning and storage keys
// ---------------------------------------------------------------------------

export interface GroupState {
  groupDocumentId: string;
  latestVersion: number;
  currentSha256: string | null;
  currentStatus: string;
}

export type VersionPlan =
  | { kind: "new_group"; version: 1 }
  | { kind: "new_version"; version: number; supersedePrevious: boolean }
  | { kind: "identical_to_current" };

/**
 * Decide what an upload becomes. Pure.
 * - No group: version 1 of a new file.
 * - Same bytes as the current version: nothing new (caller returns the current version).
 * - Otherwise: latest + 1. The previous current version is marked 'superseded'
 *   unless it was 'filed' (a filed version stays a historical fact) or is already superseded/archived.
 */
export function planVersion(group: GroupState | null, sha256: string): VersionPlan {
  if (!group) return { kind: "new_group", version: 1 };
  if (group.currentSha256 && checksumsMatch(group.currentSha256, sha256)) return { kind: "identical_to_current" };
  return {
    kind: "new_version",
    version: group.latestVersion + 1,
    supersedePrevious: !["filed", "superseded", "archived"].includes(group.currentStatus),
  };
}

/**
 * Object key for a version's bytes. Contains only opaque ids — never the
 * filename or anything about the client — so storage listings and vendor
 * logs leak nothing.
 */
export function storageKeyFor(input: { tenantId: string; matterId: string; groupId: string; version: number; objectId: string }): string {
  const id = /^[0-9a-f-]{36}$/i;
  for (const [k, v] of Object.entries({ tenantId: input.tenantId, matterId: input.matterId, groupId: input.groupId, objectId: input.objectId })) {
    if (!id.test(v)) throw new Error(`storageKeyFor: ${k} must be a uuid.`);
  }
  if (!Number.isInteger(input.version) || input.version < 1) throw new Error("storageKeyFor: version must be a positive integer.");
  return `t/${input.tenantId}/m/${input.matterId}/g/${input.groupId}/v${input.version}-${input.objectId}`;
}

/** Default title for a new file: the filename without its extension. */
export function titleFromFilename(filename: string): string {
  const dot = filename.lastIndexOf(".");
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  return stem.trim() || "Untitled";
}
