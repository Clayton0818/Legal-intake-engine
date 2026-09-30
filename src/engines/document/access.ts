// Who may do what with documents (c84 "access respects c60 screens"; c85
// rule 2; c41/c49/c90 "only an attorney …"). Role rules are pure; the DB
// helpers load the acting user and the screen mirror table.
//
// LOCAL ADAPTER: ethical screens (c60) belong to the Conflict-check engine.
// Until a shared screen lookup exists, this engine reads its own mirror table
// `document_matter_screens` (see the PR's shared requests).

import { and, eq, isNull } from "drizzle-orm";
import { audit } from "@/core";
import { users } from "@/db/schema";
import { documentMatterScreens } from "@/db/tables/document";
import type { TenantTx } from "@/tenancy/withTenant";
import { DocumentError, ENGINE } from "./common";

export type StaffRole = "firm_admin" | "attorney" | "intake_staff" | "read_only" | "integration_service";

export interface StaffUser {
  id: string;
  role: StaffRole;
  displayName: string;
  email: string;
  active: boolean;
}

export type DocumentCapability =
  | "view"
  | "upload"
  | "edit"
  /** Legal approvals: templates, drafts for sending/filing, acceptances, closing, destruction. */
  | "attorney_approve"
  | "manage_templates"
  | "firm_admin";

/** Pure role matrix. */
export function roleCan(role: StaffRole, cap: DocumentCapability): boolean {
  switch (cap) {
    case "view":
      return role !== "integration_service";
    case "upload":
    case "edit":
      return role === "attorney" || role === "firm_admin" || role === "intake_staff";
    case "manage_templates":
      return role === "attorney" || role === "firm_admin";
    case "attorney_approve":
      return role === "attorney";
    case "firm_admin":
      return role === "firm_admin";
  }
}

export class AccessDeniedError extends DocumentError {
  constructor(readonly capability: string, message?: string) {
    super(message ?? `Not allowed: this needs ${capability === "attorney_approve" ? "an attorney" : `the '${capability}' permission`}.`, 403);
    this.name = "AccessDeniedError";
  }
}

export function assertCan(user: StaffUser, cap: DocumentCapability): void {
  if (!user.active || !roleCan(user.role, cap)) throw new AccessDeniedError(cap);
}

export async function loadStaffUser(tx: TenantTx, tenantId: string, userId: string): Promise<StaffUser | null> {
  const [u] = await tx
    .select({ id: users.id, role: users.role, displayName: users.displayName, email: users.email, status: users.status })
    .from(users)
    .where(and(eq(users.tenantId, tenantId), eq(users.id, userId)))
    .limit(1);
  if (!u) return null;
  return { id: u.id, role: u.role as StaffRole, displayName: u.displayName, email: u.email, active: u.status === "active" };
}

/** Matter ids this user is screened from (c60). */
export async function screenedMatterIds(tx: TenantTx, tenantId: string, userId: string): Promise<Set<string>> {
  const rows = await tx
    .select({ matterId: documentMatterScreens.matterId })
    .from(documentMatterScreens)
    .where(and(eq(documentMatterScreens.tenantId, tenantId), eq(documentMatterScreens.userId, userId), isNull(documentMatterScreens.removedAt)));
  return new Set(rows.map((r) => r.matterId));
}

export async function isScreened(tx: TenantTx, tenantId: string, userId: string, matterId: string): Promise<boolean> {
  return (await screenedMatterIds(tx, tenantId, userId)).has(matterId);
}

/**
 * Throw (and log) unless the user may act on this matter's documents. Screened
 * users are refused even when their role would allow it.
 */
export async function assertMatterAccess(
  tx: TenantTx,
  tenantId: string,
  user: StaffUser,
  matterId: string,
  cap: DocumentCapability = "view"
): Promise<void> {
  assertCan(user, cap);
  if (await isScreened(tx, tenantId, user.id, matterId)) {
    await audit(tx, {
      tenantId,
      engine: ENGINE,
      action: "access.screened_denied",
      entityType: "matter",
      entityId: matterId,
      matterId,
      actor: { type: "user", userId: user.id },
      payload: { capability: cap },
    });
    throw new AccessDeniedError("screen", "Not allowed: you are screened from this matter.");
  }
}
