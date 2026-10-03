// Tables owned by the Document engine (c39–c41, c49, c84–c90).
//
// c84 — the per-matter document store. Builds ON the shared `documents` table
// (schema.ts): one `documents` row is one immutable VERSION of a file
// (version, versionGroupId, status, privilegeTag, clientVisible, mimeType,
// sizeBytes, sha256 all live there). This file only adds what the shared
// table does not have:
//
//   document_folder_templates  firm-set folder layout per practice area (versioned)
//   document_folders           the folder tree of one matter
//   document_groups            one row per logical file (version group): folder, current version, legal hold
//   document_version_files     storage + checksum + malware-scan facts for each version's bytes
//   document_text              extracted / OCR text and the full-text search vector
//   document_access_log        append-only log of every view, download, search and denial
//   document_access_blocks     local mirror of ethical screens (c60) until a shared screens table exists
//   document_retention_rules   firm-entered retention periods (gated config; applied only via rules.retention_periods)
//
// Conventions (./foundation.ts): NOT NULL tenantId -> firms.id on every
// table, text + CHECK for statuses, timestamptz, indexes leading with
// tenant_id (except the GIN search index — see MIGRATION NOTES).

import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  bigint,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  check,
  customType,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { firms, users, matters, parties, documents } from "../schema";

/** Postgres `tsvector`. Read as text if ever selected; normally only used in WHERE / ORDER BY. */
const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

// ---------------------------------------------------------------------------
// Folder templates (firm-set, per practice area)
// ---------------------------------------------------------------------------

/**
 * Shape of `document_folder_templates.folders`: a small tree. `key` is a
 * stable machine name other engines use to find a folder ("email" for c87,
 * "client_uploads" for c49, "agreements" for c4/c39) whatever the firm calls
 * it. Validated by src/engines/document/folders/template.ts.
 */
export interface FolderTemplateNode {
  key: string;
  name: string;
  /** Default privilege tag for new uploads into this folder (c88). Defaults to 'none'. */
  defaultPrivilegeTag?: string;
  children?: FolderTemplateNode[];
}

export const documentFolderTemplates = pgTable("document_folder_templates", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  name: text("name").notNull(),
  /** PracticeAreaId ('family', …) or null for the firm-wide fallback template. */
  practiceArea: text("practice_area"),
  /** Increments per (tenant, practice area) each time a new template is saved. */
  version: integer("version").notNull().default(1),
  /** 'draft' | 'active' | 'retired'. At most one 'active' per (tenant, practice area). */
  status: text("status").notNull().default("draft"),
  folders: jsonb("folders").$type<FolderTemplateNode[]>().notNull(),
  createdByUserId: uuid("created_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  activatedAt: timestamp("activated_at", { withTimezone: true }),
  activatedByUserId: uuid("activated_by_user_id").references(() => users.id),
  retiredAt: timestamp("retired_at", { withTimezone: true }),
}, (t) => [
  index("document_folder_templates_tenant_area_idx").on(t.tenantId, t.practiceArea, t.status),
  // One active template per practice area; COALESCE so the null (firm-wide) area is unique too.
  uniqueIndex("document_folder_templates_one_active_key")
    .on(t.tenantId, sql`coalesce(${t.practiceArea}, '')`)
    .where(sql`${t.status} = 'active'`),
  check("document_folder_templates_status_check", sql`${t.status} in ('draft','active','retired')`),
  check("document_folder_templates_version_check", sql`${t.version} >= 1`),
]);

// ---------------------------------------------------------------------------
// Folders of one matter
// ---------------------------------------------------------------------------

