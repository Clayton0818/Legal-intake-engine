// Shared vocabulary for the `documents` table (schema.ts, extended by the
// case-management foundation). The Document engine (src/engines/document/)
// owns the behaviour — upload, versioning, review, filing; these constants
// mirror the CHECK constraints so every engine uses the same values.

export const DOCUMENT_STATUSES = [
  "draft",
  "uploaded",
  "in_review",
  "attorney_approved",
  "client_review",
  "client_approved",
  "final",
  "filed",
  "superseded",
  "archived",
] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

/** c88. Anything other than 'none' is never shared outside the firm without a lawyer's decision. */
export const PRIVILEGE_TAGS = ["none", "privileged", "work_product", "confidential", "sealed"] as const;
export type PrivilegeTag = (typeof PRIVILEGE_TAGS)[number];

export function isDocumentStatus(value: unknown): value is DocumentStatus {
  return typeof value === "string" && (DOCUMENT_STATUSES as readonly string[]).includes(value);
}

export function isPrivilegeTag(value: unknown): value is PrivilegeTag {
  return typeof value === "string" && (PRIVILEGE_TAGS as readonly string[]).includes(value);
}

/**
 * Defence in depth for client-facing document lists (c89): only rows a
 * lawyer explicitly marked client-visible, never privileged/sealed ones.
 */
export function clientShareableDocuments<T extends { clientVisible: boolean; privilegeTag: string }>(rows: readonly T[]): T[] {
  return rows.filter((d) => d.clientVisible && (d.privilegeTag === "none" || d.privilegeTag === "confidential"));
}
