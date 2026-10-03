// c99 — database side of the permission model: per-firm overrides, assigned
// roles, matter teams/restrictions, and the append-only change log. Every
// write checks `permissions.manage` itself (defence in depth: routes check too).

import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { matterParties, matters, users } from "@/db/schema";
import {
  accessChangeLog,
  firmRoleAssignments,
  matterAccessSettings,
  matterTeamMembers,
  permissionOverrides,
} from "@/db/tables/all-engines";
import { audit, type Actor } from "@/core/audit";
import type { TenantTx } from "@/tenancy/withTenant";
import { AllEnginesError, ENGINE } from "../common/errors";
import {
  FIRM,
  assertCan,
  baseRolesFor,
  buildMatrix,
  can,
  combineRoles,
  decide,
  effectiveRights,
  isFirmRole,
  planOverrideChange,
  rightDef,
  validateRoleGrant,
  validateRoleRevoke,
  type FirmRole,
  type MatterRef,
  type OverrideEffect,
  type PermissionOverride,
  type PolicyActor,
  type PolicyConfig,
  type PolicyResource,
} from "./policy";

// ---------------------------------------------------------------------------
// Who is acting
// ---------------------------------------------------------------------------

/** The signed-in staff member, as the route resolved them (c34 principal). */
export interface PrincipalLike {
  userId: string | null;
  /** users.role */
  role: string;
  /** c34 capabilities */
  capabilities: readonly string[];
}

export interface StaffContext {
  userId: string | null;
  roles: FirmRole[];
  baseRoles: FirmRole[];
  assignedRoles: FirmRole[];
  actor: PolicyActor;
  /** For audit rows (the synthetic dev principal is logged as system). */
  auditActor: Actor;
  config: PolicyConfig;
}

export async function loadPolicyConfig(tx: TenantTx, tenantId: string): Promise<PolicyConfig> {
  const rows = await tx
    .select({ role: permissionOverrides.role, right: permissionOverrides.right, effect: permissionOverrides.effect })
    .from(permissionOverrides)
    .where(eq(permissionOverrides.tenantId, tenantId));
  return { overrides: rows.map((r) => ({ role: r.role, right: r.right, effect: r.effect as OverrideEffect })) };
}

async function assignedRolesFor(tx: TenantTx, tenantId: string, userIds: readonly string[]): Promise<Map<string, FirmRole[]>> {
  const out = new Map<string, FirmRole[]>();
  if (userIds.length === 0) return out;
  const rows = await tx
    .select({ userId: firmRoleAssignments.userId, role: firmRoleAssignments.role })
    .from(firmRoleAssignments)
    .where(and(eq(firmRoleAssignments.tenantId, tenantId), inArray(firmRoleAssignments.userId, [...userIds]), isNull(firmRoleAssignments.revokedAt)));
  for (const r of rows) {
    if (!isFirmRole(r.role)) continue;
    out.set(r.userId, [...(out.get(r.userId) ?? []), r.role]);
  }
  return out;
}

/** Build the acting staff member's policy actor: c34 role/capabilities + roles assigned here. */
export async function loadStaffContext(tx: TenantTx, tenantId: string, principal: PrincipalLike): Promise<StaffContext> {
  const baseRoles = baseRolesFor(principal.role, principal.capabilities);
  const assignedRoles = principal.userId ? ((await assignedRolesFor(tx, tenantId, [principal.userId])).get(principal.userId) ?? []) : [];
  const roles = combineRoles(baseRoles, assignedRoles);
  return {
    userId: principal.userId,
    roles,
    baseRoles,
    assignedRoles,
    actor: { kind: "staff", userId: principal.userId, roles, status: "active" },
    auditActor: principal.userId ? { type: "user", userId: principal.userId } : { type: "system" },
    config: await loadPolicyConfig(tx, tenantId),
  };
}

/** What the signed-in person may do (for the UI). */
export function describeStaffContext(ctx: StaffContext) {
  return {
    userId: ctx.userId,
    roles: ctx.roles,
    baseRoles: ctx.baseRoles,
    assignedRoles: ctx.assignedRoles,
    rights: [...effectiveRights(ctx.actor, ctx.config)].sort(),
  };
}

// ---------------------------------------------------------------------------
// Change log (append-only) + shared audit (c6)
// ---------------------------------------------------------------------------