export const documentFolders = pgTable("document_folders", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  matterId: uuid("matter_id").notNull().references(() => matters.id),
  /** Null = top level of the matter. */
  parentId: uuid("parent_id").references((): AnyPgColumn => documentFolders.id),
  name: text("name").notNull(),
  /** Lower-cased, whitespace-collapsed name, for sibling uniqueness. */
  normalizedName: text("normalized_name").notNull(),
  /** Template key when created from a template ('email', 'client_uploads' …); null for ad-hoc folders. */
  templateKey: text("template_key"),
  templateId: uuid("template_id").references(() => documentFolderTemplates.id),
  defaultPrivilegeTag: text("default_privilege_tag").notNull().default("none"),
  position: integer("position").notNull().default(0),
  createdByUserId: uuid("created_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  /** Folders are archived, never deleted (they may hold version history). */
  archivedAt: timestamp("archived_at", { withTimezone: true }),
}, (t) => [
  index("document_folders_tenant_matter_idx").on(t.tenantId, t.matterId, t.parentId),
  // Sibling names unique among live folders; COALESCE makes top-level siblings unique too.
  uniqueIndex("document_folders_sibling_name_key")
    .on(t.tenantId, t.matterId, sql`coalesce(${t.parentId}, '00000000-0000-0000-0000-000000000000'::uuid)`, t.normalizedName)
    .where(sql`${t.archivedAt} is null`),
  // A template key appears once per matter (engines look folders up by key).
  uniqueIndex("document_folders_template_key_key")
    .on(t.tenantId, t.matterId, t.templateKey)
    .where(sql`${t.templateKey} is not null and ${t.archivedAt} is null`),
  check(
    "document_folders_privilege_tag_check",
    sql`${t.defaultPrivilegeTag} in ('none','privileged','work_product','confidential','sealed')`
  ),
]);

// ---------------------------------------------------------------------------
// Version groups (one logical file)
// ---------------------------------------------------------------------------

/**
 * One row per logical file. `groupDocumentId` is the `documents.id` of
 * version 1 (the shared table's version-group convention); every later
 * version is a NEW `documents` row with versionGroupId = groupDocumentId.
 * Bytes are never overwritten.
 */
export const documentGroups = pgTable("document_groups", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  groupDocumentId: uuid("group_document_id").notNull().references(() => documents.id),
  matterId: uuid("matter_id").notNull().references(() => matters.id),
  folderId: uuid("folder_id").references(() => documentFolders.id),
  title: text("title").notNull(),
  currentDocumentId: uuid("current_document_id").notNull().references(() => documents.id),
  latestVersion: integer("latest_version").notNull().default(1),
  /** Legal hold (c2 §6 / c90): blocks any destruction review from approving. */
  legalHold: boolean("legal_hold").notNull().default(false),
  legalHoldReason: text("legal_hold_reason"),
  /** c90: an original paper document is held by the firm. */
  originalHeld: boolean("original_held").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("document_groups_group_document_key").on(t.tenantId, t.groupDocumentId),
  index("document_groups_tenant_matter_idx").on(t.tenantId, t.matterId, t.folderId),
  check("document_groups_latest_version_check", sql`${t.latestVersion} >= 1`),
  check("document_groups_hold_reason_check", sql`not ${t.legalHold} or ${t.legalHoldReason} is not null`),
]);

// ---------------------------------------------------------------------------
// Bytes of each version: storage, checksum, malware scan
// ---------------------------------------------------------------------------

