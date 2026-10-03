// Database side of document access (c84): loading a viewer's access context
// (screens + matter scope via pluggable hooks), the local screens mirror
// (document_access_blocks), and the append-only access log.

import { and, desc, eq, isNull } from "drizzle-orm";
import { matters, users } from "@/db/schema";
import { documentAccessBlocks, documentAccessLog } from "@/db/tables/document";
import { audit, getFirmSettings, type Actor } from "@/core";
import type { TenantTx } from "@/tenancy/withTenant";
import { DocumentAccessDeniedError, DocumentError, NotFoundError } from "../errors";
import { ENGINE, readDocumentSettings, type DocumentSettings } from "../settings";
import {
  collectScope,
  collectScreens,
  type AccessContext,
  type DenialReason,
  type DocumentViewer,
  type MatterScopeSource,
  type ScreenSource,
  type StaffViewer,
} from "./policy";

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/** Default screen source: this engine's own mirror table. */
export const localBlocksScreenSource: ScreenSource = {
  name: "document_access_blocks",
  async screenedMatterIds(tx, tenantId, userId) {
    const rows = await tx
      .select({ matterId: documentAccessBlocks.matterId })
      .from(documentAccessBlocks)
      .where(and(eq(documentAccessBlocks.tenantId, tenantId), eq(documentAccessBlocks.userId, userId), isNull(documentAccessBlocks.endedAt)));
    return new Set(rows.map((r) => r.matterId));
  },
};

let screenSources: ScreenSource[] = [localBlocksScreenSource];
let scopeSources: MatterScopeSource[] = [];

/**
 * Plug in extra access sources (integration step / tests): e.g. a source
 * reading a shared screens table once the foundation adds one, or a c99
 * matter-scope source. The local mirror is always kept unless
 * `replaceDefaults` is set.
 */
export function setAccessHooks(next: { screens?: ScreenSource[]; scopes?: MatterScopeSource[]; replaceDefaults?: boolean } | null): void {
  if (next === null) {
    screenSources = [localBlocksScreenSource];
    scopeSources = [];
    return;
  }
  if (next.screens) screenSources = next.replaceDefaults ? [...next.screens] : [localBlocksScreenSource, ...next.screens];
  if (next.scopes) scopeSources = [...next.scopes];
}

export function accessHookNames(): { screens: string[]; scopes: string[] } {
  return { screens: screenSources.map((s) => s.name), scopes: scopeSources.map((s) => s.name) };
}

export interface LoadedAccess {
  settings: DocumentSettings;
  access: AccessContext;
}

/** Settings + the viewer's screens/scope, loaded once per request. */
export async function loadAccess(tx: TenantTx, tenantId: string, viewer: DocumentViewer): Promise<LoadedAccess> {
  const settings = readDocumentSettings(await getFirmSettings(tx, tenantId));
  const staff = viewer.kind === "staff" ? viewer : null;
  return {
    settings,
    access: {
      screenedMatterIds: staff ? await collectScreens(screenSources, tx, tenantId, staff.userId) : new Set(),
      allowedMatterIds: staff ? await collectScope(scopeSources, tx, tenantId, staff) : null,
      restrictedTags: settings.restrictedTags,
      staffMayDownloadUnscanned: settings.staffMayDownloadUnscanned,
    },
  };
}

export function actorOf(viewer: DocumentViewer): Actor {
  if (viewer.kind === "client") return { type: "client", partyId: viewer.partyId };
  return viewer.userId ? { type: "user", userId: viewer.userId } : { type: "system" };
}

// ---------------------------------------------------------------------------
// Access log
// ---------------------------------------------------------------------------

export type LoggedAction = "view" | "download" | "list" | "search" | "version_history";

export interface AccessLogInput {
  tenantId: string;
  viewer: DocumentViewer;
  action: LoggedAction;
  outcome: "allowed" | "denied";
  reason?: DenialReason | string | null;
  documentId?: string | null;
  groupId?: string | null;
  matterId?: string | null;
  detail?: Record<string, unknown>;
}

/** Pure: shape one access-log row. */
export function buildAccessLogRow(input: AccessLogInput): typeof documentAccessLog.$inferInsert {
  if (input.outcome === "denied" && !input.reason) throw new Error("A denied access needs a reason.");
  const v = input.viewer;
  return {
    tenantId: input.tenantId,
    documentId: input.documentId ?? null,
    groupId: input.groupId ?? null,
    matterId: input.matterId ?? null,
    actorType: v.kind === "client" ? "client" : v.userId ? "user" : "system",
    actorUserId: v.kind === "staff" ? v.userId : null,
    actorPartyId: v.kind === "client" ? v.partyId : null,
    action: input.action,
    outcome: input.outcome,
    reason: input.reason ?? null,
    detail: input.detail ?? {},
  };
}

/** Append one row (the table is INSERT/SELECT only for the app role). */
export async function logAccess(tx: TenantTx, input: AccessLogInput): Promise<void> {
  await tx.insert(documentAccessLog).values(buildAccessLogRow(input));
}