export interface AccessChange {
  area: "permissions" | "roles" | "matter_access" | "practice_areas" | "packs";
  action: string;
  by: Actor;
  targetUserId?: string | null;
  matterId?: string | null;
  role?: string | null;
  right?: string | null;
  practiceArea?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  reason?: string | null;
}

/** Append one change to access_change_log and the shared audit trail. */
export async function logAccessChange(tx: TenantTx, tenantId: string, c: AccessChange): Promise<void> {
  const actorUserId = c.by.type === "user" ? c.by.userId : null;
  const [row] = await tx
    .insert(accessChangeLog)
    .values({
      tenantId,
      area: c.area,
      action: c.action,
      actorType: c.by.type === "user" ? "user" : "system",
      actorUserId,
      targetUserId: c.targetUserId ?? null,
      matterId: c.matterId ?? null,
      role: c.role ?? null,
      right: c.right ?? null,
      practiceArea: c.practiceArea ?? null,
      before: c.before ?? null,
      after: c.after ?? null,
      reason: c.reason ?? null,
    })
    .returning({ id: accessChangeLog.id });
  await audit(tx, {
    tenantId,
    engine: ENGINE,
    action: `${c.area}.${c.action}`.replace(/[^a-z0-9_.-]/g, "_"),
    entityType: "access_change_log",
    entityId: row?.id ?? null,
    matterId: c.matterId ?? null,
    actor: c.by,
    reason: c.reason ?? null,
    payload: {
      targetUserId: c.targetUserId ?? null,
      role: c.role ?? null,
      right: c.right ?? null,
      practiceArea: c.practiceArea ?? null,
      before: c.before ?? null,
      after: c.after ?? null,
    },
  });
}

export async function listAccessChanges(
  tx: TenantTx,
  tenantId: string,
  viewer: StaffContext,
  filter: { area?: AccessChange["area"]; limit?: number } = {}
) {
  if (!can(viewer.actor, "permissions.manage", FIRM, viewer.config) && !can(viewer.actor, "audit.view", FIRM, viewer.config)) {
    assertCan(viewer.actor, "permissions.manage", FIRM, viewer.config);
  }
  const conds = [eq(accessChangeLog.tenantId, tenantId)];
  if (filter.area) conds.push(eq(accessChangeLog.area, filter.area));
  return tx
    .select()
    .from(accessChangeLog)
    .where(and(...conds))
    .orderBy(desc(accessChangeLog.occurredAt))
    .limit(Math.min(Math.max(filter.limit ?? 100, 1), 500));
}

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

export async function getPermissionMatrix(tx: TenantTx, tenantId: string, viewer: StaffContext) {
  assertCan(viewer.actor, "permissions.manage", FIRM, viewer.config);
  return { matrix: buildMatrix(viewer.config.overrides), overrides: viewer.config.overrides };
}

