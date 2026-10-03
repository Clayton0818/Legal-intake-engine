// Who is acting, and what their role lets them do in this engine. Roles are
// always read from the firm's own `users` row (never trusted from a request).
//
// Founder rules applied here:
//  - only a lawyer (role 'attorney') confirms a deadline — never the AI, never
//    a system process, never staff (src/auth/rbac.ts ATTORNEY_ONLY);
//  - a limitation date is entered and changed only by a lawyer; a SECOND
//    person (another lawyer or firm-designated trained staff) verifies it.

import { and, eq, inArray } from "drizzle-orm";
import { users } from "@/db/schema";
import type { Actor } from "@/core";
import type { TenantTx } from "@/tenancy/withTenant";
import { forbidden } from "./errors";

export interface Staff {
  userId: string;
  role: string;
  displayName: string;
}

export const WRITE_ROLES = ["firm_admin", "attorney", "intake_staff"] as const;
export const TEMPLATE_ROLES = ["firm_admin", "attorney"] as const;

export function actorOf(staff: Pick<Staff, "userId">): Actor {
  return { type: "user", userId: staff.userId };
}

export function isLawyer(staff: Pick<Staff, "role">): boolean {
  return staff.role === "attorney";
}

export function canWriteCalendar(staff: Pick<Staff, "role">): boolean {
  return (WRITE_ROLES as readonly string[]).includes(staff.role);
}

export function canManageTemplates(staff: Pick<Staff, "role">): boolean {
  return (TEMPLATE_ROLES as readonly string[]).includes(staff.role);
}

/** Lawyers, or staff the firm has listed as trained to verify limitation dates. Pure. */
export function canVerifyLimitations(staff: Pick<Staff, "role" | "userId">, trainedStaffIds: readonly string[]): boolean {
  if (staff.role === "attorney") return true;
  if (staff.role === "read_only" || staff.role === "integration_service") return false;
  return trainedStaffIds.includes(staff.userId);
}

export function requireLawyer(staff: Pick<Staff, "role">, what: string): void {
  if (!isLawyer(staff)) throw forbidden(`Only a lawyer can ${what}.`);
}

export function requireWriter(staff: Pick<Staff, "role">): void {
  if (!canWriteCalendar(staff)) throw forbidden("Your role cannot change the calendar.");
}

export function requireTemplateManager(staff: Pick<Staff, "role">): void {
  if (!canManageTemplates(staff)) throw forbidden("Only a lawyer or firm admin can manage templates.");
}

/** Load an ACTIVE user of this firm. Throws 403 for an unknown or inactive user. */
export async function loadStaff(tx: TenantTx, tenantId: string, userId: string): Promise<Staff> {
  const [row] = await tx
    .select({ id: users.id, role: users.role, status: users.status, displayName: users.displayName })
    .from(users)
    .where(and(eq(users.tenantId, tenantId), eq(users.id, userId)))
    .limit(1);
  if (!row || row.status !== "active") throw forbidden("Unknown or inactive user.");
  return { userId: row.id, role: row.role, displayName: row.displayName };
}

/** Active users of the firm with one of the given roles. */
export async function activeUserIdsByRole(tx: TenantTx, tenantId: string, roles: string[]): Promise<string[]> {
  const rows = await tx
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.tenantId, tenantId),
        eq(users.status, "active"),
        inArray(users.role, roles as (typeof users.role.enumValues)[number][])
      )
    );
  return rows.map((r) => r.id);
}
