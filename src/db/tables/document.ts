// Tables owned by the Document engine (c4, c39–c41, c49, c84–c90).
//
// Shared tables live in ./foundation.ts and ../schema.ts (imported, never
// redefined or edited). Conventions follow ./foundation.ts: NOT NULL tenantId
// -> firms.id on every tenant-scoped table, text + CHECK for statuses,
// timestamptz everywhere. MIGRATION NOTES are at the bottom of this file;
// migrations are generated once at integration time.
//
// Versions: the shared `documents` table already models a version per row
// (version + versionGroupId, never overwritten — c84). This engine does NOT
// add a second `document_versions` table; per-version storage details that
// the shared table lacks live in `document_files` (1:1 with a documents row).

import { sql } from "drizzle-orm";
import { pgTable, uuid, text, boolean, integer, bigint, timestamp, jsonb, index, uniqueIndex, check, type AnyPgColumn } from "drizzle-orm/pg-core";
import { firms, users, matters, parties, documents } from "../schema";
import { calendarEvents, tasks } from "./foundation";

const ts = (name: string) => timestamp(name, { withTimezone: true });

// ---------------------------------------------------------------------------
// c84 Document store: folders, per-version file info, text index, stub blobs
// ---------------------------------------------------------------------------

export const documentFolders = pgTable("document_folders", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  matterId: uuid("matter_id").notNull().references(() => matters.id),
  parentId: uuid("parent_id").references((): AnyPgColumn => documentFolders.id),
  name: text("name").notNull(),
  /** Full path inside the matter, '/'-separated, e.g. 'Pleadings/Drafts'. */
  path: text("path").notNull(),
  /** Well-known folder the engine files into ('email', 'signed', 'court', 'client_uploads', 'closing'). */
  systemKey: text("system_key"),
  createdAt: ts("created_at").notNull().defaultNow(),
  archivedAt: ts("archived_at"),
}, (t) => [
  uniqueIndex("document_folders_matter_path_key").on(t.tenantId, t.matterId, t.path),
  index("document_folders_matter_idx").on(t.tenantId, t.matterId),
]);

export const DOCUMENT_SOURCES = [
  "upload",
  "client_upload",
  "template",
  "signature",
  "certificate",
  "email_body",
  "email_attachment",
  "court_stamped",
  "import",
] as const;

export const documentFiles = pgTable("document_files", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  documentId: uuid("document_id").notNull().references(() => documents.id),
  matterId: uuid("matter_id").notNull().references(() => matters.id),
  folderId: uuid("folder_id").references(() => documentFolders.id),
  source: text("source").notNull().default("upload"),
  /** Adapter that holds the bytes ('in_db_stub' until vendor.object_storage is approved). */
  storageProvider: text("storage_provider").notNull(),
  /** 'aes-256-gcm' (application-level, stub) or 'provider' (vendor-side encryption). */
  encryption: text("encryption").notNull(),
  scanStatus: text("scan_status").notNull().default("pending"),
  scanEngine: text("scan_engine"),
  scanDetail: text("scan_detail"),
  scannedAt: ts("scanned_at"),
  quarantined: boolean("quarantined").notNull().default(false),
  textStatus: text("text_status").notNull().default("pending"),
  textDetail: text("text_detail"),
  textUpdatedAt: ts("text_updated_at"),
  /** c90: the firm holds the client's physical original. */
  originalHeld: boolean("original_held").notNull().default(false),
  originalDisposition: text("original_disposition"),
  originalDispositionDetail: text("original_disposition_detail"),
  originalDispositionAt: ts("original_disposition_at"),
  originalDispositionByUserId: uuid("original_disposition_by_user_id").references(() => users.id),
  /** c90: content destroyed after an approved retention review (row kept as a tombstone). */
  destroyedAt: ts("destroyed_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("document_files_document_key").on(t.documentId),
  index("document_files_matter_idx").on(t.tenantId, t.matterId),
  check("document_files_source_check", sql`${t.source} in ('upload','client_upload','template','signature','certificate','email_body','email_attachment','court_stamped','import')`),
  check("document_files_scan_status_check", sql`${t.scanStatus} in ('pending','clean','infected','error')`),
  check("document_files_text_status_check", sql`${t.textStatus} in ('pending','extracted','ocr_queued','ocr_blocked','none','failed')`),
  check("document_files_original_disposition_check", sql`${t.originalDisposition} is null or ${t.originalDisposition} in ('returned','kept_by_instruction','not_located','other')`),
]);

