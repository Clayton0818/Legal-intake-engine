// The per-matter document store (c84), database side: uploads and new
// versions (never overwritten), listing a matter, a document's detail and
// version history, downloads (checksum-verified, access-logged), and
// moving / tagging a file. Every view and download — allowed or denied — is
// written to document_access_log.

import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { documents, matters, users } from "@/db/schema";
import { documentFolders, documentGroups, documentText, documentVersionFiles } from "@/db/tables/document";
import { audit, isPrivilegeTag, raiseFlag } from "@/core";
import type { TenantTx } from "@/tenancy/withTenant";
import { DocumentError, NotFoundError } from "../errors";
import { ENGINE, type DocumentSettings } from "../settings";
import { decideDocumentAccess, decideMatter, type AccessContext, type StaffViewer } from "../access/policy";
import { actorOf, denyAndLog, logAccess } from "../access/service";
import { gatedAdapters, type DocumentAdapters } from "../storage/adapters";
import { checkUpload, checksumsMatch, planVersion, sha256Hex, storageKeyFor, titleFromFilename } from "../versions/versioning";
import { indexVersionText } from "../extraction/service";
import { getFolder, provisionMatterFolders } from "../folders/service";

/** Uploads up to this size are text-indexed inline; bigger ones by the worker. */
export const INLINE_INDEX_MAX_BYTES = 5 * 1024 * 1024;

const DOCUMENT_TYPE = /^[a-z0-9_.-]{1,64}$/;

export interface UploadInput {
  matterId: string;
  /** Add a new version to this existing file (its group id). Omit for a new file. */
  groupId?: string | null;
  folderId?: string | null;
  bytes: Uint8Array;
  filename: string | null;
  declaredMimeType: string | null;
  expectedSha256?: string | null;
  title?: string | null;
  documentType?: string | null;
  privilegeTag?: string | null;
}

export interface UploadResult {
  created: boolean;
  documentId: string;
  groupId: string;
  version: number;
  sha256: string;
  scanStatus: string;
  textStatus: string;
  warnings: string[];
}

interface Ctx {
  tenantId: string;
  viewer: StaffViewer;
  access: AccessContext;
  settings: DocumentSettings;
  adapters?: DocumentAdapters;
  now?: Date;
}

async function loadMatter(tx: TenantTx, tenantId: string, matterId: string) {
  const [m] = await tx
    .select({ id: matters.id, practiceArea: matters.practiceArea, stage: matters.stage })
    .from(matters)
    .where(and(eq(matters.tenantId, tenantId), eq(matters.id, matterId)))
    .limit(1);
  if (!m) throw new NotFoundError("Matter");
  return m;
}

async function firmAdminIds(tx: TenantTx, tenantId: string): Promise<string[]> {
  const rows = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.tenantId, tenantId), eq(users.role, "firm_admin"), eq(users.status, "active")));
  return rows.map((r) => r.id);
}

/**
 * Store a new file or a new version of an existing one.
 * Bytes go to storage first (a pending vendor gate stops here with 423 and
 * writes nothing), then the rows are written in this transaction.
 */