/** Log a denial and throw. Callers' routes commit the transaction so the row survives. */
export async function denyAndLog(tx: TenantTx, input: Omit<AccessLogInput, "outcome"> & { reason: DenialReason }): Promise<never> {
  await logAccess(tx, { ...input, outcome: "denied" });
  throw new DocumentAccessDeniedError(input.reason);
}

export async function listAccessLog(
  tx: TenantTx,
  tenantId: string,
  filter: { documentId?: string; groupId?: string; matterId?: string; limit?: number }
) {
  const conds = [eq(documentAccessLog.tenantId, tenantId)];
  if (filter.documentId) conds.push(eq(documentAccessLog.documentId, filter.documentId));
  if (filter.groupId) conds.push(eq(documentAccessLog.groupId, filter.groupId));
  if (filter.matterId) conds.push(eq(documentAccessLog.matterId, filter.matterId));
  return tx
    .select()
    .from(documentAccessLog)
    .where(and(...conds))
    .orderBy(desc(documentAccessLog.occurredAt))
    .limit(Math.min(Math.max(filter.limit ?? 200, 1), 1000));
}

// ---------------------------------------------------------------------------
// Screens mirror (document_access_blocks)
// ---------------------------------------------------------------------------

const BLOCK_REASONS = ["ethical_screen", "restricted", "other"] as const;
export type BlockReason = (typeof BLOCK_REASONS)[number];

function requireAdminOrAttorney(viewer: StaffViewer): void {
  if (!(viewer.role === "firm_admin" || viewer.role === "attorney") || !viewer.permissions.includes("documents.write")) {
    throw new DocumentError("Only a firm admin or an attorney can change document screens.", 403);
  }
}

export async function addAccessBlock(
  tx: TenantTx,
  tenantId: string,
  by: StaffViewer,
  input: { userId: string; matterId: string; reason: string; note?: string | null; source?: "manual" | "sync"; sourceRef?: string | null }
) {
  requireAdminOrAttorney(by);
  if (!(BLOCK_REASONS as readonly string[]).includes(input.reason)) throw new DocumentError(`Reason must be one of ${BLOCK_REASONS.join(", ")}.`);
  const [user] = await tx.select({ id: users.id }).from(users).where(and(eq(users.tenantId, tenantId), eq(users.id, input.userId))).limit(1);
  if (!user) throw new NotFoundError("User");
  const [matter] = await tx.select({ id: matters.id }).from(matters).where(and(eq(matters.tenantId, tenantId), eq(matters.id, input.matterId))).limit(1);
  if (!matter) throw new NotFoundError("Matter");
  const [existing] = await tx
    .select()
    .from(documentAccessBlocks)
    .where(
      and(
        eq(documentAccessBlocks.tenantId, tenantId),
        eq(documentAccessBlocks.userId, input.userId),
        eq(documentAccessBlocks.matterId, input.matterId),
        isNull(documentAccessBlocks.endedAt)
      )
    )
    .limit(1);
  if (existing) return { block: existing, created: false };
  const [block] = await tx
    .insert(documentAccessBlocks)
    .values({
      tenantId,
      userId: input.userId,
      matterId: input.matterId,
      reason: input.reason,
      note: input.note ?? null,
      source: input.source ?? "manual",
      sourceRef: input.sourceRef ?? null,
      createdByUserId: by.userId,
    })
    .returning();
  await audit(tx, {
    tenantId,
    engine: ENGINE,
    action: "screen.added",
    entityType: "document_access_block",
    entityId: block!.id,
    matterId: input.matterId,
    actor: actorOf(by),
    payload: { userId: input.userId, reason: input.reason, source: input.source ?? "manual" },
  });
  return { block: block!, created: true };
}

export async function endAccessBlock(tx: TenantTx, tenantId: string, by: StaffViewer, blockId: string, reason: string) {
  requireAdminOrAttorney(by);
  if (!reason.trim()) throw new DocumentError("A reason is required to end a screen.");
  const [row] = await tx
    .update(documentAccessBlocks)
    .set({ endedAt: new Date(), endedByUserId: by.userId, endedReason: reason.trim() })
    .where(and(eq(documentAccessBlocks.tenantId, tenantId), eq(documentAccessBlocks.id, blockId), isNull(documentAccessBlocks.endedAt)))
    .returning();
  if (!row) throw new NotFoundError("Active screen");
  await audit(tx, {
    tenantId,
    engine: ENGINE,
    action: "screen.ended",
    entityType: "document_access_block",
    entityId: row.id,
    matterId: row.matterId,
    actor: actorOf(by),
    reason: reason.trim(),
    payload: { userId: row.userId },
  });
  return row;
}

export async function listAccessBlocks(tx: TenantTx, tenantId: string, opts: { includeEnded?: boolean } = {}) {
  const conds = [eq(documentAccessBlocks.tenantId, tenantId)];
  if (!opts.includeEnded) conds.push(isNull(documentAccessBlocks.endedAt));
  return tx.select().from(documentAccessBlocks).where(and(...conds)).orderBy(desc(documentAccessBlocks.createdAt));
}