export const documentVersionFiles = pgTable("document_version_files", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  /** The `documents` row (one version). One file per version. */
  documentId: uuid("document_id").notNull().references(() => documents.id),
  /** StorageAdapter.name that holds the bytes: 'memory' | 'local' | a vendor adapter. */
  storageAdapter: text("storage_adapter").notNull(),
  storageKey: text("storage_key").notNull(),
  /** Hex SHA-256 of the plaintext bytes, computed server-side at upload. */
  sha256: text("sha256").notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  /** MIME type detected from the bytes (may differ from the declared one). */
  detectedMimeType: text("detected_mime_type"),
  declaredMimeType: text("declared_mime_type"),
  originalFilename: text("original_filename"),
  /** Encryption scheme applied by the adapter, e.g. 'aes-256-gcm' or 'vendor-sse'. Never the key. */
  encryption: text("encryption").notNull(),
  /** 'pending' | 'clean' | 'infected' | 'error' | 'not_scanned' (no approved scanner yet). */
  scanStatus: text("scan_status").notNull().default("pending"),
  scanDetail: text("scan_detail"),
  scannedAt: timestamp("scanned_at", { withTimezone: true }),
  quarantinedAt: timestamp("quarantined_at", { withTimezone: true }),
  lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("document_version_files_document_key").on(t.tenantId, t.documentId),
  index("document_version_files_tenant_sha_idx").on(t.tenantId, t.sha256),
  index("document_version_files_tenant_scan_idx").on(t.tenantId, t.scanStatus),
  check(
    "document_version_files_scan_status_check",
    sql`${t.scanStatus} in ('pending','clean','infected','error','not_scanned')`
  ),
  check("document_version_files_sha_check", sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
  check("document_version_files_size_check", sql`${t.sizeBytes} >= 0`),
  check("document_version_files_quarantine_check", sql`${t.scanStatus} <> 'infected' or ${t.quarantinedAt} is not null`),
]);

// ---------------------------------------------------------------------------
// Extracted text + full-text search
// ---------------------------------------------------------------------------

export const documentText = pgTable("document_text", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  documentId: uuid("document_id").notNull().references(() => documents.id),
  /** Denormalised for search filters (same as documents.matter_id / document_groups.id). */
  matterId: uuid("matter_id").notNull().references(() => matters.id),
  groupId: uuid("group_id").notNull().references(() => documentGroups.id),
  /** Copied from the group title so a title match ranks highest. */
  title: text("title").notNull().default(""),
  /**
   * 'pending' (not processed yet) | 'extracted' | 'ocr_pending' (scanned; waiting for an
   * approved OCR vendor) | 'unsupported' | 'failed' | 'blocked' (quarantined file).
   */
  status: text("status").notNull().default("pending"),
  /** 'native' (text layer / text file) | 'ocr' | null while pending. */
  method: text("method"),
  content: text("content").notNull().default(""),
  /** True when content was cut at the firm's maxIndexedChars setting. */
  truncated: boolean("truncated").notNull().default(false),
  pageCount: integer("page_count"),
  detail: text("detail"),
  attempts: integer("attempts").notNull().default(0),
  extractedAt: timestamp("extracted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  /**
   * Generated search vector (title weighted A, body B). 'english' is a
   * constant regconfig, so to_tsvector/setweight are IMMUTABLE and allowed in
   * a STORED generated column. See MIGRATION NOTES 4.
   */
  searchVector: tsvector("search_vector").generatedAlwaysAs(
    sql`setweight(to_tsvector('english'::regconfig, coalesce(title, '')), 'A') || setweight(to_tsvector('english'::regconfig, coalesce(content, '')), 'B')`
  ),
}, (t) => [
  uniqueIndex("document_text_document_key").on(t.tenantId, t.documentId),
  index("document_text_tenant_matter_idx").on(t.tenantId, t.matterId),
  index("document_text_tenant_status_idx").on(t.tenantId, t.status),
  index("document_text_search_idx").using("gin", t.searchVector),
  check(
    "document_text_status_check",
    sql`${t.status} in ('pending','extracted','ocr_pending','unsupported','failed','blocked')`
  ),
  check("document_text_method_check", sql`${t.method} is null or ${t.method} in ('native','ocr')`),
]);

// ---------------------------------------------------------------------------
// Access log (append-only)
// ---------------------------------------------------------------------------