export async function uploadDocument(tx: TenantTx, ctx: Ctx, input: UploadInput): Promise<UploadResult> {
  const { tenantId, viewer } = ctx;
  const now = ctx.now ?? new Date();
  const warnings: string[] = [];

  const probe = decideDocumentAccess(viewer, "upload", { matterId: input.matterId, privilegeTag: "none", clientVisible: false }, ctx.access);
  if (!probe.allowed) throw new DocumentError("You cannot upload to this matter.", 403, { reason: probe.reason });
  await loadMatter(tx, tenantId, input.matterId);

  const documentType = (input.documentType ?? "general").trim().toLowerCase();
  if (!DOCUMENT_TYPE.test(documentType)) throw new DocumentError("Document type must be a short lowercase code, e.g. 'pleading'.");
  if (input.privilegeTag != null && !isPrivilegeTag(input.privilegeTag)) throw new DocumentError(`Unknown privilege tag '${input.privilegeTag}'.`);

  // Existing file? Lock its group row so concurrent uploads cannot both become version N+1.
  let group: typeof documentGroups.$inferSelect | null = null;
  let current: typeof documents.$inferSelect | null = null;
  let currentSha: string | null = null;
  if (input.groupId) {
    const [g] = await tx
      .select()
      .from(documentGroups)
      .where(and(eq(documentGroups.tenantId, tenantId), eq(documentGroups.id, input.groupId)))
      .for("update")
      .limit(1);
    if (!g || g.matterId !== input.matterId) throw new NotFoundError("Document");
    group = g;
    const [cur] = await tx.select().from(documents).where(eq(documents.id, g.currentDocumentId)).limit(1);
    current = cur ?? null;
    const [f] = await tx.select({ sha: documentVersionFiles.sha256 }).from(documentVersionFiles).where(eq(documentVersionFiles.documentId, g.currentDocumentId)).limit(1);
    currentSha = f?.sha ?? current?.sha256 ?? null;
    const roles = ctx.access.restrictedTags[(current?.privilegeTag ?? "none") as keyof AccessContext["restrictedTags"]];
    if (roles && !roles.includes(viewer.role)) throw new DocumentError("You cannot add versions to this document.", 403, { reason: "restricted_tag" });
  }

  const check = checkUpload(
    { bytes: input.bytes, filename: input.filename, declaredMimeType: input.declaredMimeType, expectedSha256: input.expectedSha256 },
    ctx.settings
  );
  if (!check.ok) throw new DocumentError(check.message, check.code === "too_large" ? 413 : 422, { code: check.code });
  if (check.mismatchWarning) warnings.push(check.mismatchWarning);

  const plan = planVersion(
    group ? { groupDocumentId: group.groupDocumentId, latestVersion: group.latestVersion, currentSha256: currentSha, currentStatus: current?.status ?? "draft" } : null,
    check.sha256
  );
  if (plan.kind === "identical_to_current") {
    const [t] = await tx.select({ status: documentText.status }).from(documentText).where(eq(documentText.documentId, group!.currentDocumentId)).limit(1);
    const [f] = await tx.select({ scan: documentVersionFiles.scanStatus }).from(documentVersionFiles).where(eq(documentVersionFiles.documentId, group!.currentDocumentId)).limit(1);
    return {
      created: false,
      documentId: group!.currentDocumentId,
      groupId: group!.id,
      version: group!.latestVersion,
      sha256: check.sha256,
      scanStatus: f?.scan ?? "pending",
      textStatus: t?.status ?? "pending",
      warnings: ["This file is identical to the current version; no new version was created."],
    };
  }

  // Same bytes elsewhere in the matter: allowed (e.g. an exhibit filed twice), but say so.
  const dupes = await tx
    .select({ documentId: documentVersionFiles.documentId })
    .from(documentVersionFiles)
    .innerJoin(documents, eq(documents.id, documentVersionFiles.documentId))
    .where(and(eq(documentVersionFiles.tenantId, tenantId), eq(documentVersionFiles.sha256, check.sha256), eq(documents.matterId, input.matterId)))
    .limit(3);
  if (dupes.length) warnings.push("The same file is already stored elsewhere in this matter.");

  // Folder: explicit, else the group's, else top level.
  const folderId = input.folderId ?? group?.folderId ?? null;
  let folderTag = "none";
  if (folderId) {
    const folder = await getFolder(tx, tenantId, folderId);
    if (!folder || folder.matterId !== input.matterId || folder.archivedAt) throw new NotFoundError("Folder");
    folderTag = folder.defaultPrivilegeTag;
  }
  const privilegeTag = input.privilegeTag ?? current?.privilegeTag ?? folderTag;
  const tagRoles = ctx.access.restrictedTags[privilegeTag as keyof AccessContext["restrictedTags"]];
  if (tagRoles && !tagRoles.includes(viewer.role)) throw new DocumentError(`You cannot file a '${privilegeTag}' document.`, 403, { reason: "restricted_tag" });

  const documentId = randomUUID();
  const groupDocumentId = group?.groupDocumentId ?? documentId;
  const version = plan.version;
  const key = storageKeyFor({ tenantId, matterId: input.matterId, groupId: groupDocumentId, version, objectId: documentId });

  // 1) bytes → storage (vendor gate checked here), 2) malware scan.
  const adapters = gatedAdapters(tenantId, ctx.adapters);
  const meta = { contentType: check.detectedMimeType, sha256: check.sha256 };
  const put = await adapters.storage.put(key, input.bytes, meta);
  let scan: { status: string; detail?: string };
  try {
    scan = await adapters.scanner.scan(input.bytes, meta);
  } catch (err) {
    scan = { status: "error", detail: (err as Error).message };
  }
  if (scan.status === "not_scanned") warnings.push("This file has not been virus-scanned (no scanner approved yet).");

  // 3) rows.
  const title = input.title?.trim() || group?.title || titleFromFilename(check.filename);
  await tx.insert(documents).values({
    id: documentId,
    tenantId,
    matterId: input.matterId,
    documentType: group ? (current?.documentType ?? documentType) : documentType,
    storageKey: key,
    uploadedByUserId: viewer.userId,
    name: check.filename,
    version,
    versionGroupId: group ? groupDocumentId : null,
    status: "uploaded",
    privilegeTag,
    clientVisible: false,
    mimeType: check.detectedMimeType,
    sizeBytes: check.sizeBytes,
    sha256: check.sha256,
    createdAt: now,
    updatedAt: now,
  });
  await tx.insert(documentVersionFiles).values({
    tenantId,
    documentId,
    storageAdapter: adapters.storage.name,
    storageKey: key,
    sha256: check.sha256,
    sizeBytes: check.sizeBytes,
    detectedMimeType: check.detectedMimeType,
    declaredMimeType: input.declaredMimeType,
    originalFilename: check.filename,
    encryption: put.encryption,
    scanStatus: scan.status,
    scanDetail: scan.detail ?? null,
    scannedAt: scan.status === "not_scanned" ? null : now,
    quarantinedAt: scan.status === "infected" ? now : null,
  });

  let groupId: string;
  if (group) {
    groupId = group.id;
    if (plan.kind === "new_version" && plan.supersedePrevious && current) {
      await tx.update(documents).set({ status: "superseded", updatedAt: now }).where(eq(documents.id, current.id));
    }
    await tx
      .update(documentGroups)
      .set({ currentDocumentId: documentId, latestVersion: version, folderId, title, updatedAt: now })
      .where(eq(documentGroups.id, group.id));
  } else {
    const [g] = await tx
      .insert(documentGroups)
      .values({ tenantId, groupDocumentId: documentId, matterId: input.matterId, folderId, title, currentDocumentId: documentId, latestVersion: 1, createdAt: now, updatedAt: now })
      .returning({ id: documentGroups.id });
    groupId = g!.id;
  }

  await tx.insert(documentText).values({
    tenantId,
    documentId,
    matterId: input.matterId,
    groupId,
    title,
    status: scan.status === "infected" ? "blocked" : "pending",
    detail: scan.status === "infected" ? "Quarantined file: not indexed." : null,
  });

  await audit(tx, {
    tenantId,
    engine: ENGINE,
    action: group ? "document.version_added" : "document.uploaded",
    entityType: "document",
    entityId: documentId,
    matterId: input.matterId,
    actor: actorOf(viewer),
    payload: { groupId, version, sha256: check.sha256, sizeBytes: check.sizeBytes, mimeType: check.detectedMimeType, scanStatus: scan.status, storage: adapters.storage.name },
  });

  if (scan.status === "infected") {
    await audit(tx, { tenantId, engine: ENGINE, action: "document.quarantined", entityType: "document", entityId: documentId, matterId: input.matterId, payload: { scanner: adapters.scanner.name } });
    const recipients = [...new Set([...(viewer.userId ? [viewer.userId] : []), ...(await firmAdminIds(tx, tenantId))])];
    if (recipients.length) {
      await raiseFlag(tx, {
        tenantId,
        type: "document.quarantined",
        severity: "high",
        audience: "internal",
        title: "An uploaded file was quarantined by the malware scan",
        summary: "The file is stored but will not be opened, indexed or shared.",
        details: { documentId, groupId },
        matterId: input.matterId,
        recipients: { userIds: recipients },
        dedupeKey: `document.quarantined:${documentId}`,
        engine: ENGINE,
        sourceCard: "c84",
      });
    }
  }

  let textStatus = scan.status === "infected" ? "blocked" : "pending";
  if (scan.status !== "infected" && check.sizeBytes <= INLINE_INDEX_MAX_BYTES) {
    textStatus = await indexVersionText(tx, tenantId, documentId, ctx.settings, { adapters: ctx.adapters, bytes: input.bytes, now });
    if (textStatus === "skipped") textStatus = "pending";
  }

  return { created: true, documentId, groupId, version, sha256: check.sha256, scanStatus: scan.status, textStatus, warnings };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface DocumentListItem {
  groupId: string;
  documentId: string;
  title: string;
  folderId: string | null;
  documentType: string;
  version: number;
  status: string;
  privilegeTag: string;
  clientVisible: boolean;
  mimeType: string | null;
  sizeBytes: number | null;
  scanStatus: string | null;
  textStatus: string | null;
  legalHold: boolean;
  updatedAt: Date;
}

/** A matter's files (current versions). Restricted-tag files the viewer may not see are left out. Logged as 'list'. */
export async function listMatterDocuments(tx: TenantTx, ctx: Ctx, matterId: string, opts: { folderId?: string | null } = {}): Promise<DocumentListItem[]> {
  const { tenantId, viewer } = ctx;
  const m = viewer.permissions.includes("documents.read") ? decideMatter(viewer, matterId, ctx.access) : ({ allowed: false, reason: "no_permission" } as const);
  if (!m.allowed) return denyAndLog(tx, { tenantId, viewer, action: "list", matterId, reason: m.reason });
  await loadMatter(tx, tenantId, matterId);
  await provisionMatterFolders(tx, tenantId, matterId);

  const conds = [eq(documentGroups.tenantId, tenantId), eq(documentGroups.matterId, matterId), isNull(documentGroups.archivedAt)];
  if (opts.folderId !== undefined) conds.push(opts.folderId === null ? isNull(documentGroups.folderId) : eq(documentGroups.folderId, opts.folderId));
  const rows = await tx
    .select({ g: documentGroups, d: documents, f: documentVersionFiles, t: documentText.status })
    .from(documentGroups)
    .innerJoin(documents, eq(documents.id, documentGroups.currentDocumentId))
    .leftJoin(documentVersionFiles, eq(documentVersionFiles.documentId, documents.id))
    .leftJoin(documentText, eq(documentText.documentId, documents.id))
    .where(and(...conds))
    .orderBy(asc(documentGroups.title));
  const items = rows
    .filter((r) => decideDocumentAccess(viewer, "list", { matterId, privilegeTag: r.d.privilegeTag, clientVisible: r.d.clientVisible }, ctx.access).allowed)
    .map((r) => ({
      groupId: r.g.id,
      documentId: r.d.id,
      title: r.g.title,
      folderId: r.g.folderId,
      documentType: r.d.documentType,
      version: r.d.version,
      status: r.d.status,
      privilegeTag: r.d.privilegeTag,
      clientVisible: r.d.clientVisible,
      mimeType: r.d.mimeType,
      sizeBytes: r.d.sizeBytes,
      scanStatus: r.f?.scanStatus ?? null,
      textStatus: r.t ?? null,
      legalHold: r.g.legalHold,
      updatedAt: r.g.updatedAt,
    }));
  await logAccess(tx, { tenantId, viewer, action: "list", outcome: "allowed", matterId, detail: { count: items.length, folderId: opts.folderId ?? null } });
  return items;
}

async function loadVersion(tx: TenantTx, tenantId: string, documentId: string) {
  const [row] = await tx
    .select({ d: documents, f: documentVersionFiles, g: documentGroups })
    .from(documents)
    .leftJoin(documentVersionFiles, eq(documentVersionFiles.documentId, documents.id))
    .innerJoin(
      documentGroups,
      and(eq(documentGroups.tenantId, tenantId), eq(documentGroups.groupDocumentId, sql`coalesce(${documents.versionGroupId}, ${documents.id})`))
    )
    .where(and(eq(documents.tenantId, tenantId), eq(documents.id, documentId)))
    .limit(1);
  return row ?? null;
}

/** One version's metadata plus the file's full version history. Logged as 'view'. */
export async function getDocumentDetail(tx: TenantTx, ctx: Ctx, documentId: string) {
  const { tenantId, viewer } = ctx;
  const row = await loadVersion(tx, tenantId, documentId);
  if (!row) throw new NotFoundError("Document");
  const { d, f, g } = row;
  const decision = decideDocumentAccess(viewer, "view", { matterId: d.matterId, privilegeTag: d.privilegeTag, clientVisible: d.clientVisible }, ctx.access);
  if (!decision.allowed) return denyAndLog(tx, { tenantId, viewer, action: "view", documentId, groupId: g.id, matterId: d.matterId, reason: decision.reason });

  const versions = await tx
    .select({ d: documents, f: documentVersionFiles })
    .from(documents)
    .leftJoin(documentVersionFiles, eq(documentVersionFiles.documentId, documents.id))
    .where(and(eq(documents.tenantId, tenantId), inArray(documents.id, await groupMemberIds(tx, tenantId, g.groupDocumentId))))
    .orderBy(desc(documents.version));
  const [text] = await tx
    .select({ status: documentText.status, method: documentText.method, pageCount: documentText.pageCount, truncated: documentText.truncated })
    .from(documentText)
    .where(eq(documentText.documentId, d.id))
    .limit(1);
  const folder = g.folderId ? await getFolder(tx, tenantId, g.folderId) : null;
  await logAccess(tx, { tenantId, viewer, action: "view", outcome: "allowed", documentId, groupId: g.id, matterId: d.matterId });
  return {
    groupId: g.id,
    title: g.title,
    matterId: d.matterId,
    folder: folder ? { id: folder.id, name: folder.name, key: folder.templateKey } : null,
    legalHold: g.legalHold,
    legalHoldReason: g.legalHoldReason,
    originalHeld: g.originalHeld,
    currentDocumentId: g.currentDocumentId,
    document: {
      id: d.id,
      version: d.version,
      name: d.name,
      documentType: d.documentType,
      status: d.status,
      privilegeTag: d.privilegeTag,
      clientVisible: d.clientVisible,
      mimeType: d.mimeType,
      sizeBytes: d.sizeBytes,
      sha256: d.sha256,
      createdAt: d.createdAt,
      uploadedByUserId: d.uploadedByUserId,
      scanStatus: f?.scanStatus ?? null,
      encryption: f?.encryption ?? null,
      text: text ?? null,
    },
    versions: versions.map((v) => ({
      id: v.d.id,
      version: v.d.version,
      status: v.d.status,
      name: v.d.name,
      sha256: v.d.sha256,
      sizeBytes: v.d.sizeBytes,
      createdAt: v.d.createdAt,
      uploadedByUserId: v.d.uploadedByUserId,
      scanStatus: v.f?.scanStatus ?? null,
      isCurrent: v.d.id === g.currentDocumentId,
    })),
  };
}

async function groupMemberIds(tx: TenantTx, tenantId: string, groupDocumentId: string): Promise<string[]> {
  const rows = await tx
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.tenantId, tenantId), eq(documents.versionGroupId, groupDocumentId)));
  return [groupDocumentId, ...rows.map((r) => r.id)];
}

