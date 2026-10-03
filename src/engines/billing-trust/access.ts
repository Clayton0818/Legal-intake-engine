// Who may do what with trust money (c76).
//
// LOCAL STAND-IN for the shared permission model. The firm-wide policy
// (src/auth/rbac.ts — 'trust.read' / 'trust.record' /
// 'trust.approve_disbursement' and the 'bookkeeper' capability) is being
// finished in parallel; engines may not import it yet (src/engines/README.md
// allowed imports). Until the Foundation exposes it to engines, this module
// checks the acting user's own `users` row:
//
//   owner      = users.role 'firm_admin', or role_label 'owner'
//   bookkeeper = users.role_label 'bookkeeper' on a staff role (firm_admin, attorney, intake_staff)
//   lawyer     = users.role 'attorney'
//
//   read trust ledgers / reconciliations  owner, bookkeeper, lawyer
//   post entries, place/release holds,
//   import statements, prepare a reconciliation, open ledgers   owner, bookkeeper
//   sign off a reconciliation as 'bookkeeper'                   owner, bookkeeper
//   sign off a reconciliation as 'lawyer'                       lawyer
//
// 'read_only' and 'integration_service' users, and anyone not 'active', can
// do none of it. Foundation request (see WAVE2_SUMMARY / design doc): replace
// trustPermissions() with the shared can(principal, 'trust.record') etc.

import { and, eq } from "drizzle-orm";
import { users } from "@/db/schema";
import type { TenantTx } from "@/tenancy/withTenant";
import { TrustRuleError, type SignoffRole } from "./types";

export type TrustAction = "read" | "post" | "reconcile" | "signoff_bookkeeper" | "signoff_lawyer";

export interface TrustActorRow {
  id: string;
  role: string;
  roleLabel: string | null;
  status: string;
  displayName: string;
}

export interface TrustActor extends TrustActorRow {
  permissions: ReadonlySet<TrustAction>;
}

const STAFF_ROLES = new Set(["firm_admin", "attorney", "intake_staff"]);

function label(row: TrustActorRow): string {
  return (row.roleLabel ?? "").trim().toLowerCase();
}

export function isOwner(row: TrustActorRow): boolean {
  return row.role === "firm_admin" || (STAFF_ROLES.has(row.role) && label(row) === "owner");
}

export function isBookkeeper(row: TrustActorRow): boolean {
  return STAFF_ROLES.has(row.role) && label(row) === "bookkeeper";
}

export function isLawyer(row: TrustActorRow): boolean {
  return row.role === "attorney";
}

/** Pure: the trust actions a user row allows. */
export function trustPermissions(row: TrustActorRow): Set<TrustAction> {
  const out = new Set<TrustAction>();
  if (row.status !== "active") return out;
  const poster = isOwner(row) || isBookkeeper(row);
  if (poster || isLawyer(row)) out.add("read");
  if (poster) {
    out.add("post");
    out.add("reconcile");
    out.add("signoff_bookkeeper");
  }
  if (isLawyer(row)) out.add("signoff_lawyer");
  return out;
}

export function toActor(row: TrustActorRow): TrustActor {
  return { ...row, permissions: trustPermissions(row) };
}

export function can(actor: TrustActor, action: TrustAction): boolean {
  return actor.permissions.has(action);
}

export function signoffAction(role: SignoffRole): TrustAction {
  return role === "lawyer" ? "signoff_lawyer" : "signoff_bookkeeper";
}

const ACTION_WORDS: Record<TrustAction, string> = {
  read: "view trust records",
  post: "record trust entries",
  reconcile: "prepare trust reconciliations",
  signoff_bookkeeper: "sign off a reconciliation as bookkeeper",
  signoff_lawyer: "sign off a reconciliation as the lawyer",
};

export function assertCan(actor: TrustActor, action: TrustAction): void {
  if (!can(actor, action)) {
    throw new TrustRuleError("NOT_ALLOWED", `Not allowed: only the firm owner or bookkeeper (or a lawyer, for lawyer sign-off) can ${ACTION_WORDS[action]}.`, {
      action,
    });
  }
}

/** Load the acting user from `users` (RLS-scoped, plus an explicit tenant filter). Unknown users get no permissions. */
export async function loadTrustActor(tx: TenantTx, tenantId: string, userId: string): Promise<TrustActor> {
  const [row] = await tx
    .select({ id: users.id, role: users.role, roleLabel: users.roleLabel, status: users.status, displayName: users.displayName })
    .from(users)
    .where(and(eq(users.tenantId, tenantId), eq(users.id, userId)))
    .limit(1);
  if (!row) return toActor({ id: userId, role: "none", roleLabel: null, status: "unknown", displayName: "Unknown user" });
  return toActor(row);
}