/** Extracted / recognised text for full-text search (c84). Staff-only. */
export const documentTexts = pgTable("document_texts", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  documentId: uuid("document_id").notNull().references(() => documents.id),
  matterId: uuid("matter_id").notNull().references(() => matters.id),
  /** 'text' (plain file), 'pdf_text' (embedded PDF text), 'ocr' (recognised). */
  method: text("method").notNull(),
  content: text("content").notNull(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("document_texts_document_key").on(t.documentId),
  index("document_texts_matter_idx").on(t.tenantId, t.matterId),
  check("document_texts_method_check", sql`${t.method} in ('text','pdf_text','ocr')`),
]);

/**
 * STUB storage adapter (c84): encrypted bytes kept in Postgres until the
 * object-storage vendor (vendor.object_storage) is approved. AES-256-GCM
 * with a key from DOCUMENT_STORE_KEY; never plaintext.
 */
export const documentBlobs = pgTable("document_blobs", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  storageKey: text("storage_key").notNull(),
  ciphertext: text("ciphertext").notNull(),
  iv: text("iv").notNull(),
  authTag: text("auth_tag").notNull(),
  keyId: text("key_id").notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  sha256: text("sha256").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("document_blobs_key").on(t.tenantId, t.storageKey)]);

/**
 * LOCAL ADAPTER for c60 ethical screens: which users are screened from which
 * matters. Populated by the integration with the Conflict-check engine's
 * screens (see the PR's shared requests); document access checks read it.
 */
export const documentMatterScreens = pgTable("document_matter_screens", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  matterId: uuid("matter_id").notNull().references(() => matters.id),
  userId: uuid("user_id").notNull().references(() => users.id),
  source: text("source").notNull().default("manual"),
  reason: text("reason"),
  createdAt: ts("created_at").notNull().defaultNow(),
  removedAt: ts("removed_at"),
}, (t) => [index("document_matter_screens_user_idx").on(t.tenantId, t.userId)]);

// ---------------------------------------------------------------------------
// c85 Templates
// ---------------------------------------------------------------------------

export const documentTemplates = pgTable("document_templates", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  name: text("name").notNull(),
  category: text("category").notNull(),
  /** What other workflows look it up by: 'engagement', 'closing', 'waiver', 'non_engagement', 'refund', 'general'. */
  purpose: text("purpose").notNull().default("general"),
  practiceArea: text("practice_area"),
  matterType: text("matter_type"),
  language: text("language").notNull().default("en"),
  status: text("status").notNull().default("active"),
  createdByUserId: uuid("created_by_user_id").references(() => users.id),
  createdAt: ts("created_at").notNull().defaultNow(),
  retiredAt: ts("retired_at"),
}, (t) => [
  index("document_templates_lookup_idx").on(t.tenantId, t.purpose, t.practiceArea),
  check("document_templates_category_check", sql`${t.category} in ('letter','pleading','form','agreement')`),
  check("document_templates_status_check", sql`${t.status} in ('active','retired')`),
  check("document_templates_language_check", sql`${t.language} in ('en','es')`),
]);