/**
 * The bytes of one version, checksum-verified. Logged as 'download' (or a
 * denial). A checksum mismatch is never served: it is logged and audited.
 */
export async function downloadDocument(tx: TenantTx, ctx: Ctx, documentId: string): Promise<{ bytes: Uint8Array; filename: string; mimeType: string; sha256: string; scanStatus: string }> {
  const { tenantId, viewer } = ctx;
  const row = await loadVersion(tx, tenantId, documentId);
  if (!row || !row.f) throw new NotFoundError("Document");
  const { d, f, g } = row;
  const decision = decideDocumentAccess(
    viewer,
    "download",
    { matterId: d.matterId, privilegeTag: d.privilegeTag, clientVisible: d.clientVisible, scanStatus: f.scanStatus },
    ctx.access
  );
  if (!decision.allowed) return denyAndLog(tx, { tenantId, viewer, action: "download", documentId, groupId: g.id, matterId: d.matterId, reason: decision.reason });

  const adapters = gatedAdapters(tenantId, ctx.adapters);
  const bytes = await adapters.storage.get(f.storageKey);
  if (!checksumsMatch(sha256Hex(bytes), f.sha256)) {
    await audit(tx, { tenantId, engine: ENGINE, action: "document.integrity_failed", entityType: "document", entityId: d.id, matterId: d.matterId, payload: { storage: f.storageAdapter } });
    return denyAndLog(tx, { tenantId, viewer, action: "download", documentId, groupId: g.id, matterId: d.matterId, reason: "integrity_failed" });
  }
  await tx.update(documentVersionFiles).set({ lastVerifiedAt: ctx.now ?? new Date() }).where(eq(documentVersionFiles.id, f.id));
  await logAccess(tx, { tenantId, viewer, action: "download", outcome: "allowed", documentId, groupId: g.id, matterId: d.matterId, detail: { bytes: bytes.length, scanStatus: f.scanStatus } });
  return { bytes, filename: d.name ?? f.originalFilename ?? "document", mimeType: d.mimeType ?? "application/octet-stream", sha256: f.sha256, scanStatus: f.scanStatus };
}

