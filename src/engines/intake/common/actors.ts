// Firm users as the intake engine sees them, plus role checks. Real auth
// (c34) will supply the acting user; until then routes pass the user id
// explicitly (see src/app/api/intake/_lib/http.ts) and every service still
// re-reads the user row and checks the role here, so nothing trusts a
// client-supplied role.

import { and, eq, inArray } from "drizzle-orm";
import { users } from "@/db/schema";
import type { TenantTx } from "@/tenancy/withTenant";
import type { Actor } from "@/core/audit";
import { IntakeForbiddenError, IntakeNotFoundError } from "./errors";
import type { IntakeSettings } from "../settings";

export type UserRole = (typeof users.role.enumValues)[number];

export interface StaffUser {
  id: string;
  displayName: string;
  email: string;
  role: UserRole;
  status: string;
  restrictedToUnassignedMatters: boolean;
}

/** Roles whose contact stops the speed-to-lead clock (c69 rule 4). */
export const HUMAN_CONTACT_ROLES: readonly UserRole[] = ["attorney", "intake_staff", "firm_admin"];
/** Roles that may act as a lawyer (open matters, decide borderline cases, record consult outcomes). */
export const LAWYER_ROLES: readonly UserRole[] = ["attorney"];
/** Roles that may supervise / override assignment. */
export const SUPERVISOR_ROLES: readonly UserRole[] = ["attorney", "firm_admin"];
/** Staff roles that may work the intake queue. */
export const STAFF_ROLES: readonly UserRole[] = ["attorney", "intake_staff", "firm_admin"];

const columns = {
  id: users.id,
  displayName: users.displayName,
  email: users.email,
  role: users.role,
  status: users.status,
  restrictedToUnassignedMatters: users.restrictedToUnassignedMatters,
};

export async function loadStaffUser(tx: TenantTx, tenantId: string, userId: string): Promise<StaffUser> {
  const [row] = await tx.select(columns).from(users).where(and(eq(users.tenantId, tenantId), eq(users.id, userId))).limit(1);
  if (!row) throw new IntakeNotFoundError("User");
  if (row.status !== "active") throw new IntakeForbiddenError("This user account is not active.");
  return row;
}

/** Pure role check. */
export function hasRole(user: Pick<StaffUser, "role">, roles: readonly UserRole[]): boolean {
  return roles.includes(user.role);
}

export function assertRole(user: Pick<StaffUser, "role">, roles: readonly UserRole[], action: string): void {
  if (!hasRole(user, roles)) {
    throw new IntakeForbiddenError(`Only ${roles.join(" / ")} users can ${action}.`);
  }
}

/** Load the user and check the role in one step. */
export async function requireStaff(
  tx: TenantTx,
  tenantId: string,
  userId: string,
  roles: readonly UserRole[],
  action: string
): Promise<StaffUser> {
  const user = await loadStaffUser(tx, tenantId, userId);
  assertRole(user, roles, action);
  return user;
}

export function userActor(userId: string): Actor {
  return { type: "user", userId };
}

export async function listActiveUsersByRole(tx: TenantTx, tenantId: string, roles: readonly UserRole[]): Promise<StaffUser[]> {
  if (roles.length === 0) return [];
  return tx
    .select(columns)
    .from(users)
    .where(and(eq(users.tenantId, tenantId), eq(users.status, "active"), inArray(users.role, [...roles])));
}

/**
 * Who gets escalations. There is no "intake manager" or "owner" role yet
 * (spec open question); the firm names them in intake settings, and firm
 * admins are the fallback so an escalation never goes nowhere.
 */
export async function resolveEscalationContacts(
  tx: TenantTx,
  tenantId: string,
  settings: IntakeSettings
): Promise<{ intakeManagers: string[]; owners: string[] }> {
  const admins = (await listActiveUsersByRole(tx, tenantId, ["firm_admin"])).map((u) => u.id);
  const owners = settings.escalation.ownerUserIds.length > 0 ? settings.escalation.ownerUserIds : admins;
  const intakeManagers = settings.escalation.intakeManagerUserIds.length > 0 ? settings.escalation.intakeManagerUserIds : owners;
  return { intakeManagers: [...new Set(intakeManagers)], owners: [...new Set(owners)] };
}
