// c96 — importing the firm's existing client and matter history (CSV first).
// Pure: parsing, column mapping, validation, in-file de-duplication and the
// report. No database imports (see importService.ts for the writes).
//
// Without history the party index starts empty and every check would wrongly
// come back clear, so until the firm confirms its import no check can be
// clear (settings.historyImportConfirmedAt, c56 rule 9).

import { normalizeName } from "@/core";
import type { IndexRole, NameType } from "./types";

export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 20_000;

// ---------------------------------------------------------------------------
// CSV (RFC 4180: quoted fields, doubled quotes, CR/LF/CRLF, optional BOM)
// ---------------------------------------------------------------------------

/** Parse CSV text into rows of fields. Blank lines are dropped. Pure. */
export function parseCsv(text: string, delimiter = ","): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  const pushRow = () => {
    row.push(field);
    if (!(row.length === 1 && row[0]!.trim() === "")) rows.push(row);
    row = [];
    field = "";
  };
  while (i < src.length) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === "") {
      quoted = true;
      i++;
    } else if (ch === delimiter) {
      row.push(field);
      field = "";
      i++;
    } else if (ch === "\r" || ch === "\n") {
      pushRow();
      i += ch === "\r" && src[i + 1] === "\n" ? 2 : 1;
    } else {
      field += ch;
      i++;
    }
  }
  if (field !== "" || row.length > 0) pushRow();
  return rows;
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

export const IMPORT_FIELDS = [
  "record_type",
  "name",
  "kind",
  "aliases",
  "maiden_name",
  "former_names",
  "business_names",
  "date_of_birth",
  "email",
  "phone",
  "address",
  "matter_ref",
  "matter_title",
  "matter_status",
  "practice_area",
  "opened_on",
  "closed_on",
  "relationship",
  "adverse",
] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];

/** Header spellings seen in practice-management exports and spreadsheets. */
const HEADER_SYNONYMS: Readonly<Record<string, ImportField>> = {
  record_type: "record_type", type: "record_type", role: "record_type", party_role: "record_type", party_type: "record_type", contact_type: "record_type",
  name: "name", full_name: "name", party_name: "name", client_name: "name", contact_name: "name", display_name: "name",
  kind: "kind", entity_type: "kind", person_or_organization: "kind",
  aliases: "aliases", alias: "aliases", aka: "aliases", also_known_as: "aliases", nicknames: "aliases",
  maiden_name: "maiden_name", maiden: "maiden_name", birth_name: "maiden_name",
  former_names: "former_names", former_name: "former_names", previous_names: "former_names", prior_names: "former_names",
  business_names: "business_names", dba: "business_names", trade_name: "business_names", company_names: "business_names",
  date_of_birth: "date_of_birth", dob: "date_of_birth", birth_date: "date_of_birth", birthdate: "date_of_birth",
  email: "email", email_address: "email", e_mail: "email",
  phone: "phone", phone_number: "phone", telephone: "phone", mobile: "phone", cell: "phone",
  address: "address", street_address: "address", mailing_address: "address", home_address: "address",
  matter_ref: "matter_ref", matter_number: "matter_ref", matter_no: "matter_ref", matter_id: "matter_ref", file_number: "matter_ref", case_number_internal: "matter_ref", matter: "matter_ref",
  matter_title: "matter_title", matter_name: "matter_title", description: "matter_title", matter_description: "matter_title",
  matter_status: "matter_status", status: "matter_status",
  practice_area: "practice_area", area_of_law: "practice_area", case_type: "practice_area",
  opened_on: "opened_on", open_date: "opened_on", opened: "opened_on", date_opened: "opened_on", consult_date: "opened_on", consultation_date: "opened_on",
  closed_on: "closed_on", close_date: "closed_on", closed: "closed_on", date_closed: "closed_on",
  relationship: "relationship", relation: "relationship", relationship_to_client: "relationship",
  adverse: "adverse", is_adverse: "adverse", adverse_party: "adverse",
};