export const documentTemplateVersions = pgTable("document_template_versions", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  templateId: uuid("template_id").notNull().references(() => documentTemplates.id),
  versionNo: integer("version_no").notNull(),
  body: text("body").notNull(),
  sha256: text("sha256").notNull(),
  fields: text("fields").array().notNull().default(sql`'{}'::text[]`),
  status: text("status").notNull().default("draft"),
  approvedByUserId: uuid("approved_by_user_id").references(() => users.id),
  approvedAt: ts("approved_at"),
  createdByUserId: uuid("created_by_user_id").references(() => users.id),
  createdAt: ts("created_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("document_template_versions_no_key").on(t.templateId, t.versionNo),
  check("document_template_versions_status_check", sql`${t.status} in ('draft','approved','superseded')`),
  check("document_template_versions_approved_check", sql`${t.status} = 'draft' or (${t.approvedByUserId} is not null and ${t.approvedAt} is not null)`),
]);

export const generatedDocumentSources = pgTable("generated_document_sources", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  documentId: uuid("document_id").notNull().references(() => documents.id),
  templateVersionId: uuid("template_version_id").notNull().references(() => documentTemplateVersions.id),
  fieldValues: jsonb("field_values").$type<Record<string, unknown>>().notNull().default({}),
  missingFields: text("missing_fields").array().notNull().default(sql`'{}'::text[]`),
  /** [{ field, reason, userId, at }] — placeholders a lawyer cleared with a reason. */
  clearedPlaceholders: jsonb("cleared_placeholders").$type<Array<{ field: string; reason: string; userId: string; at: string }>>().notNull().default([]),
  generatedAt: ts("generated_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("generated_document_sources_document_key").on(t.documentId)]);

// ---------------------------------------------------------------------------
// c4 E-signature envelopes
// ---------------------------------------------------------------------------

export const signatureEnvelopes = pgTable("signature_envelopes", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  matterId: uuid("matter_id").notNull().references(() => matters.id),
  documentId: uuid("document_id").notNull().references(() => documents.id),
  /** The envelope is bound to this exact version's hash (c4 rule 1). */
  documentSha256: text("document_sha256").notNull(),
  purpose: text("purpose").notNull(),
  status: text("status").notNull().default("draft"),
  provider: text("provider").notNull(),
  providerEnvelopeId: text("provider_envelope_id"),
  sendAttempts: integer("send_attempts").notNull().default(0),
  lastError: text("last_error"),
  expiresAt: ts("expires_at"),
  createdByUserId: uuid("created_by_user_id").references(() => users.id),
  createdAt: ts("created_at").notNull().defaultNow(),
  sentAt: ts("sent_at"),
  completedAt: ts("completed_at"),
  signedDocumentId: uuid("signed_document_id").references(() => documents.id),
  certificateDocumentId: uuid("certificate_document_id").references(() => documents.id),
  voidReason: text("void_reason"),
  voidedAt: ts("voided_at"),
}, (t) => [
  index("signature_envelopes_matter_idx").on(t.tenantId, t.matterId),
  check("signature_envelopes_purpose_check", sql`${t.purpose} in ('engagement','waiver','pre_filing','fee_change','closing','other')`),
  check("signature_envelopes_status_check", sql`${t.status} in ('draft','sent','completed','declined','expired','voided')`),
]);

export const signatureSigners = pgTable("signature_signers", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  envelopeId: uuid("envelope_id").notNull().references(() => signatureEnvelopes.id),
  orderNo: integer("order_no").notNull(),
  signerType: text("signer_type").notNull(),
  partyId: uuid("party_id").references(() => parties.id),
  userId: uuid("user_id").references(() => users.id),
  identityMethod: text("identity_method").notNull(),
  status: text("status").notNull().default("waiting"),
  consentAt: ts("consent_at"),
  viewedAt: ts("viewed_at"),
  signedAt: ts("signed_at"),
  signatureName: text("signature_name"),
  deviceSummary: text("device_summary"),
  declinedAt: ts("declined_at"),
  declinedReason: text("declined_reason"),
  taskId: uuid("task_id").references(() => tasks.id),
}, (t) => [
  index("signature_signers_envelope_idx").on(t.tenantId, t.envelopeId),
  check("signature_signers_type_check", sql`${t.signerType} in ('client','firm_user')`),
  check("signature_signers_status_check", sql`${t.status} in ('waiting','pending','viewed','signed','declined')`),
  check("signature_signers_identity_check", sql`(${t.signerType} = 'client' and ${t.partyId} is not null) or (${t.signerType} = 'firm_user' and ${t.userId} is not null)`),
]);