export async function setPermissionOverride(
  tx: TenantTx,
  input: { tenantId: string; by: StaffContext; role: string; right: string; effect: OverrideEffect | null; reason: string }
) {
  const { tenantId, by } = input;
  assertCan(by.actor, "permissions.manage", FIRM, by.config);
  if (!input.reason.trim()) throw new AllEnginesError("A reason is required for every permission change.");
  const plan = planOverrideChange(by.config.overrides, { role: input.role, right: input.right, effect: input.effect });
  if (!plan.ok) throw new AllEnginesError("This permission cannot be changed that way.", 422, plan.errors);
  if (!plan.changed) return { changed: false, matrix: buildMatrix(plan.next) };

  // Nobody removes their own ability to manage permissions (ask another manager).
  if (!can(by.actor, "permissions.manage", FIRM, { overrides: plan.next })) {
    throw new AllEnginesError("This change would remove your own ability to manage permissions. Ask another owner to make it.", 409);
  }

  const role = input.role as FirmRole;
  const updatedByUserId = by.userId;
  if (plan.after.override === null) {
    await tx
      .delete(permissionOverrides)
      .where(and(eq(permissionOverrides.tenantId, tenantId), eq(permissionOverrides.role, role), eq(permissionOverrides.right, input.right)));
  } else {
    await tx
      .insert(permissionOverrides)
      .values({ tenantId, role, right: input.right, effect: plan.after.override, reason: input.reason.trim(), updatedByUserId })
      .onConflictDoUpdate({
        target: [permissionOverrides.tenantId, permissionOverrides.role, permissionOverrides.right],
        set: { effect: plan.after.override, reason: input.reason.trim(), updatedByUserId, updatedAt: new Date() },
      });
  }
  await logAccessChange(tx, tenantId, {
    area: "permissions",
    action: plan.after.override === null ? "override.cleared" : "override.set",
    by: by.auditActor,
    role,
    right: input.right,
    before: plan.before,
    after: plan.after,
    reason: input.reason.trim(),
  });
  return { changed: true, matrix: buildMatrix(plan.next) };
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

export interface RoleHolder {
  userId: string;
  displayName: string;
  email: string;
  status: string;
  accountRole: string;
  baseRoles: FirmRole[];
  assignedRoles: FirmRole[];
  roles: FirmRole[];
}

/**
 * Every staff user with their roles. c34 capabilities live in the platform
 * engine's table, which this engine may not read: `capabilitiesByUser`
 * lets a route pass them in (see the Foundation request); without it,
 * base roles come from users.role only.
 */
export async function listRoleHolders(
  tx: TenantTx,
  tenantId: string,
  viewer: StaffContext,
  capabilitiesByUser: ReadonlyMap<string, readonly string[]> = new Map()
): Promise<RoleHolder[]> {
  assertCan(viewer.actor, "permissions.manage", FIRM, viewer.config);
  const rows = await tx
    .select({ id: users.id, displayName: users.displayName, email: users.email, status: users.status, role: users.role })
    .from(users)
    .where(eq(users.tenantId, tenantId))
    .orderBy(users.displayName);
  const assigned = await assignedRolesFor(tx, tenantId, rows.map((r) => r.id));
  return rows.map((r) => {
    const baseRoles = baseRolesFor(r.role, capabilitiesByUser.get(r.id) ?? []);
    const assignedRoles = assigned.get(r.id) ?? [];
    return {
      userId: r.id,
      displayName: r.displayName,
      email: r.email,
      status: r.status,
      accountRole: r.role,
      baseRoles,
      assignedRoles,
      roles: combineRoles(baseRoles, assignedRoles),
    };
  });
}

async function countOwners(tx: TenantTx, tenantId: string): Promise<number> {
  const rows = await tx
    .select({ userId: firmRoleAssignments.userId })
    .from(firmRoleAssignments)
    .innerJoin(users, and(eq(users.id, firmRoleAssignments.userId), eq(users.tenantId, firmRoleAssignments.tenantId)))
    .where(
      and(
        eq(firmRoleAssignments.tenantId, tenantId),
        eq(firmRoleAssignments.role, "owner"),
        isNull(firmRoleAssignments.revokedAt),
        eq(users.status, "active")
      )
    );
  return new Set(rows.map((r) => r.userId)).size;
}

async function loadTargetUser(tx: TenantTx, tenantId: string, userId: string, capabilities: readonly string[]) {
  const [u] = await tx
    .select({ id: users.id, role: users.role, status: users.status })
    .from(users)
    .where(and(eq(users.tenantId, tenantId), eq(users.id, userId)))
    .limit(1);
  if (!u) throw new AllEnginesError("No such user in this firm.", 404);
  const assignedRoles = (await assignedRolesFor(tx, tenantId, [userId])).get(userId) ?? [];
  const baseRoles = baseRolesFor(u.role, capabilities);
  return { ...u, baseRoles, assignedRoles, roles: combineRoles(baseRoles, assignedRoles) };
}

export async function grantRole(
  tx: TenantTx,
  input: { tenantId: string; by: StaffContext; userId: string; role: string; reason: string; targetCapabilities?: readonly string[] }
) {
  const { tenantId, by } = input;
  const target = await loadTargetUser(tx, tenantId, input.userId, input.targetCapabilities ?? []);
  const errors = validateRoleGrant({
    granter: { userId: by.userId, roles: by.roles, status: "active" },
    grantee: { userId: target.id, status: target.status, roles: target.roles },
    role: input.role,
    reason: input.reason,
    ownerCount: input.role === "owner" ? await countOwners(tx, tenantId) : undefined,
    config: by.config,
  });
  if (errors.length > 0) throw new AllEnginesError("This role cannot be given.", errors.some((e) => /Only someone/.test(e)) ? 403 : 422, errors);
  const [row] = await tx
    .insert(firmRoleAssignments)
    .values({ tenantId, userId: target.id, role: input.role, grantedByUserId: by.userId, grantReason: input.reason.trim() })
    .returning();
  await logAccessChange(tx, tenantId, {
    area: "roles",
    action: "role.granted",
    by: by.auditActor,
    targetUserId: target.id,
    role: input.role,
    before: { roles: target.roles },
    after: { roles: combineRoles(target.baseRoles, [...target.assignedRoles, input.role]) },
    reason: input.reason.trim(),
  });
  return row;
}

export async function revokeRole(
  tx: TenantTx,
  input: { tenantId: string; by: StaffContext; userId: string; role: string; reason: string }
) {
  const { tenantId, by } = input;
  const target = await loadTargetUser(tx, tenantId, input.userId, []);
  const errors = validateRoleRevoke({
    revoker: { userId: by.userId, roles: by.roles, status: "active" },
    target: { userId: target.id, assignedRoles: target.assignedRoles },
    role: input.role,
    reason: input.reason,
    ownerCount: input.role === "owner" ? await countOwners(tx, tenantId) : 0,
    config: by.config,
  });
  if (errors.length > 0) throw new AllEnginesError("This role cannot be removed.", errors.some((e) => /Only someone/.test(e)) ? 403 : 422, errors);
  const revoked = await tx
    .update(firmRoleAssignments)
    .set({ revokedAt: new Date(), revokedByUserId: by.userId, revokeReason: input.reason.trim() })
    .where(
      and(
        eq(firmRoleAssignments.tenantId, tenantId),
        eq(firmRoleAssignments.userId, target.id),
        eq(firmRoleAssignments.role, input.role),
        isNull(firmRoleAssignments.revokedAt)
      )
    )
    .returning({ id: firmRoleAssignments.id });
  await logAccessChange(tx, tenantId, {
    area: "roles",
    action: "role.revoked",
    by: by.auditActor,
    targetUserId: target.id,
    role: input.role,
    before: { roles: target.roles },
    after: { roles: combineRoles(target.baseRoles, target.assignedRoles.filter((r) => r !== input.role)) },
    reason: input.reason.trim(),
  });
  return { revoked: revoked.length };
}

// ---------------------------------------------------------------------------
// Matter-level access
// ---------------------------------------------------------------------------

/**
 * Everything can() needs to know about a matter. Active ethical screens
 * (c60) are owned by the conflict-check engine and cannot be read from here;
 * callers pass them in until screens live in a shared table (Foundation request).
 */
export async function loadMatterRef(
  tx: TenantTx,
  tenantId: string,
  matterId: string,
  opts: { screenedUserIds?: readonly string[] } = {}
): Promise<MatterRef | null> {
  const [m] = await tx
    .select({ id: matters.id, assignedUserId: matters.assignedUserId })
    .from(matters)
    .where(and(eq(matters.tenantId, tenantId), eq(matters.id, matterId)))
    .limit(1);
  if (!m) return null;
  const [team, access, clients] = await Promise.all([
    tx
      .select({ userId: matterTeamMembers.userId })
      .from(matterTeamMembers)
      .where(and(eq(matterTeamMembers.tenantId, tenantId), eq(matterTeamMembers.matterId, matterId), isNull(matterTeamMembers.removedAt))),
    tx
      .select({ restricted: matterAccessSettings.restricted })
      .from(matterAccessSettings)
      .where(and(eq(matterAccessSettings.tenantId, tenantId), eq(matterAccessSettings.matterId, matterId)))
      .limit(1),
    tx
      .select({ partyId: matterParties.partyId })
      .from(matterParties)
      .where(and(eq(matterParties.tenantId, tenantId), eq(matterParties.matterId, matterId), eq(matterParties.role, "client"), isNull(matterParties.endedAt))),
  ]);
  const teamUserIds = [...new Set([...(m.assignedUserId ? [m.assignedUserId] : []), ...team.map((t) => t.userId)])];
  return {
    matterId,
    teamUserIds,
    screenedUserIds: [...(opts.screenedUserIds ?? [])],
    restricted: access[0]?.restricted ?? false,
    clientPartyIds: clients.map((c) => c.partyId),
  };
}

async function requireMatter(tx: TenantTx, tenantId: string, matterId: string, by: StaffContext): Promise<MatterRef> {
  const ref = await loadMatterRef(tx, tenantId, matterId);
  if (!ref) throw new AllEnginesError("No such matter.", 404);
  // Managing a matter's access needs permissions.manage, or matters.edit on that very matter.
  if (!can(by.actor, "permissions.manage", FIRM, by.config)) assertCan(by.actor, "matters.edit", { type: "matter", ...ref }, by.config);
  return ref;
}

export async function setMatterRestricted(
  tx: TenantTx,
  input: { tenantId: string; by: StaffContext; matterId: string; restricted: boolean; reason: string }
) {
  const { tenantId, by, matterId } = input;
  const ref = await requireMatter(tx, tenantId, matterId, by);
  if (!input.reason.trim()) throw new AllEnginesError("A reason is required.");
  if (input.restricted && !(ref.teamUserIds ?? []).length) {
    throw new AllEnginesError("Add at least one team member before restricting the matter, or nobody could open it.", 409);
  }
  if (ref.restricted === input.restricted) return { changed: false };
  await tx
    .insert(matterAccessSettings)
    .values({ tenantId, matterId, restricted: input.restricted, reason: input.reason.trim(), updatedByUserId: by.userId })
    .onConflictDoUpdate({
      target: [matterAccessSettings.tenantId, matterAccessSettings.matterId],
      set: { restricted: input.restricted, reason: input.reason.trim(), updatedByUserId: by.userId, updatedAt: new Date() },
    });
  await logAccessChange(tx, tenantId, {
    area: "matter_access",
    action: input.restricted ? "matter.restricted" : "matter.unrestricted",
    by: by.auditActor,
    matterId,
    before: { restricted: ref.restricted ?? false },
    after: { restricted: input.restricted },
    reason: input.reason.trim(),
  });
  return { changed: true };
}

export async function addTeamMember(
  tx: TenantTx,
  input: { tenantId: string; by: StaffContext; matterId: string; userId: string; roleOnMatter?: string | null; reason?: string | null }
) {
  const { tenantId, by, matterId } = input;
  const ref = await requireMatter(tx, tenantId, matterId, by);
  if ((ref.teamUserIds ?? []).includes(input.userId)) return { changed: false };
  const [u] = await tx.select({ id: users.id, status: users.status }).from(users).where(and(eq(users.tenantId, tenantId), eq(users.id, input.userId))).limit(1);
  if (!u || u.status !== "active") throw new AllEnginesError("Only active users of this firm can join a matter team.", 422);
  await tx.insert(matterTeamMembers).values({ tenantId, matterId, userId: input.userId, roleOnMatter: input.roleOnMatter?.trim() || "member", addedByUserId: by.userId });
  await logAccessChange(tx, tenantId, {
    area: "matter_access",
    action: "team.added",
    by: by.auditActor,
    matterId,
    targetUserId: input.userId,
    after: { roleOnMatter: input.roleOnMatter ?? "member" },
    reason: input.reason ?? null,
  });
  return { changed: true };
}

export async function removeTeamMember(
  tx: TenantTx,
  input: { tenantId: string; by: StaffContext; matterId: string; userId: string; reason: string }
) {
  const { tenantId, by, matterId } = input;
  const ref = await requireMatter(tx, tenantId, matterId, by);
  if (!input.reason.trim()) throw new AllEnginesError("A reason is required.");
  if (!(ref.teamUserIds ?? []).includes(input.userId)) return { changed: false };
  const remaining = (ref.teamUserIds ?? []).filter((id) => id !== input.userId);
  if (ref.restricted && remaining.length === 0) {
    throw new AllEnginesError("This is the last team member of a restricted matter; lift the restriction or add someone first.", 409);
  }
  const removed = await tx
    .update(matterTeamMembers)
    .set({ removedAt: new Date(), removedByUserId: by.userId })
    .where(
      and(
        eq(matterTeamMembers.tenantId, tenantId),
        eq(matterTeamMembers.matterId, matterId),
        eq(matterTeamMembers.userId, input.userId),
        isNull(matterTeamMembers.removedAt)
      )
    )
    .returning({ id: matterTeamMembers.id });
  // The responsible lawyer (matters.assigned_user_id) is on the team by assignment, not by a row here.
  if (removed.length === 0) throw new AllEnginesError("This person is on the team as the matter's assigned lawyer; reassign the matter instead.", 409);
  await logAccessChange(tx, tenantId, {
    area: "matter_access",
    action: "team.removed",
    by: by.auditActor,
    matterId,
    targetUserId: input.userId,
    reason: input.reason.trim(),
  });
  return { changed: true };
}

/** Explain a decision for the signed-in person ("why can't I do this?"). */
export function explain(ctx: StaffContext, right: string, resource: PolicyResource = FIRM) {
  const def = rightDef(right);
  return { label: def?.label ?? right, ...decide(ctx.actor, right, resource, ctx.config) };
}

export type { PermissionOverride };