export const documentAccessLog = pgTable("document_access_log", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  /** The version viewed/downloaded; null for a search or a matter-level listing. */
  documentId: uuid("document_id").references(() => documents.id),
  groupId: uuid("group_id").references(() => documentGroups.id),
  matterId: uuid("matter_id").references(() => matters.id),
  /** 'user' | 'client' | 'system'. */
  actorType: text("actor_type").notNull(),
  actorUserId: uuid("actor_user_id").references(() => users.id),
  actorPartyId: uuid("actor_party_id").references(() => parties.id),
  /** 'view' | 'download' | 'list' | 'search' | 'version_history'. */
  action: text("action").notNull(),
  /** 'allowed' | 'denied'. Denials are logged too. */
  outcome: text("outcome").notNull(),
  /** Machine reason for a denial ('screened', 'no_permission', 'restricted_tag', 'quarantined' …). */
  reason: text("reason"),
  /** Search text (internal log only), result count, byte count, request id … */
  detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("document_access_log_tenant_document_idx").on(t.tenantId, t.documentId, t.occurredAt),
  index("document_access_log_tenant_matter_idx").on(t.tenantId, t.matterId, t.occurredAt),
  index("document_access_log_tenant_user_idx").on(t.tenantId, t.actorUserId, t.occurredAt),
  check("document_access_log_actor_type_check", sql`${t.actorType} in ('user','client','system')`),
  check(
    "document_access_log_action_check",
    sql`${t.action} in ('view','download','list','search','version_history')`
  ),
  check("document_access_log_outcome_check", sql`${t.outcome} in ('allowed','denied')`),
  check("document_access_log_denied_reason_check", sql`${t.outcome} <> 'denied' or ${t.reason} is not null`),
]);

// ---------------------------------------------------------------------------
// Screens mirror (c60) — LOCAL ADAPTER
// ---------------------------------------------------------------------------

/**
 * "This user must not see this matter's documents." Mirrors ethical screens
 * (c60), which the conflict-check engine owns in its own tables; an engine
 * cannot import those, so until a SHARED screens table exists (foundation
 * request) screens are recorded here by staff or a sync job. Access checks
 * also accept an injected ScreenSource (src/engines/document/access/policy.ts),
 * so the shared table can be plugged in without changing callers.
 */
export const documentAccessBlocks = pgTable("document_access_blocks", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  userId: uuid("user_id").notNull().references(() => users.id),
  matterId: uuid("matter_id").notNull().references(() => matters.id),
  /** 'ethical_screen' (c60) | 'restricted' | 'other'. */
  reason: text("reason").notNull(),
  note: text("note"),
  /** 'manual' | 'sync' (copied from the conflict-check engine's screens by a job). */
  source: text("source").notNull().default("manual"),
  /** e.g. the conflict screen id this row mirrors. */
  sourceRef: text("source_ref"),
  createdByUserId: uuid("created_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  endedByUserId: uuid("ended_by_user_id").references(() => users.id),
  endedReason: text("ended_reason"),
}, (t) => [
  index("document_access_blocks_tenant_user_idx").on(t.tenantId, t.userId, t.endedAt),
  index("document_access_blocks_tenant_matter_idx").on(t.tenantId, t.matterId),
  uniqueIndex("document_access_blocks_active_key")
    .on(t.tenantId, t.userId, t.matterId)
    .where(sql`${t.endedAt} is null`),
  check("document_access_blocks_reason_check", sql`${t.reason} in ('ethical_screen','restricted','other')`),
  check("document_access_blocks_source_check", sql`${t.source} in ('manual','sync')`),
  check("document_access_blocks_ended_check", sql`${t.endedAt} is null or ${t.endedReason} is not null`),
]);

// ---------------------------------------------------------------------------
// Retention periods (gated config)
// ---------------------------------------------------------------------------

/**
 * Firm-entered retention periods. The product ships NO default values
 * (c90 open question 18). Storing a rule is configuration; APPLYING one
 * (proposing a destruction-eligibility date) requires the shared
 * `rules.retention_periods` gate, and destruction itself always needs a
 * lawyer's approval (c90). Rows are superseded, never edited.
 */