// ---------------------------------------------------------------------------
// c39 Engagement agreements
// ---------------------------------------------------------------------------

export const engagementAgreements = pgTable("engagement_agreements", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  matterId: uuid("matter_id").notNull().references(() => matters.id),
  documentId: uuid("document_id").references(() => documents.id),
  envelopeId: uuid("envelope_id").references(() => signatureEnvelopes.id),
  templateVersionId: uuid("template_version_id").references(() => documentTemplateVersions.id),
  feeTerms: jsonb("fee_terms").$type<Record<string, unknown>>().notNull().default({}),
  status: text("status").notNull().default("drafting"),
  approvedByUserId: uuid("approved_by_user_id").references(() => users.id),
  approvedAt: ts("approved_at"),
  completedAt: ts("completed_at"),
  createdByUserId: uuid("created_by_user_id").references(() => users.id),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [
  index("engagement_agreements_matter_idx").on(t.tenantId, t.matterId),
  check("engagement_agreements_status_check", sql`${t.status} in ('drafting','approved','sent','client_signed','completed','declined','voided','expired')`),
]);

// ---------------------------------------------------------------------------
// c40 Document deliveries (staff-only)
// ---------------------------------------------------------------------------

export const documentDeliveries = pgTable("document_deliveries", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  matterId: uuid("matter_id").notNull().references(() => matters.id),
  documentId: uuid("document_id").references(() => documents.id),
  label: text("label").notNull(),
  recipientPartyId: uuid("recipient_party_id").references(() => parties.id),
  status: text("status").notNull().default("unknown"),
  method: text("method"),
  sentOn: text("sent_on"),
  reason: text("reason"),
  answeredByUserId: uuid("answered_by_user_id").references(() => users.id),
  answeredAt: ts("answered_at"),
  needsConfirmation: boolean("needs_confirmation").notNull().default(false),
  confirmedByUserId: uuid("confirmed_by_user_id").references(() => users.id),
  confirmedAt: ts("confirmed_at"),
  askCount: integer("ask_count").notNull().default(0),
  lastAskedAt: ts("last_asked_at"),
  cancelledAt: ts("cancelled_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [
  index("document_deliveries_matter_idx").on(t.tenantId, t.matterId),
  check("document_deliveries_status_check", sql`${t.status} in ('unknown','sent','not_yet','not_needed')`),
  check("document_deliveries_method_check", sql`${t.method} is null or ${t.method} in ('platform','email','mail','hand','other')`),
]);

// ---------------------------------------------------------------------------
// c41 Client sign-off before filing
// ---------------------------------------------------------------------------

export const documentSignoffs = pgTable("document_signoffs", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  matterId: uuid("matter_id").notNull().references(() => matters.id),
  documentId: uuid("document_id").notNull().references(() => documents.id),
  versionGroupId: uuid("version_group_id").notNull(),
  versionSha256: text("version_sha256").notNull(),
  status: text("status").notNull().default("attorney_approved"),
  method: text("method").notNull().default("recorded_approval"),
  envelopeId: uuid("envelope_id").references(() => signatureEnvelopes.id),
  attorneyApprovedByUserId: uuid("attorney_approved_by_user_id").notNull().references(() => users.id),
  attorneyApprovedAt: ts("attorney_approved_at").notNull(),
  linkedDeadlineEventId: uuid("linked_deadline_event_id").references(() => calendarEvents.id),
  sentAt: ts("sent_at"),
  respondedAt: ts("responded_at"),
  withdrawnReason: text("withdrawn_reason"),
  overrideReason: text("override_reason"),
  overrideByUserId: uuid("override_by_user_id").references(() => users.id),
  overrideAt: ts("override_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [
  index("document_signoffs_group_idx").on(t.tenantId, t.versionGroupId),
  check("document_signoffs_status_check", sql`${t.status} in ('attorney_approved','awaiting_client','client_approved','client_commented','withdrawn','overridden')`),
  check("document_signoffs_method_check", sql`${t.method} in ('e_signature','recorded_approval')`),
  check("document_signoffs_override_check", sql`${t.status} <> 'overridden' or (${t.overrideReason} is not null and ${t.overrideByUserId} is not null)`),
]);

