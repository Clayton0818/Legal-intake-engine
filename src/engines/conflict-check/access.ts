// Who may do what in the Conflict-check engine.
//
// The conflicts role does not exist in `user_role` yet (it arrives with c99),
// so the engine keeps its own grants in `conflict_role_grants` — a LOCAL
// ADAPTER described in the PR's shared requests. Every service function
// checks access itself (defence in depth); API routes check it too, in a
// separate transaction, so a denied attempt is logged even though the
// request fails (c56 acceptance 4).

import { and, eq, isNull } from "drizzle-orm";
import { users } from "@/db/schema";
import { conflictRoleGrants, conflictScreens } from "@/db/tables/conflict-check";
import { audit } from "@/core";
import type { TenantTx } from "@/tenancy/withTenant";
import { ENGINE } from "./settings";
import { ConflictError } from "./util";

export type ConflictCapability =
  /** Search and browse the party index (party details). */
  | "index.search"
  /** Add/edit/merge index entries; add parties to the index outside intake. */
  | "index.edit"
  /** Record conflict decisions, approve waivers, activate screens. */
  | "decide"
  /** Full log records (c63). */
  | "log.view"
  /** Lawyer-interest hits (c97 rule 3: conflicts role only, never owner/admin by role alone). */
  | "log.view_interests"
  /** Export the log. */
  | "log.export"
  /** Open queue of checks waiting on a decision. */
  | "queue.view"
  /** Index health numbers only (counts, pending merges, import status). */
  | "health.view"
  /** Grant/revoke the conflicts role. */
  | "roles.manage"
  /** Read the contents of lateral lists (c61 rule 6). */
  | "lateral.view_lists"
  /** Create lateral checks, attest "no prior legal employment". */
  | "lateral.manage";

export type ConflictsRole = "conflicts_attorney" | "conflicts_staff";

export interface AccessInput {
  userRole: string | null;
  userStatus: string | null;
  grant: { role: ConflictsRole } | null;
  ownerSeesPartyDetails: boolean;
}

/** Capabilities for a user. Pure. */
export function capabilitiesFor(input: AccessInput): Set<ConflictCapability> {
  const caps = new Set<ConflictCapability>();
  if (input.userStatus !== "active" || !input.userRole) return caps;

  if (input.grant) {
    for (const c of [
      "index.search",
      "index.edit",
      "log.view",
      "log.view_interests",
      "log.export",
      "queue.view",
      "health.view",
      "lateral.view_lists",
    ] as const) {
      caps.add(c);
    }
    if (input.grant.role === "conflicts_attorney") caps.add("decide");
  }
  if (input.userRole === "firm_admin") {
    for (const c of ["health.view", "log.view", "log.export", "queue.view", "roles.manage", "lateral.manage"] as const) caps.add(c);
    if (input.ownerSeesPartyDetails) caps.add("index.search");
  }
  return caps;
}

export interface ConflictAccess {
  userId: string;
  /** The user exists in this firm and is active. */
  active?: boolean;
  userRole: string | null;
  grant: { id: string; role: ConflictsRole; designated: boolean; backup: boolean } | null;
  caps: Set<ConflictCapability>;
}

export class AccessDeniedError extends Error {
  constructor(
    readonly capability: ConflictCapability,
    readonly userId: string
  ) {
    super(`Access denied: '${capability}' needs the conflicts role.`);
    this.name = "AccessDeniedError";
  }
}

export function can(access: ConflictAccess, cap: ConflictCapability): boolean {
  return access.caps.has(cap);
}

export function assertCan(access: ConflictAccess, cap: ConflictCapability): void {
  if (!access.caps.has(cap)) throw new AccessDeniedError(cap, access.userId);
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

export async function activeGrant(tx: TenantTx, tenantId: string, userId: string) {
  const [grant] = await tx
    .select()
    .from(conflictRoleGrants)
    .where(and(eq(conflictRoleGrants.tenantId, tenantId), eq(conflictRoleGrants.userId, userId), isNull(conflictRoleGrants.revokedAt)))
    .limit(1);
  return grant ?? null;
}

export async function loadAccess(
  tx: TenantTx,
  tenantId: string,
  userId: string,
  opts: { ownerSeesPartyDetails?: boolean } = {}
): Promise<ConflictAccess> {
  const [user] = await tx
    .select({ role: users.role, status: users.status })
    .from(users)
    .where(and(eq(users.tenantId, tenantId), eq(users.id, userId)))
    .limit(1);
  const grant = user ? await activeGrant(tx, tenantId, userId) : null;
  const g = grant ? { id: grant.id, role: grant.role as ConflictsRole, designated: grant.designated, backup: grant.backup } : null;
  return {
    userId,
    active: user?.status === "active",
    userRole: user?.role ?? null,
    grant: g,
    caps: capabilitiesFor({
      userRole: user?.role ?? null,
      userStatus: user?.status ?? null,
      grant: g,
      ownerSeesPartyDetails: opts.ownerSeesPartyDetails ?? false,
    }),
  };
}

/** Check a capability and log a denial (in the caller's transaction). Returns whether allowed. */
export async function checkAndLog(
  tx: TenantTx,
  tenantId: string,
  access: ConflictAccess,
  cap: ConflictCapability,
  attempted: string
): Promise<boolean> {
  if (access.caps.has(cap)) return true;
  await audit(tx, {
    tenantId,
    engine: ENGINE,
    action: "access.denied",
    entityType: "user",
    entityId: access.userId,
    actor: { type: "user", userId: access.userId },
    payload: { capability: cap, attempted },
  });
  return false;
}

export interface ConflictAttorneys {
  designated: string | null;
  backups: string[];
  all: string[];
}

/** The firm's conflicts attorneys (designated first). */
export async function listConflictAttorneys(tx: TenantTx, tenantId: string): Promise<ConflictAttorneys> {
  const rows = await tx
    .select({ userId: conflictRoleGrants.userId, designated: conflictRoleGrants.designated, backup: conflictRoleGrants.backup })
    .from(conflictRoleGrants)
    .innerJoin(users, eq(users.id, conflictRoleGrants.userId))
    .where(
      and(
        eq(conflictRoleGrants.tenantId, tenantId),
        eq(conflictRoleGrants.role, "conflicts_attorney"),
        isNull(conflictRoleGrants.revokedAt),
        eq(users.status, "active")
      )
    );
  return {
    designated: rows.find((r) => r.designated)?.userId ?? null,
    backups: rows.filter((r) => r.backup && !r.designated).map((r) => r.userId),
    all: rows.map((r) => r.userId),
  };
}

export async function listFirmAdmins(tx: TenantTx, tenantId: string): Promise<string[]> {
  const rows = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.tenantId, tenantId), eq(users.role, "firm_admin"), eq(users.status, "active")));
  return rows.map((r) => r.id);
}