export const documentRetentionRules = pgTable("document_retention_rules", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  /** PracticeAreaId or null for every practice area. */
  practiceArea: text("practice_area"),
  /** documents.document_type or null for every type. */
  documentType: text("document_type"),
  /** Years after the matter closes. */
  retainYearsAfterClose: integer("retain_years_after_close").notNull(),
  /** Where the firm got this number (its policy, an ethics opinion, its insurer). Required. */
  basis: text("basis").notNull(),
  createdByUserId: uuid("created_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  supersededAt: timestamp("superseded_at", { withTimezone: true }),
  supersededByUserId: uuid("superseded_by_user_id").references(() => users.id),
}, (t) => [
  index("document_retention_rules_tenant_idx").on(t.tenantId, t.practiceArea, t.documentType),
  uniqueIndex("document_retention_rules_live_key")
    .on(t.tenantId, sql`coalesce(${t.practiceArea}, '')`, sql`coalesce(${t.documentType}, '')`)
    .where(sql`${t.supersededAt} is null`),
  check("document_retention_rules_years_check", sql`${t.retainYearsAfterClose} between 0 and 100`),
]);

// ---------------------------------------------------------------------------
// MIGRATION NOTES for the integration step (hand-add to the generated SQL):
//
// 1. RLS + the standard tenant_isolation policy (same text as migrations/0000)
//    on every table in this file:
//    document_folder_templates, document_folders, document_groups,
//    document_version_files, document_text, document_access_log,
//    document_access_blocks, document_retention_rules.
//
// 2. Staging grants app_runtime SELECT/INSERT/UPDATE/DELETE on new tables by
//    default. Restrict as follows:
//    - document_access_log is append-only (every view/download must survive):
//        REVOKE UPDATE, DELETE ON document_access_log FROM app_runtime;
//    - version history must never lose rows (c84: never overwritten):
//        REVOKE DELETE ON document_groups, document_version_files, document_text,
//          document_folders, document_folder_templates, document_retention_rules,
//          document_access_blocks FROM app_runtime;
//      (Destruction after the retention clock — c90 — runs under a separate,
//      elevated purge role after lawyer approval, not as app_runtime.)
//    - document_retention_rules is supersede-only; app_runtime may UPDATE only
//      the superseded_* columns:
//        REVOKE UPDATE ON document_retention_rules FROM app_runtime;
//        GRANT UPDATE (superseded_at, superseded_by_user_id) ON document_retention_rules TO app_runtime;
//    - document_version_files: the bytes' identity never changes:
//        REVOKE UPDATE ON document_version_files FROM app_runtime;
//        GRANT UPDATE (scan_status, scan_detail, scanned_at, quarantined_at, last_verified_at)
//          ON document_version_files TO app_runtime;
//
// 3. Shared `documents` table (schema.ts — FOUNDATION REQUEST, not done here):
//    a BEFORE UPDATE trigger that rejects changes to storage_key, sha256,
//    size_bytes, mime_type, version, version_group_id, matter_id once set,
//    so a version's content can never be overwritten in place; and
//    REVOKE DELETE ON documents FROM app_runtime.
//
// 4. document_text.search_vector is a STORED generated column:
//      GENERATED ALWAYS AS (setweight(to_tsvector('english'::regconfig, coalesce(title,'')),'A')
//                         || setweight(to_tsvector('english'::regconfig, coalesce(content,'')),'B')) STORED
//    Check drizzle-kit emitted exactly that (with the ::regconfig casts — the
//    one-argument to_tsvector is only STABLE and Postgres would refuse it).
//    The GIN index document_text_search_idx cannot lead with tenant_id
//    without the btree_gin extension; tenant scoping comes from RLS plus the
//    explicit tenant_id filter in every query. If btree_gin is available,
//    prefer: CREATE INDEX … USING gin (tenant_id, search_vector).
//    tsvector values are capped at 1 MB; the engine truncates content to the
//    firm's maxIndexedChars setting (default 400 000 chars) before insert.
//
// 5. Partial unique indexes above use expressions (coalesce) and WHERE
//    clauses; confirm drizzle-kit emitted them verbatim.
// ---------------------------------------------------------------------------