export const documentSignoffResponses = pgTable("document_signoff_responses", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  signoffId: uuid("signoff_id").notNull().references(() => documentSignoffs.id),
  partyId: uuid("party_id").notNull().references(() => parties.id),
  status: text("status").notNull().default("pending"),
  respondedAt: ts("responded_at"),
  /** Client's comment text. Staff-only (it is routed to the lawyer). */
  comment: text("comment"),
  taskId: uuid("task_id").references(() => tasks.id),
}, (t) => [
  uniqueIndex("document_signoff_responses_key").on(t.signoffId, t.partyId),
  check("document_signoff_responses_status_check", sql`${t.status} in ('pending','approved','commented','revoked','withdrawn')`),
]);

// ---------------------------------------------------------------------------
// c49 Required-documents checklists
// ---------------------------------------------------------------------------

export interface ChecklistTemplateItem {
  key: string;
  title: string;
  clientDescription: string;
  provider: "client" | "firm" | "third_party";
  thirdPartyLabel?: string;
}

export const checklistTemplates = pgTable("checklist_templates", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  practiceArea: text("practice_area").notNull(),
  matterType: text("matter_type"),
  version: integer("version").notNull().default(1),
  items: jsonb("items").$type<ChecklistTemplateItem[]>().notNull().default([]),
  status: text("status").notNull().default("draft"),
  approvedByUserId: uuid("approved_by_user_id").references(() => users.id),
  approvedAt: ts("approved_at"),
  createdByUserId: uuid("created_by_user_id").references(() => users.id),
  createdAt: ts("created_at").notNull().defaultNow(),
}, (t) => [
  index("checklist_templates_lookup_idx").on(t.tenantId, t.practiceArea, t.matterType),
  check("checklist_templates_status_check", sql`${t.status} in ('draft','approved','retired')`),
]);

export const checklistItems = pgTable("checklist_items", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  matterId: uuid("matter_id").notNull().references(() => matters.id),
  templateId: uuid("template_id").references(() => checklistTemplates.id),
  templateItemKey: text("template_item_key"),
  title: text("title").notNull(),
  clientDescription: text("client_description"),
  provider: text("provider").notNull(),
  thirdPartyLabel: text("third_party_label"),
  status: text("status").notNull().default("missing"),
  dueAt: ts("due_at"),
  linkedDeadlineEventId: uuid("linked_deadline_event_id").references(() => calendarEvents.id),
  naReason: text("na_reason"),
  acceptedByUserId: uuid("accepted_by_user_id").references(() => users.id),
  acceptedAt: ts("accepted_at"),
  requestedAt: ts("requested_at"),
  receivedAt: ts("received_at"),
  /** Advisory AI/format check (firm-only): { result: 'check_ok'|'check_issue', reasons[], checkedAt }. */
  aiCheck: jsonb("ai_check").$type<Record<string, unknown> | null>(),
  /** Lawyer-written plain message to the client after a rejection (client-visible). */
  clientMessage: text("client_message"),
  /** Firm-only note. */
  firmNote: text("firm_note"),
  taskId: uuid("task_id").references(() => tasks.id),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [
  index("checklist_items_matter_idx").on(t.tenantId, t.matterId),
  check("checklist_items_provider_check", sql`${t.provider} in ('client','firm','third_party')`),
  check("checklist_items_status_check", sql`${t.status} in ('missing','requested','received','accepted','not_applicable')`),
  check("checklist_items_na_reason_check", sql`${t.status} <> 'not_applicable' or ${t.naReason} is not null`),
  check("checklist_items_accepted_check", sql`${t.status} <> 'accepted' or ${t.acceptedByUserId} is not null`),
]);