function headerKey(h: string): string {
  return h.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

export interface ColumnMapping {
  /** column index → field */
  byIndex: Map<number, ImportField>;
  /** source header → field (stored on the batch) */
  described: Record<string, string>;
  unknownHeaders: string[];
  missingRequired: ImportField[];
}

/** Map a header row onto import fields; an explicit override wins over synonyms. Pure. */
export function mapColumns(header: readonly string[], override: Readonly<Record<string, string>> = {}): ColumnMapping {
  const byIndex = new Map<number, ImportField>();
  const described: Record<string, string> = {};
  const unknownHeaders: string[] = [];
  const overrides = new Map(Object.entries(override).map(([k, v]) => [headerKey(k), v]));
  header.forEach((h, i) => {
    const key = headerKey(h);
    const target = (overrides.get(key) ?? HEADER_SYNONYMS[key]) as ImportField | undefined;
    if (target && (IMPORT_FIELDS as readonly string[]).includes(target) && ![...byIndex.values()].includes(target)) {
      byIndex.set(i, target);
      described[h] = target;
    } else if (h.trim()) {
      unknownHeaders.push(h);
    }
  });
  const present = new Set(byIndex.values());
  const missingRequired = (["name", "record_type"] as const).filter((f) => !present.has(f));
  return { byIndex, described, unknownHeaders, missingRequired };
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/** Record types a firm export may contain, and what each becomes in the index. */
const RECORD_TYPES: Readonly<Record<string, { role: IndexRole; kind: "matter" | "consultation"; forcedStatus?: "former" | "prospective" }>> = {
  client: { role: "client", kind: "matter" },
  current_client: { role: "client", kind: "matter" },
  former_client: { role: "former_client", kind: "matter", forcedStatus: "former" },
  past_client: { role: "former_client", kind: "matter", forcedStatus: "former" },
  opposing_party: { role: "opposing_party", kind: "matter" },
  adverse_party: { role: "opposing_party", kind: "matter" },
  opposing: { role: "opposing_party", kind: "matter" },
  opposing_counsel: { role: "opposing_counsel", kind: "matter" },
  related_party: { role: "related_party", kind: "matter" },
  related: { role: "related_party", kind: "matter" },
  co_party: { role: "co_party", kind: "matter" },
  insurer: { role: "insurer", kind: "matter" },
  co_defendant: { role: "co_defendant", kind: "matter" },
  other: { role: "other", kind: "matter" },
  prospective_client: { role: "prospective_client", kind: "consultation", forcedStatus: "prospective" },
  prospect: { role: "prospective_client", kind: "consultation", forcedStatus: "prospective" },
  consultation: { role: "prospective_client", kind: "consultation", forcedStatus: "prospective" },
  declined_consultation: { role: "prospective_client", kind: "consultation", forcedStatus: "prospective" },
  declined: { role: "prospective_client", kind: "consultation", forcedStatus: "prospective" },
  declined_inquiry: { role: "prospective_client", kind: "consultation", forcedStatus: "prospective" },
  consultation_opposing_party: { role: "opposing_party", kind: "consultation", forcedStatus: "prospective" },
  consultation_related_party: { role: "related_party", kind: "consultation", forcedStatus: "prospective" },
};

export const IMPORT_RECORD_TYPES = Object.keys(RECORD_TYPES);

export interface ImportRecord {
  recordType: string;
  role: IndexRole;
  involvementKind: "matter" | "consultation";
  name: string;
  normalizedName: string;
  kind: "person" | "organization";
  variants: Array<{ name: string; type: NameType }>;
  dateOfBirth: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  matterRef: string;
  /** True when the file gave no matter reference and one was made up from the line number. */
  matterRefGenerated: boolean;
  matterTitle: string | null;
  matterStatus: "current" | "former" | "prospective";
  practiceArea: string | null;
  openedOn: string | null;
  closedOn: string | null;
  relationship: string | null;
  isAdverse: boolean | null;
}

export interface ValidatedRow {
  lineNumber: number;
  record: ImportRecord | null;
  errors: string[];
  warnings: string[];
  /** Line of the earlier row this one is the same person as (folded, not a new party). */
  samePersonAsLine: number | null;
  /** Exact repeat of an earlier row: skipped. */
  duplicateOfLine: number | null;
}

const ORG_HINT = /\b(llc|inc|corp|corporation|company|co|ltd|lp|llp|pllc|pc|bank|insurance|trust|association|group|holdings)\b/i;

/** ISO date from YYYY-MM-DD, M/D/YYYY or M-D-YYYY; null when blank; 'invalid' otherwise. Pure. */
export function parseImportDate(value: string): string | null | "invalid" {
  const v = value.trim();
  if (!v) return null;
  let y: number, m: number, d: number;
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(v);
  if (match) [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  else if ((match = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(v))) [m, d, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
  else return "invalid";
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d || y < 1880 || y > 2100) return "invalid";
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function splitList(value: string): string[] {
  return value
    .split(/[;|]/)
    .map((v) => v.trim())
    .filter(Boolean);
}

function statusFrom(raw: string, closedOn: string | null): "current" | "former" | null | "invalid" {
  const v = raw.trim().toLowerCase();
  if (!v) return closedOn ? "former" : null;
  if (["open", "active", "current", "pending", "retained"].includes(v)) return "current";
  if (["closed", "former", "inactive", "archived", "completed", "done"].includes(v)) return "former";
  return "invalid";
}

function boolFrom(raw: string): boolean | null | "invalid" {
  const v = raw.trim().toLowerCase();
  if (!v) return null;
  if (["y", "yes", "true", "1", "adverse"].includes(v)) return true;
  if (["n", "no", "false", "0"].includes(v)) return false;
  return "invalid";
}

/** Validate one data row. Pure. */
export function validateRow(fields: readonly string[], mapping: ColumnMapping, lineNumber: number): ValidatedRow {
  const get = (f: ImportField): string => {
    for (const [i, field] of mapping.byIndex) if (field === f) return (fields[i] ?? "").trim();
    return "";
  };
  const errors: string[] = [];
  const warnings: string[] = [];

  const name = get("name").replace(/\s+/g, " ");
  const normalized = normalizeName(name);
  if (!normalized) errors.push("Name is missing.");
  if (name.length > 200) errors.push("Name is longer than 200 characters.");

  const typeKey = headerKey(get("record_type"));
  const type = RECORD_TYPES[typeKey];
  if (!typeKey) errors.push("Record type is missing.");
  else if (!type) errors.push(`Unknown record type '${get("record_type")}'. Use one of: ${IMPORT_RECORD_TYPES.join(", ")}.`);

  const dob = parseImportDate(get("date_of_birth"));
  if (dob === "invalid") errors.push(`Date of birth '${get("date_of_birth")}' is not a date (use YYYY-MM-DD or M/D/YYYY).`);
  const openedOn = parseImportDate(get("opened_on"));
  if (openedOn === "invalid") errors.push(`Opened date '${get("opened_on")}' is not a date.`);
  const closedOn = parseImportDate(get("closed_on"));
  if (closedOn === "invalid") errors.push(`Closed date '${get("closed_on")}' is not a date.`);

  const email = get("email").toLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push(`Email '${get("email")}' is not valid.`);
  const phone = get("phone");
  if (phone && phone.replace(/\D/g, "").length < 7) warnings.push(`Phone '${phone}' looks too short; kept as given.`);

  const status = statusFrom(get("matter_status"), closedOn === "invalid" ? null : closedOn);
  if (status === "invalid") errors.push(`Matter status '${get("matter_status")}' is not recognised (use open or closed).`);
  const adverse = boolFrom(get("adverse"));
  if (adverse === "invalid") errors.push(`Adverse '${get("adverse")}' must be yes or no.`);

  const kindRaw = get("kind").toLowerCase();
  let kind: "person" | "organization";
  if (["organization", "organisation", "company", "business", "org", "entity"].includes(kindRaw)) kind = "organization";
  else if (["person", "individual", "people", "human"].includes(kindRaw)) kind = "person";
  else {
    if (kindRaw) warnings.push(`Kind '${get("kind")}' not recognised; guessed from the name.`);
    kind = ORG_HINT.test(name) ? "organization" : "person";
  }

  if (errors.length > 0 || !type) {
    return { lineNumber, record: null, errors, warnings, samePersonAsLine: null, duplicateOfLine: null };
  }

  const variants: Array<{ name: string; type: NameType }> = [
    ...splitList(get("aliases")).map((n) => ({ name: n, type: "alias" as const })),
    ...splitList(get("maiden_name")).map((n) => ({ name: n, type: "maiden" as const })),
    ...splitList(get("former_names")).map((n) => ({ name: n, type: "former" as const })),
    ...splitList(get("business_names")).map((n) => ({ name: n, type: "dba" as const })),
  ].filter((v) => normalizeName(v.name) && normalizeName(v.name) !== normalized);

  let matterRef = get("matter_ref");
  const matterRefGenerated = !matterRef;
  if (!matterRef) {
    matterRef = `line-${lineNumber}`;
    warnings.push("No matter reference: this row is kept as its own history entry.");
  }
  const matterStatus: ImportRecord["matterStatus"] = type.forcedStatus ?? (status === "current" || status === "former" ? status : "former");
  if (!type.forcedStatus && status === null) warnings.push("No matter status: treated as closed (former).");

  return {
    lineNumber,
    record: {
      recordType: typeKey,
      role: type.role,
      involvementKind: type.kind,
      name,
      normalizedName: normalized,
      kind,
      variants,
      dateOfBirth: dob as string | null,
      email: email || null,
      phone: phone || null,
      address: get("address") || null,
      matterRef: matterRef.slice(0, 120),
      matterRefGenerated,
      matterTitle: get("matter_title").slice(0, 200) || null,
      matterStatus,
      practiceArea: get("practice_area") || null,
      openedOn: openedOn as string | null,
      closedOn: closedOn as string | null,
      relationship: get("relationship") || null,
      isAdverse: adverse as boolean | null,
    },
    errors,
    warnings,
    samePersonAsLine: null,
    duplicateOfLine: null,
  };
}

/** Identity key for folding rows about the same person within one file (never on name alone). */
function identityKeys(r: ImportRecord): string[] {
  const keys: string[] = [];
  if (r.dateOfBirth) keys.push(`${r.normalizedName}|dob:${r.dateOfBirth}`);
  if (r.email) keys.push(`${r.normalizedName}|email:${r.email}`);
  const digits = (r.phone ?? "").replace(/\D/g, "").slice(-10);
  if (digits.length >= 7) keys.push(`${r.normalizedName}|phone:${digits}`);
  // Organisations are identified by name within one firm's export.
  if (r.kind === "organization") keys.push(`${r.normalizedName}|org`);
  return keys;
}

function rowFingerprint(r: ImportRecord): string {
  return JSON.stringify([r.recordType, r.normalizedName, r.dateOfBirth, r.email, r.phone, r.matterRef, r.relationship]);
}

/**
 * De-duplicate within the file: exact repeats are skipped; rows about the
 * same person (same name AND a matching date of birth, email or phone — or
 * the same organisation name) share one party. Same-name rows with no
 * matching identifier stay separate and become merge suggestions later
 * (c56: never merged automatically). Pure.
 */
export function dedupeRows(rows: readonly ValidatedRow[]): ValidatedRow[] {
  const byFingerprint = new Map<string, number>();
  const byIdentity = new Map<string, number>();
  return rows.map((row) => {
    if (!row.record) return row;
    const fp = rowFingerprint(row.record);
    const repeat = byFingerprint.get(fp);
    if (repeat !== undefined) return { ...row, duplicateOfLine: repeat, warnings: [...row.warnings, `Exact repeat of line ${repeat}; skipped.`] };
    byFingerprint.set(fp, row.lineNumber);
    const keys = identityKeys(row.record);
    const same = keys.map((k) => byIdentity.get(k)).find((x) => x !== undefined);
    for (const k of keys) if (!byIdentity.has(k)) byIdentity.set(k, same ?? row.lineNumber);
    return same !== undefined ? { ...row, samePersonAsLine: same } : row;
  });
}

export interface ImportPreview {
  mapping: ColumnMapping;
  rows: ValidatedRow[];
  fatal: string[];
}

/** Parse, map, validate and de-duplicate a CSV file. Pure. */
export function prepareImport(csv: string, override: Readonly<Record<string, string>> = {}): ImportPreview {
  const fatal: string[] = [];
  if (csv.length > MAX_IMPORT_BYTES) fatal.push(`The file is larger than ${MAX_IMPORT_BYTES / 1024 / 1024} MB; split it into smaller files.`);
  const table = fatal.length ? [] : parseCsv(csv);
  if (!fatal.length && table.length < 2) fatal.push("The file needs a header row and at least one data row.");
  if (table.length - 1 > MAX_IMPORT_ROWS) fatal.push(`The file has more than ${MAX_IMPORT_ROWS} rows; split it into smaller files.`);
  const mapping = mapColumns(table[0] ?? [], override);
  if (table.length >= 1 && mapping.missingRequired.length > 0) {
    fatal.push(`Required columns are missing: ${mapping.missingRequired.join(", ")}.`);
  }
  if (fatal.length) return { mapping, rows: [], fatal };
  const rows = dedupeRows(table.slice(1).map((fields, i) => validateRow(fields, mapping, i + 2)));
  return { mapping, rows, fatal };
}

export interface ImportSummary {
  totalRows: number;
  validRows: number;
  errorRows: number;
  duplicateRows: number;
  samePersonRows: number;
  byRecordType: Record<string, number>;
  matterRefs: number;
  consultations: number;
  warnings: number;
}

/** Counts for the report (no names). Pure. */
export function summarizeImport(rows: readonly ValidatedRow[]): ImportSummary {
  const byRecordType: Record<string, number> = {};
  const refs = new Set<string>();
  const consults = new Set<string>();
  let valid = 0;
  let errorRows = 0;
  let dups = 0;
  let same = 0;
  let warnings = 0;
  for (const r of rows) {
    warnings += r.warnings.length;
    if (!r.record) {
      errorRows++;
      continue;
    }
    if (r.duplicateOfLine !== null) {
      dups++;
      continue;
    }
    valid++;
    if (r.samePersonAsLine !== null) same++;
    byRecordType[r.record.recordType] = (byRecordType[r.record.recordType] ?? 0) + 1;
    (r.record.involvementKind === "consultation" ? consults : refs).add(r.record.matterRef);
  }
  return {
    totalRows: rows.length,
    validRows: valid,
    errorRows,
    duplicateRows: dups,
    samePersonRows: same,
    byRecordType,
    matterRefs: refs.size,
    consultations: consults.size,
    warnings,
  };
}

/** Merge the statuses of several rows about the same matter: current wins (over-flag). Pure. */
export function mergeMatterStatus(a: ImportRecord["matterStatus"], b: ImportRecord["matterStatus"]): ImportRecord["matterStatus"] {
  if (a === "current" || b === "current") return "current";
  if (a === "former" || b === "former") return "former";
  return "prospective";
}

/** A template header the firm can fill in. */
export const IMPORT_TEMPLATE_HEADER = IMPORT_FIELDS.join(",");
