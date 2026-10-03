// Who may see which document (c84). Pure decision logic plus the HOOK types
// that feed it.
//
// Order of checks (first failure wins, and is logged as the denial reason):
//   1. permission    — staff need documents.read to see, documents.write to change (c34 RBAC)
//   2. matter scope  — optional allow-list of matters (c99 matter-level access, when it exists)
//   3. screen        — an ethical screen (c60) on this user + matter beats every role, firm admin included
//   4. restricted tag— e.g. 'sealed' only for the roles the firm lists (firm setting)
//   5. bytes safety  — infected / unscanned / still-scanning files are not served
//
// Screens live in the conflict-check engine's world, which this engine may
// not import. So screens arrive through a ScreenSource: the default reads
// this engine's own mirror table (document_access_blocks); a shared screens
// table, or a predicate injected by the integrator, can be plugged in with
// setAccessHooks() without changing any caller. Sources are combined with
// UNION — any source that says "screened" wins.

import type { TenantTx } from "@/tenancy/withTenant";
import type { PrivilegeTag } from "@/core/documents";

/** A firm user (from the c34 Principal; structurally compatible). */
export interface StaffViewer {
  kind: "staff";
  /** null only for the synthetic dev principal (no users row). */
  userId: string | null;
  role: string;
  permissions: readonly string[];
}

/** A client in the portal (c11/c89). Only matters the client is a party to. */
export interface ClientViewer {
  kind: "client";
  partyId: string;
  matterIds: readonly string[];
}

export type DocumentViewer = StaffViewer | ClientViewer;

export type DocumentAction = "list" | "view" | "download" | "search" | "version_history" | "upload" | "edit";

const READ_ACTIONS: ReadonlySet<DocumentAction> = new Set(["list", "view", "download", "search", "version_history"]);

export interface DocumentFacts {
  matterId: string;
  privilegeTag: string;
  clientVisible: boolean;
  /** Malware-scan status of the bytes; only consulted for 'download'. */
  scanStatus?: string | null;
}

export interface AccessContext {
  /** Matters this viewer is screened from (union of every ScreenSource). */
  screenedMatterIds: ReadonlySet<string>;
  /** null = no matter-level restriction; otherwise the only matters the viewer may see. */
  allowedMatterIds: ReadonlySet<string> | null;
  restrictedTags: Partial<Record<PrivilegeTag, readonly string[]>>;
  staffMayDownloadUnscanned: boolean;
}

export type DenialReason =
  | "no_permission"
  | "outside_matter_scope"
  | "screened"
  | "restricted_tag"
  | "not_client_visible"
  | "quarantined"
  | "scan_pending"
  | "not_scanned"
  /** Stored bytes no longer match their checksum (never served). */
  | "integrity_failed";

export type AccessDecision = { allowed: true } | { allowed: false; reason: DenialReason };

const ALLOW: AccessDecision = Object.freeze({ allowed: true });
const deny = (reason: DenialReason): AccessDecision => ({ allowed: false, reason });

/** Pure: may this viewer do `action` to this document? */
export function decideDocumentAccess(viewer: DocumentViewer, action: DocumentAction, doc: DocumentFacts, ctx: AccessContext): AccessDecision {
  if (viewer.kind === "client") return decideClient(viewer, action, doc);

  const needed = READ_ACTIONS.has(action) ? "documents.read" : "documents.write";
  if (!viewer.permissions.includes(needed)) return deny("no_permission");
  const matter = decideMatter(viewer, doc.matterId, ctx);
  if (!matter.allowed) return matter;
  const roles = ctx.restrictedTags[doc.privilegeTag as PrivilegeTag];
  if (roles && !roles.includes(viewer.role)) return deny("restricted_tag");
  if (action === "download") return decideBytes(doc.scanStatus ?? null, ctx.staffMayDownloadUnscanned);
  return ALLOW;
}

/** Pure: matter-level part only (for listing a matter or scoping a search). */
export function decideMatter(viewer: StaffViewer, matterId: string, ctx: AccessContext): AccessDecision {
  if (ctx.allowedMatterIds && !ctx.allowedMatterIds.has(matterId)) return deny("outside_matter_scope");
  if (viewer.userId && ctx.screenedMatterIds.has(matterId)) return deny("screened");
  return ALLOW;
}

function decideBytes(scanStatus: string | null, unscannedOk: boolean): AccessDecision {
  if (scanStatus === "clean") return ALLOW;
  if (scanStatus === "infected") return deny("quarantined");
  if (scanStatus === "not_scanned") return unscannedOk ? ALLOW : deny("not_scanned");
  return deny("scan_pending"); // 'pending', 'error', missing
}

function decideClient(viewer: ClientViewer, action: DocumentAction, doc: DocumentFacts): AccessDecision {
  if (!READ_ACTIONS.has(action) || action === "search") return deny("no_permission");
  if (!viewer.matterIds.includes(doc.matterId)) return deny("outside_matter_scope");
  // Same rule as clientShareableDocuments() in src/core/documents.ts.
  if (!doc.clientVisible || !(doc.privilegeTag === "none" || doc.privilegeTag === "confidential")) return deny("not_client_visible");
  if (action === "download") return decideBytes(doc.scanStatus ?? null, false); // clients never get unscanned files
  return ALLOW;
}

/** Tags a staff role may NOT see — used to filter searches in SQL. Pure. */
export function hiddenTagsForRole(role: string, restrictedTags: AccessContext["restrictedTags"]): string[] {
  return Object.entries(restrictedTags)
    .filter(([, roles]) => roles && !roles.includes(role))
    .map(([tag]) => tag)
    .sort();
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/** Where screens come from. Return the matter ids `userId` is screened from. */
export interface ScreenSource {
  readonly name: string;
  screenedMatterIds(tx: TenantTx, tenantId: string, userId: string): Promise<ReadonlySet<string>>;
}

/**
 * Optional matter-level scope (c99). Return null for "every matter in the
 * firm", or the set of matters the user may see.
 */
export interface MatterScopeSource {
  readonly name: string;
  allowedMatterIds(tx: TenantTx, tenantId: string, viewer: StaffViewer): Promise<ReadonlySet<string> | null>;
}

/** Wrap a plain predicate ("is this user screened from this matter?") as a ScreenSource over a candidate list. */
export function predicateScreenSource(
  name: string,
  listScreened: (tenantId: string, userId: string) => Promise<Iterable<string>>
): ScreenSource {
  return {
    name,
    screenedMatterIds: async (_tx, tenantId, userId) => new Set(await listScreened(tenantId, userId)),
  };
}

/** Union of every source. A failing source FAILS CLOSED (the error propagates; nothing is shown). */
export async function collectScreens(
  sources: readonly ScreenSource[],
  tx: TenantTx,
  tenantId: string,
  userId: string | null
): Promise<Set<string>> {
  const out = new Set<string>();
  if (!userId) return out;
  for (const s of sources) for (const id of await s.screenedMatterIds(tx, tenantId, userId)) out.add(id);
  return out;
}

/** Intersection of every scope source (null = unrestricted). */
export async function collectScope(
  sources: readonly MatterScopeSource[],
  tx: TenantTx,
  tenantId: string,
  viewer: StaffViewer
): Promise<Set<string> | null> {
  let out: Set<string> | null = null;
  for (const s of sources) {
    const allowed = await s.allowedMatterIds(tx, tenantId, viewer);
    if (allowed === null) continue;
    const next: Set<string> = out === null ? new Set<string>(allowed) : new Set<string>([...out].filter((id) => allowed.has(id)));
    out = next;
  }
  return out;
}