export const checklistItemDocuments = pgTable("checklist_item_documents", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  itemId: uuid("item_id").notNull().references(() => checklistItems.id),
  documentId: uuid("document_id").notNull().references(() => documents.id),
  addedAt: ts("added_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("checklist_item_documents_key").on(t.itemId, t.documentId)]);

// ---------------------------------------------------------------------------
// c87 Matter email filing
// ---------------------------------------------------------------------------

export const matterEmails = pgTable("matter_emails", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  matterId: uuid("matter_id").notNull().references(() => matters.id),
  mailboxUserId: uuid("mailbox_user_id").references(() => users.id),
  providerMessageId: text("provider_message_id").notNull(),
  threadId: text("thread_id"),
  direction: text("direction").notNull(),
  fromAddress: text("from_address").notNull(),
  toAddresses: text("to_addresses").array().notNull().default(sql`'{}'::text[]`),
  ccAddresses: text("cc_addresses").array().notNull().default(sql`'{}'::text[]`),
  subject: text("subject"),
  sentAt: ts("sent_at").notNull(),
  bodyDocumentId: uuid("body_document_id").references(() => documents.id),
  attachmentDocumentIds: uuid("attachment_document_ids").array().notNull().default(sql`'{}'::uuid[]`),
  filedBy: text("filed_by").notNull(),
  filedByUserId: uuid("filed_by_user_id").references(() => users.id),
  matchReason: jsonb("match_reason").$type<Record<string, unknown>>().notNull().default({}),
  suggestedPrivilegeTag: text("suggested_privilege_tag"),
  privilegeTag: text("privilege_tag"),
  privilegeConfirmedByUserId: uuid("privilege_confirmed_by_user_id").references(() => users.id),
  note: text("note"),
  createdAt: ts("created_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("matter_emails_message_key").on(t.tenantId, t.matterId, t.providerMessageId),
  index("matter_emails_thread_idx").on(t.tenantId, t.threadId),
  check("matter_emails_direction_check", sql`${t.direction} in ('inbound','outbound')`),
  check("matter_emails_filed_by_check", sql`${t.filedBy} in ('auto','user')`),
]);

export const emailFilingSuggestions = pgTable("email_filing_suggestions", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  mailboxUserId: uuid("mailbox_user_id").references(() => users.id),
  providerMessageId: text("provider_message_id").notNull(),
  threadId: text("thread_id"),
  candidateMatterIds: uuid("candidate_matter_ids").array().notNull().default(sql`'{}'::uuid[]`),
  reasons: jsonb("reasons").$type<string[]>().notNull().default([]),
  /** Minimal metadata for the reviewer; empty for screened items (no content preview). */
  preview: jsonb("preview").$type<Record<string, unknown>>().notNull().default({}),
  /** Screened-user case (c60): only the firm admin sees it. */
  adminOnly: boolean("admin_only").notNull().default(false),
  status: text("status").notNull().default("open"),
  expiresAt: ts("expires_at").notNull(),
  decidedByUserId: uuid("decided_by_user_id").references(() => users.id),
  decidedAt: ts("decided_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("email_filing_suggestions_message_key").on(t.tenantId, t.providerMessageId),
  check("email_filing_suggestions_status_check", sql`${t.status} in ('open','filed','dismissed','expired')`),
]);

export const emailExclusions = pgTable("email_exclusions", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  /** Null = firm-wide exclusion. */
  userId: uuid("user_id").references(() => users.id),
  type: text("type").notNull(),
  value: text("value").notNull(),
  createdByUserId: uuid("created_by_user_id").references(() => users.id),
  createdAt: ts("created_at").notNull().defaultNow(),
}, (t) => [check("email_exclusions_type_check", sql`${t.type} in ('sender','domain','folder')`)]);

export const emailThreadFilings = pgTable("email_thread_filings", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  threadId: text("thread_id").notNull(),
  matterId: uuid("matter_id").notNull().references(() => matters.id),
  autoFileReplies: boolean("auto_file_replies").notNull().default(true),
  createdAt: ts("created_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("email_thread_filings_key").on(t.tenantId, t.threadId, t.matterId)]);

export const mailboxCursors = pgTable("mailbox_cursors", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  userId: uuid("user_id").notNull().references(() => users.id),
  provider: text("provider").notNull(),
  status: text("status").notNull().default("connected"),
  lastProcessedAt: ts("last_processed_at"),
  processedCount: integer("processed_count").notNull().default(0),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("mailbox_cursors_user_key").on(t.tenantId, t.userId, t.provider),
  check("mailbox_cursors_status_check", sql`${t.status} in ('connected','expired','revoked')`),
]);

// ---------------------------------------------------------------------------
// c90 Closing, legal holds, retention and destruction
// ---------------------------------------------------------------------------

export const matterLegalHolds = pgTable("matter_legal_holds", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  matterId: uuid("matter_id").notNull().references(() => matters.id),
  reason: text("reason").notNull(),
  placedByUserId: uuid("placed_by_user_id").notNull().references(() => users.id),
  placedAt: ts("placed_at").notNull().defaultNow(),
  releasedAt: ts("released_at"),
  releasedByUserId: uuid("released_by_user_id").references(() => users.id),
  releaseReason: text("release_reason"),
}, (t) => [index("matter_legal_holds_matter_idx").on(t.tenantId, t.matterId)]);

export const matterClosings = pgTable("matter_closings", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  matterId: uuid("matter_id").notNull().references(() => matters.id),
  status: text("status").notNull().default("in_progress"),
  /** ClosingChecklist (src/engines/document/closing/closing.ts). */
  checklist: jsonb("checklist").$type<Record<string, unknown>>().notNull().default({}),
  retentionYears: integer("retention_years"),
  startedByUserId: uuid("started_by_user_id").references(() => users.id),
  startedAt: ts("started_at").notNull().defaultNow(),
  closedByUserId: uuid("closed_by_user_id").references(() => users.id),
  closedAt: ts("closed_at"),
  reopenedByUserId: uuid("reopened_by_user_id").references(() => users.id),
  reopenedAt: ts("reopened_at"),
  reopenReason: text("reopen_reason"),
  reviewScheduledTaskId: uuid("review_scheduled_task_id"),
}, (t) => [
  index("matter_closings_matter_idx").on(t.tenantId, t.matterId),
  check("matter_closings_status_check", sql`${t.status} in ('in_progress','closed','reopened')`),
]);