// ---------------------------------------------------------------------------
// Changing a file's placement and tags
// ---------------------------------------------------------------------------

export interface GroupPatch {
  title?: string;
  folderId?: string | null;
  privilegeTag?: string;
  clientVisible?: boolean;
  legalHold?: { on: boolean; reason?: string | null };
  originalHeld?: boolean;
  archived?: boolean;
}

/**
 * Move / rename / tag a file. Rules:
 * - documents.write for everything;
 * - making a file client-visible, lifting 'sealed', and setting or releasing a
 *   legal hold need documents.approve (attorney-only, c34);
 * - tags apply to the CURRENT version row (older versions keep theirs: history is not rewritten).
 */
export async function updateDocumentGroup(tx: TenantTx, ctx: Ctx, groupId: string, patch: GroupPatch) {
  const { tenantId, viewer } = ctx;
  const [g] = await tx
    .select()
    .from(documentGroups)
    .where(and(eq(documentGroups.tenantId, tenantId), eq(documentGroups.id, groupId)))
    .for("update")
    .limit(1);
  if (!g) throw new NotFoundError("Document");
  const [cur] = await tx.select().from(documents).where(eq(documents.id, g.currentDocumentId)).limit(1);
  if (!cur) throw new NotFoundError("Document");
  const decision = decideDocumentAccess(viewer, "edit", { matterId: g.matterId, privilegeTag: cur.privilegeTag, clientVisible: cur.clientVisible }, ctx.access);
  if (!decision.allowed) throw new DocumentError("You cannot change this document.", 403, { reason: decision.reason });
  const approve = viewer.permissions.includes("documents.approve");
  const now = ctx.now ?? new Date();

  const groupSet: Partial<typeof documentGroups.$inferInsert> = {};
  const docSet: Partial<typeof documents.$inferInsert> = {};
  const changes: Record<string, unknown> = {};

  if (patch.title !== undefined) {
    if (!patch.title.trim()) throw new DocumentError("Title cannot be empty.");
    groupSet.title = patch.title.trim().slice(0, 300);
    changes.title = groupSet.title;
  }
  if (patch.folderId !== undefined) {
    if (patch.folderId) {
      const [folder] = await tx.select().from(documentFolders).where(and(eq(documentFolders.tenantId, tenantId), eq(documentFolders.id, patch.folderId))).limit(1);
      if (!folder || folder.matterId !== g.matterId || folder.archivedAt) throw new NotFoundError("Folder");
    }
    groupSet.folderId = patch.folderId;
    changes.folderId = patch.folderId;
  }
  if (patch.privilegeTag !== undefined) {
    if (!isPrivilegeTag(patch.privilegeTag)) throw new DocumentError(`Unknown privilege tag '${patch.privilegeTag}'.`);
    if (cur.privilegeTag === "sealed" && patch.privilegeTag !== "sealed" && !approve) throw new DocumentError("Only an attorney can lift 'sealed'.", 403);
    const roles = ctx.access.restrictedTags[patch.privilegeTag];
    if (roles && !roles.includes(viewer.role)) throw new DocumentError(`You cannot tag a document '${patch.privilegeTag}'.`, 403);
    docSet.privilegeTag = patch.privilegeTag;
    changes.privilegeTag = patch.privilegeTag;
  }
  if (patch.clientVisible !== undefined) {
    if (patch.clientVisible && !approve) throw new DocumentError("Only an attorney can share a document with the client.", 403);
    const tag = docSet.privilegeTag ?? cur.privilegeTag;
    if (patch.clientVisible && !(tag === "none" || tag === "confidential")) {
      throw new DocumentError(`A '${tag}' document cannot be shared with the client; change the tag first.`, 409);
    }
    docSet.clientVisible = patch.clientVisible;
    changes.clientVisible = patch.clientVisible;
  }
  if (patch.legalHold !== undefined) {
    if (!approve) throw new DocumentError("Only an attorney can set or release a legal hold.", 403);
    if (patch.legalHold.on && !patch.legalHold.reason?.trim()) throw new DocumentError("A legal hold needs a reason.");
    groupSet.legalHold = patch.legalHold.on;
    groupSet.legalHoldReason = patch.legalHold.on ? patch.legalHold.reason!.trim() : null;
    changes.legalHold = patch.legalHold;
  }
  if (patch.originalHeld !== undefined) {
    groupSet.originalHeld = patch.originalHeld;
    changes.originalHeld = patch.originalHeld;
  }
  if (patch.archived !== undefined) {
    if (patch.archived && g.legalHold && groupSet.legalHold !== false) throw new DocumentError("A document on legal hold cannot be archived.", 409);
    groupSet.archivedAt = patch.archived ? now : null;
    changes.archived = patch.archived;
  }
  if (Object.keys(changes).length === 0) return { groupId, changed: false };

  if (Object.keys(groupSet).length) await tx.update(documentGroups).set({ ...groupSet, updatedAt: now }).where(eq(documentGroups.id, g.id));
  if (Object.keys(docSet).length) await tx.update(documents).set({ ...docSet, updatedAt: now }).where(eq(documents.id, cur.id));
  if (groupSet.title) await tx.update(documentText).set({ title: groupSet.title }).where(eq(documentText.groupId, g.id));
  await audit(tx, {
    tenantId,
    engine: ENGINE,
    action: "document.updated",
    entityType: "document_group",
    entityId: g.id,
    matterId: g.matterId,
    actor: actorOf(viewer),
    reason: patch.legalHold?.reason ?? null,
    payload: { documentId: cur.id, changes },
  });
  return { groupId, changed: true, changes };
}
