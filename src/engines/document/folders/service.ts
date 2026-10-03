// Folder templates and matter folders (c84), database side.

import { and, asc, desc, eq, isNull, max, notExists, sql } from "drizzle-orm";
import { matters } from "@/db/schema";
import { documentFolderTemplates, documentFolders } from "@/db/tables/document";
import { audit, isPracticeAreaId } from "@/core";
import type { TenantTx } from "@/tenancy/withTenant";
import { DocumentError, NotFoundError } from "../errors";
import { ENGINE } from "../settings";
import { actorOf } from "../access/service";
import { decideMatter, type AccessContext, type StaffViewer } from "../access/policy";
import { isPrivilegeTag } from "@/core/documents";
import { folderNameProblems, missingFolders, normalizeFolderName, pickTemplate, planFolders, validateFolderTemplate } from "./template";

function requireTemplateManager(viewer: StaffViewer): void {
  if (!viewer.permissions.includes("settings.manage") && viewer.role !== "attorney") {
    throw new DocumentError("Only a firm admin or an attorney can manage folder templates.", 403);
  }
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export async function listFolderTemplates(tx: TenantTx, tenantId: string) {
  return tx
    .select()
    .from(documentFolderTemplates)
    .where(eq(documentFolderTemplates.tenantId, tenantId))
    .orderBy(asc(documentFolderTemplates.practiceArea), desc(documentFolderTemplates.version));
}

/** Save a new DRAFT template version. Existing matters are never changed by a template edit. */
export async function createFolderTemplate(
  tx: TenantTx,
  tenantId: string,
  by: StaffViewer,
  input: { name: string; practiceArea: string | null; folders: unknown }
) {
  requireTemplateManager(by);
  if (!input.name?.trim()) throw new DocumentError("Template name is required.");
  if (input.practiceArea !== null && !isPracticeAreaId(input.practiceArea)) throw new DocumentError(`Unknown practice area '${input.practiceArea}'.`);
  const v = validateFolderTemplate(input.folders);
  if (!v.ok) throw new DocumentError("The folder template has problems.", 422, { errors: v.errors });
  const area = input.practiceArea;
  const [prev] = await tx
    .select({ v: max(documentFolderTemplates.version) })
    .from(documentFolderTemplates)
    .where(
      and(
        eq(documentFolderTemplates.tenantId, tenantId),
        area === null ? isNull(documentFolderTemplates.practiceArea) : eq(documentFolderTemplates.practiceArea, area)
      )
    );
  const [row] = await tx
    .insert(documentFolderTemplates)
    .values({
      tenantId,
      name: input.name.trim(),
      practiceArea: area,
      version: (prev?.v ?? 0) + 1,
      status: "draft",
      folders: v.normalized,
      createdByUserId: by.userId,
    })
    .returning();
  await audit(tx, {
    tenantId,
    engine: ENGINE,
    action: "folder_template.created",
    entityType: "document_folder_template",
    entityId: row!.id,
    actor: actorOf(by),
    payload: { practiceArea: area, version: row!.version },
  });
  return row!;
}

/** Make a draft the active template for its practice area (the previous active one is retired). */
export async function activateFolderTemplate(tx: TenantTx, tenantId: string, by: StaffViewer, templateId: string) {
  requireTemplateManager(by);
  const [t] = await tx
    .select()
    .from(documentFolderTemplates)
    .where(and(eq(documentFolderTemplates.tenantId, tenantId), eq(documentFolderTemplates.id, templateId)))
    .for("update")
    .limit(1);
  if (!t) throw new NotFoundError("Folder template");
  if (t.status !== "draft") throw new DocumentError(`Only a draft template can be activated (this one is ${t.status}).`, 409);
  const now = new Date();
  await tx
    .update(documentFolderTemplates)
    .set({ status: "retired", retiredAt: now })
    .where(
      and(
        eq(documentFolderTemplates.tenantId, tenantId),
        eq(documentFolderTemplates.status, "active"),
        t.practiceArea === null ? isNull(documentFolderTemplates.practiceArea) : eq(documentFolderTemplates.practiceArea, t.practiceArea)
      )
    );
  const [row] = await tx
    .update(documentFolderTemplates)
    .set({ status: "active", activatedAt: now, activatedByUserId: by.userId })
    .where(eq(documentFolderTemplates.id, t.id))
    .returning();
  await audit(tx, {
    tenantId,
    engine: ENGINE,
    action: "folder_template.activated",
    entityType: "document_folder_template",
    entityId: t.id,
    actor: actorOf(by),
    payload: { practiceArea: t.practiceArea, version: t.version },
  });
  return row!;
}

export async function retireFolderTemplate(tx: TenantTx, tenantId: string, by: StaffViewer, templateId: string) {
  requireTemplateManager(by);
  const [row] = await tx
    .update(documentFolderTemplates)
    .set({ status: "retired", retiredAt: new Date() })
    .where(and(eq(documentFolderTemplates.tenantId, tenantId), eq(documentFolderTemplates.id, templateId)))
    .returning();
  if (!row) throw new NotFoundError("Folder template");
  await audit(tx, {
    tenantId,
    engine: ENGINE,
    action: "folder_template.retired",
    entityType: "document_folder_template",
    entityId: row.id,
    actor: actorOf(by),
  });
  return row;
}

// ---------------------------------------------------------------------------
// Matter folders
// ---------------------------------------------------------------------------

export type FolderRow = typeof documentFolders.$inferSelect;

/**
 * Create any template folders the matter is missing. Idempotent: safe to
 * call on every matter open, on every listing, and from the worker.
 */
export async function provisionMatterFolders(tx: TenantTx, tenantId: string, matterId: string): Promise<{ created: number; source: string }> {
  const [matter] = await tx
    .select({ id: matters.id, practiceArea: matters.practiceArea })
    .from(matters)
    .where(and(eq(matters.tenantId, tenantId), eq(matters.id, matterId)))
    .limit(1);
  if (!matter) throw new NotFoundError("Matter");
  const templates = await tx
    .select()
    .from(documentFolderTemplates)
    .where(and(eq(documentFolderTemplates.tenantId, tenantId), eq(documentFolderTemplates.status, "active")));
  const picked = pickTemplate(templates, matter.practiceArea);
  const plan = planFolders(picked.folders);
  const existing = await tx
    .select({ id: documentFolders.id, templateKey: documentFolders.templateKey, normalizedName: documentFolders.normalizedName, parentId: documentFolders.parentId })
    .from(documentFolders)
    .where(and(eq(documentFolders.tenantId, tenantId), eq(documentFolders.matterId, matterId), isNull(documentFolders.archivedAt)));
  const todo = missingFolders(plan, existing);
  if (todo.length === 0) return { created: 0, source: picked.source };

  const idByKey = new Map(existing.filter((f) => f.templateKey).map((f) => [f.templateKey!, f.id]));
  let created = 0;
  for (const p of todo) {
    const parentId = p.parentKey ? (idByKey.get(p.parentKey) ?? null) : null;
    if (p.parentKey && !parentId) continue; // parent was archived by the firm: do not resurrect its children
    // A firm user may already have made a folder with this name by hand: adopt it instead of failing.
    const clash = existing.find((f) => f.normalizedName === p.normalizedName && f.parentId === parentId && !f.templateKey);
    if (clash) {
      await tx.update(documentFolders).set({ templateKey: p.key }).where(eq(documentFolders.id, clash.id));
      idByKey.set(p.key, clash.id);
      continue;
    }
    const [row] = await tx
      .insert(documentFolders)
      .values({
        tenantId,
        matterId,
        parentId,
        name: p.name,
        normalizedName: p.normalizedName,
        templateKey: p.key,
        templateId: picked.templateId,
        defaultPrivilegeTag: p.defaultPrivilegeTag,
        position: p.position,
      })
      .onConflictDoNothing()
      .returning({ id: documentFolders.id });
    if (row) {
      idByKey.set(p.key, row.id);
      created++;
    }
  }
  if (created > 0) {
    await audit(tx, {
      tenantId,
      engine: ENGINE,
      action: "folders.provisioned",
      entityType: "matter",
      entityId: matterId,
      matterId,
      payload: { created, source: picked.source, templateId: picked.templateId },
    });
  }
  return { created, source: picked.source };
}

/** Matters with no folders yet (worker batch). */
export async function mattersWithoutFolders(tx: TenantTx, tenantId: string, limit: number): Promise<string[]> {
  const rows = await tx
    .select({ id: matters.id })
    .from(matters)
    .where(
      and(
        eq(matters.tenantId, tenantId),
        sql`${matters.stage} <> 'closed'`,
        notExists(
          tx
            .select({ one: sql`1` })
            .from(documentFolders)
            .where(and(eq(documentFolders.tenantId, tenantId), eq(documentFolders.matterId, matters.id)))
        )
      )
    )
    .orderBy(desc(matters.openedAt))
    .limit(limit);
  return rows.map((r) => r.id);
}

export async function listMatterFolders(tx: TenantTx, tenantId: string, matterId: string, opts: { includeArchived?: boolean } = {}) {
  const conds = [eq(documentFolders.tenantId, tenantId), eq(documentFolders.matterId, matterId)];
  if (!opts.includeArchived) conds.push(isNull(documentFolders.archivedAt));
  return tx.select().from(documentFolders).where(and(...conds)).orderBy(asc(documentFolders.position), asc(documentFolders.name));
}

export async function getFolder(tx: TenantTx, tenantId: string, folderId: string): Promise<FolderRow | null> {
  const [row] = await tx
    .select()
    .from(documentFolders)
    .where(and(eq(documentFolders.tenantId, tenantId), eq(documentFolders.id, folderId)))
    .limit(1);
  return row ?? null;
}

/** Look a matter's folder up by template key ('email', 'client_uploads' …) — the hand-off point for other cards. */
export async function folderByKey(tx: TenantTx, tenantId: string, matterId: string, key: string): Promise<FolderRow | null> {
  const [row] = await tx
    .select()
    .from(documentFolders)
    .where(
      and(
        eq(documentFolders.tenantId, tenantId),
        eq(documentFolders.matterId, matterId),
        eq(documentFolders.templateKey, key),
        isNull(documentFolders.archivedAt)
      )
    )
    .limit(1);
  return row ?? null;
}

export async function createFolder(
  tx: TenantTx,
  tenantId: string,
  by: StaffViewer,
  access: AccessContext,
  input: { matterId: string; parentId: string | null; name: string; defaultPrivilegeTag?: string | null }
) {
  if (!by.permissions.includes("documents.write")) throw new DocumentError("You cannot create folders.", 403);
  const m = decideMatter(by, input.matterId, access);
  if (!m.allowed) throw new DocumentError("You do not have access to this matter.", 403, { reason: m.reason });
  const problems = folderNameProblems(input.name);
  if (problems.length) throw new DocumentError(problems.join(" "));
  const tag = input.defaultPrivilegeTag ?? "none";
  if (!isPrivilegeTag(tag)) throw new DocumentError(`Unknown privilege tag '${tag}'.`);
  if (input.parentId) {
    const parent = await getFolder(tx, tenantId, input.parentId);
    if (!parent || parent.matterId !== input.matterId || parent.archivedAt) throw new NotFoundError("Parent folder");
  }
  const name = input.name.trim().replace(/\s+/g, " ");
  const [row] = await tx
    .insert(documentFolders)
    .values({
      tenantId,
      matterId: input.matterId,
      parentId: input.parentId,
      name,
      normalizedName: normalizeFolderName(name),
      defaultPrivilegeTag: tag,
      position: 1000,
      createdByUserId: by.userId,
    })
    .onConflictDoNothing()
    .returning();
  if (!row) throw new DocumentError(`A folder called '${name}' already exists here.`, 409);
  await audit(tx, {
    tenantId,
    engine: ENGINE,
    action: "folder.created",
    entityType: "document_folder",
    entityId: row.id,
    matterId: input.matterId,
    actor: actorOf(by),
    payload: { name, parentId: input.parentId },
  });
  return row;
}

/** Rename or archive a folder. Folders are archived, never deleted; template folders cannot be archived. */
export async function updateFolder(
  tx: TenantTx,
  tenantId: string,
  by: StaffViewer,
  access: AccessContext,
  folderId: string,
  patch: { name?: string; archived?: boolean }
) {
  if (!by.permissions.includes("documents.write")) throw new DocumentError("You cannot change folders.", 403);
  const folder = await getFolder(tx, tenantId, folderId);
  if (!folder) throw new NotFoundError("Folder");
  const m = decideMatter(by, folder.matterId, access);
  if (!m.allowed) throw new DocumentError("You do not have access to this matter.", 403, { reason: m.reason });
  const set: Partial<typeof documentFolders.$inferInsert> = {};
  if (patch.name !== undefined) {
    const problems = folderNameProblems(patch.name);
    if (problems.length) throw new DocumentError(problems.join(" "));
    set.name = patch.name.trim().replace(/\s+/g, " ");
    set.normalizedName = normalizeFolderName(patch.name);
  }
  if (patch.archived === true) {
    if (folder.templateKey) throw new DocumentError("Folders from the firm's template cannot be archived; rename it instead.", 409);
    set.archivedAt = new Date();
  }
  if (Object.keys(set).length === 0) return folder;
  let row: FolderRow | undefined;
  try {
    [row] = await tx.update(documentFolders).set(set).where(eq(documentFolders.id, folder.id)).returning();
  } catch (err) {
    if (String((err as { code?: string }).code) === "23505") throw new DocumentError("A folder with that name already exists here.", 409);
    throw err;
  }
  await audit(tx, {
    tenantId,
    engine: ENGINE,
    action: patch.archived ? "folder.archived" : "folder.renamed",
    entityType: "document_folder",
    entityId: folder.id,
    matterId: folder.matterId,
    actor: actorOf(by),
    payload: { from: folder.name, to: set.name ?? folder.name },
  });
  return row!;
}