export const matterDestructions = pgTable("matter_destructions", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  matterId: uuid("matter_id").notNull().references(() => matters.id),
  status: text("status").notNull().default("review_pending"),
  reviewTaskId: uuid("review_task_id").references(() => tasks.id),
  decidedByUserId: uuid("decided_by_user_id").references(() => users.id),
  decidedAt: ts("decided_at"),
  reason: text("reason"),
  extendYears: integer("extend_years"),
  executedAt: ts("executed_at"),
  backupPurgeExpectedAt: ts("backup_purge_expected_at"),
  tombstone: jsonb("tombstone").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: ts("created_at").notNull().defaultNow(),
}, (t) => [
  index("matter_destructions_matter_idx").on(t.tenantId, t.matterId),
  check("matter_destructions_status_check", sql`${t.status} in ('review_pending','approved','extended','held','executed','cancelled')`),
]);

// ---------------------------------------------------------------------------
// c86 Court e-filing and service
// ---------------------------------------------------------------------------

export const efilings = pgTable("efilings", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  matterId: uuid("matter_id").notNull().references(() => matters.id),
  /** 'efile_texas' | 'cm_ecf'. */
  system: text("system").notNull(),
  courtName: text("court_name").notNull(),
  causeNumber: text("cause_number"),
  filingType: text("filing_type").notNull(),
  leadDocumentId: uuid("lead_document_id").notNull().references(() => documents.id),
  leadDocumentSha256: text("lead_document_sha256").notNull(),
  attachmentDocumentIds: uuid("attachment_document_ids").array().notNull().default(sql`'{}'::uuid[]`),
  status: text("status").notNull().default("draft"),
  /** Lawyer approval to file (c86: only after the lawyer approves). */
  approvedByUserId: uuid("approved_by_user_id").references(() => users.id),
  approvedAt: ts("approved_at"),
  signoffId: uuid("signoff_id").references(() => documentSignoffs.id),
  provider: text("provider"),
  providerEnvelopeId: text("provider_envelope_id"),
  submitAttempts: integer("submit_attempts").notNull().default(0),
  lastError: text("last_error"),
  queuedAt: ts("queued_at"),
  submittedAt: ts("submitted_at"),
  acceptedAt: ts("accepted_at"),
  rejectedAt: ts("rejected_at"),
  rejectionReason: text("rejection_reason"),
  stampedDocumentId: uuid("stamped_document_id").references(() => documents.id),
  cancelledReason: text("cancelled_reason"),
  createdByUserId: uuid("created_by_user_id").references(() => users.id),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [
  index("efilings_matter_idx").on(t.tenantId, t.matterId),
  index("efilings_status_idx").on(t.tenantId, t.status),
  check("efilings_system_check", sql`${t.system} in ('efile_texas','cm_ecf')`),
  check("efilings_status_check", sql`${t.status} in ('draft','approved','queued','submitted','accepted','rejected','cancelled','failed')`),
  check("efilings_approved_check", sql`${t.status} in ('draft','cancelled') or (${t.approvedByUserId} is not null and ${t.approvedAt} is not null)`),
  check("efilings_rejected_check", sql`${t.status} <> 'rejected' or ${t.rejectionReason} is not null`),
]);