/**
 * Pick who reviews a check (c59 §4.1.2, §4.7): the designated conflicts
 * attorney; the backup when the designated attorney is the subject of the hit;
 * the firm owner/admin when nobody is designated (and a setup flag is raised
 * by the caller). Pure.
 */
export function pickReviewer(
  attorneys: ConflictAttorneys,
  admins: readonly string[],
  excludeUserIds: readonly string[] = []
): { userId: string | null; supervisorUserId: string | null; fallback: "none" | "backup" | "admin" | "unassigned" } {
  const ok = (id: string | null | undefined): id is string => !!id && !excludeUserIds.includes(id);
  const backup = attorneys.backups.find(ok) ?? attorneys.all.find((id) => ok(id) && id !== attorneys.designated) ?? null;
  const admin = admins.find(ok) ?? null;
  if (ok(attorneys.designated)) return { userId: attorneys.designated, supervisorUserId: backup ?? admin, fallback: "none" };
  if (backup) return { userId: backup, supervisorUserId: admin, fallback: "backup" };
  if (admin) return { userId: admin, supervisorUserId: null, fallback: "admin" };
  return { userId: null, supervisorUserId: null, fallback: "unassigned" };
}

/** Matter / intake ids a user is screened from (c60 wins over role, c63 rule 3). */
export async function screenedSubjectIds(tx: TenantTx, tenantId: string, userId: string): Promise<Set<string>> {
  const rows = await tx
    .select({ matterId: conflictScreens.matterId, intakeSessionId: conflictScreens.intakeSessionId, status: conflictScreens.status })
    .from(conflictScreens)
    .where(and(eq(conflictScreens.tenantId, tenantId), eq(conflictScreens.screenedUserId, userId)));
  const ids = new Set<string>();
  for (const r of rows) {
    if (r.status === "lifted") continue;
    if (r.matterId) ids.add(r.matterId);
    if (r.intakeSessionId) ids.add(r.intakeSessionId);
  }
  return ids;
}

export interface GrantRoleInput {
  tenantId: string;
  userId: string;
  role: ConflictsRole;
  designated?: boolean;
  backup?: boolean;
  by: ConflictAccess;
}

/** Grant the conflicts role (firm admin only). Designating a new attorney un-designates the old one. */
export async function grantConflictsRole(tx: TenantTx, input: GrantRoleInput) {
  assertCan(input.by, "roles.manage");
  if (input.designated && input.role !== "conflicts_attorney") {
    throw new ConflictError("Only a conflicts attorney can be the designated conflicts attorney.");
  }
  const existing = await activeGrant(tx, input.tenantId, input.userId);
  if (existing) {
    await tx
      .update(conflictRoleGrants)
      .set({ revokedAt: new Date(), revokedReason: "Replaced by a new grant" })
      .where(eq(conflictRoleGrants.id, existing.id));
  }
  if (input.designated) {
    await tx
      .update(conflictRoleGrants)
      .set({ designated: false })
      .where(and(eq(conflictRoleGrants.tenantId, input.tenantId), eq(conflictRoleGrants.designated, true), isNull(conflictRoleGrants.revokedAt)));
  }
  const [row] = await tx
    .insert(conflictRoleGrants)
    .values({
      tenantId: input.tenantId,
      userId: input.userId,
      role: input.role,
      designated: input.designated ?? false,
      backup: input.backup ?? false,
      grantedByUserId: input.by.userId,
    })
    .returning();
  await audit(tx, {
    tenantId: input.tenantId,
    engine: ENGINE,
    action: "role.granted",
    entityType: "user",
    entityId: input.userId,
    actor: { type: "user", userId: input.by.userId },
    payload: { role: input.role, designated: input.designated ?? false, backup: input.backup ?? false },
  });
  return row!;
}

export async function revokeConflictsRole(tx: TenantTx, input: { tenantId: string; userId: string; reason: string; by: ConflictAccess }) {
  assertCan(input.by, "roles.manage");
  if (!input.reason.trim()) throw new ConflictError("A reason is required to revoke the conflicts role.");
  await tx
    .update(conflictRoleGrants)
    .set({ revokedAt: new Date(), revokedReason: input.reason.trim(), designated: false })
    .where(
      and(eq(conflictRoleGrants.tenantId, input.tenantId), eq(conflictRoleGrants.userId, input.userId), isNull(conflictRoleGrants.revokedAt))
    );
  await audit(tx, {
    tenantId: input.tenantId,
    engine: ENGINE,
    action: "role.revoked",
    entityType: "user",
    entityId: input.userId,
    actor: { type: "user", userId: input.by.userId },
    reason: input.reason.trim(),
  });
}