export const efilingServices = pgTable("efiling_services", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  efilingId: uuid("efiling_id").notNull().references(() => efilings.id),
  matterId: uuid("matter_id").notNull().references(() => matters.id),
  partyId: uuid("party_id").notNull().references(() => parties.id),
  method: text("method").notNull(),
  status: text("status").notNull().default("pending"),
  servedAt: ts("served_at"),
  proofDocumentId: uuid("proof_document_id").references(() => documents.id),
  detail: text("detail"),
  recordedByUserId: uuid("recorded_by_user_id").references(() => users.id),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("efiling_services_party_key").on(t.efilingId, t.partyId),
  check("efiling_services_method_check", sql`${t.method} in ('efile_service','email','mail','certified_mail','personal','other')`),
  check("efiling_services_status_check", sql`${t.status} in ('pending','served','failed','not_required')`),
]);

// ---------------------------------------------------------------------------
// MIGRATION NOTES for the integration step (hand-add to the generated SQL):
//
// 1. RLS + tenant_isolation policy (same text as migrations/0000) on every
//    table above: document_folders, document_files, document_texts,
//    document_blobs, document_matter_screens, document_templates,
//    document_template_versions, generated_document_sources,
//    signature_envelopes, signature_signers, engagement_agreements,
//    document_deliveries, document_signoffs, document_signoff_responses,
//    checklist_templates, checklist_items, checklist_item_documents,
//    matter_emails, email_filing_suggestions, email_exclusions,
//    email_thread_filings, mailbox_cursors, matter_legal_holds,
//    matter_closings, matter_destructions, efilings, efiling_services.
// 2. GRANT SELECT, INSERT, UPDATE, DELETE ON all of the above TO app_runtime.
// 3. Full-text search (c84):
//    CREATE INDEX document_texts_fts_idx ON document_texts
//      USING gin (to_tsvector('english', content));
// 4. Client portal accounts (c11/c99, not built yet) must never be granted
//    document_deliveries, document_texts, email_* or matter_emails; client
//    reads of checklist_items must be limited to provider = 'client' on the
//    client's own matters (c49 rule 3) — enforce in the access layer / a
//    dedicated client role policy when c99 lands.
// 5. document_blobs is the STUB storage adapter; drop it (after migrating
//    blobs) once vendor.object_storage is approved and a real adapter is live.
// ---------------------------------------------------------------------------
