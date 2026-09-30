// c34 — role-based access control. Pure: no database access (it only reads
// the role enum's values from the schema), so it is safe in route handlers,
// server components and tests.
//
// Model:
//   permissions(user) = ROLE_PERMISSIONS[users.role] ∪ CAPABILITY_PERMISSIONS[c]
//                       for every active capability c in user_capabilities.
//
// Roles come from the existing userRoleEnum. Two capabilities are layered on
// top because they cut across roles:
//   - conflicts_attorney: the lawyer who may CLEAR a conflict (the AI never
//     does; c3/c55). Only grantable to users whose role is 'attorney'.
//   - bookkeeper: records trust/operating ledger entries. Recording is not
//     moving money — every movement of trust money still needs the
//     rules.trust_accounting gate AND an attorney's approval permission.
//
// Guardrails baked in here (founder decisions):
//   - nobody but an attorney can confirm a deadline or approve a trust
//     disbursement; 'integration_service' and 'read_only' can never write
//     client data;
//   - deadline confirmation / conflict clearing are never AI permissions
//     (there is no AI principal at all).

import { userRoleEnum } from "@/db/schema";

export const ROLES = userRoleEnum.enumValues;
export type Role = (typeof ROLES)[number];

export const CAPABILITIES = ["conflicts_attorney", "bookkeeper"] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const PERMISSIONS = [
  "matters.read",
  "matters.write",
  "intake.read",
  "intake.manage",
  "contacts.read",
  "contacts.write",
  "documents.read",
  "documents.write",
  "documents.approve",
  "calendar.read",
  "calendar.write",
  "calendar.confirm_deadline",
  "conflicts.run",
  "conflicts.clear",
  "trust.read",
  "trust.record",
  "trust.approve_disbursement",
  "billing.read",
  "billing.write",
  "ops.view",
  "ops.act",
  "flags.acknowledge",
  "settings.manage",
  "users.manage",
  "widget.manage",
  "audit.read",
  "integration.sync",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const READ_ALL: Permission[] = [
  "matters.read",
  "intake.read",
  "contacts.read",
  "documents.read",
  "calendar.read",
  "billing.read",
];

export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  firm_admin: [
    ...READ_ALL,
    "matters.write",
    "intake.manage",
    "contacts.write",
    "documents.write",
    "calendar.write",
    "conflicts.run",
    "trust.read",
    "billing.write",
    "ops.view",
    "ops.act",
    "flags.acknowledge",
    "settings.manage",
    "users.manage",
    "widget.manage",
    "audit.read",
  ],
  attorney: [
    ...READ_ALL,
    "matters.write",
    "intake.manage",
    "contacts.write",
    "documents.write",
    "documents.approve",
    "calendar.write",
    "calendar.confirm_deadline",
    "conflicts.run",
    "trust.read",
    "trust.approve_disbursement",
    "billing.write",
    "ops.view",
    "ops.act",
    "flags.acknowledge",
    "audit.read",
  ],
  intake_staff: [
    "matters.read",
    "intake.read",
    "intake.manage",
    "contacts.read",
    "contacts.write",
    "documents.read",
    "calendar.read",
    "calendar.write",
    "conflicts.run",
    "ops.view",
    "flags.acknowledge",
  ],
  read_only: [...READ_ALL],
  integration_service: ["integration.sync", "matters.read", "calendar.read"],
};

export const CAPABILITY_PERMISSIONS: Readonly<Record<Capability, readonly Permission[]>> = {
  conflicts_attorney: ["conflicts.run", "conflicts.clear"],
  bookkeeper: ["trust.read", "trust.record", "billing.read", "billing.write"],
};

/** Which roles a capability may be granted to. */
export const CAPABILITY_ELIGIBLE_ROLES: Readonly<Record<Capability, readonly Role[]>> = {
  conflicts_attorney: ["attorney"],
  bookkeeper: ["firm_admin", "attorney", "intake_staff"],
};

/** Permissions that must never be held by anyone other than an attorney-role user, whatever the grants say. */
export const ATTORNEY_ONLY: readonly Permission[] = [
  "calendar.confirm_deadline",
  "conflicts.clear",
  "trust.approve_disbursement",
  "documents.approve",
];

export function isRole(v: unknown): v is Role {
  return typeof v === "string" && (ROLES as readonly string[]).includes(v);
}
export function isCapability(v: unknown): v is Capability {
  return typeof v === "string" && (CAPABILITIES as readonly string[]).includes(v);
}
export function isPermission(v: unknown): v is Permission {
  return typeof v === "string" && (PERMISSIONS as readonly string[]).includes(v);
}

export interface RbacSubject {
  role: Role;
  capabilities: readonly Capability[];
  /** Disabled/invited users hold no permissions. */
  status?: string;
}

/** The effective permission set. Pure. */
export function permissionsFor(subject: RbacSubject): Set<Permission> {
  const out = new Set<Permission>();
  if (subject.status && subject.status !== "active") return out;
  for (const p of ROLE_PERMISSIONS[subject.role] ?? []) out.add(p);
  for (const c of subject.capabilities) {
    if (!CAPABILITY_ELIGIBLE_ROLES[c]?.includes(subject.role)) continue; // stale/ineligible grant
    for (const p of CAPABILITY_PERMISSIONS[c]) out.add(p);
  }
  if (subject.role !== "attorney") for (const p of ATTORNEY_ONLY) out.delete(p);
  return out;
}

export function can(subject: RbacSubject, permission: Permission): boolean {
  return permissionsFor(subject).has(permission);
}

export class ForbiddenError extends Error {
  readonly status = 403;
  constructor(readonly permission: Permission) {
    super(`You do not have permission to do this (${permission}).`);
    this.name = "ForbiddenError";
  }
}

/** Throws ForbiddenError when the subject lacks the permission. */
export function assertCan(subject: RbacSubject, permission: Permission): void {
  if (!can(subject, permission)) throw new ForbiddenError(permission);
}

/** Validate a capability grant. Returns human-readable problems (empty = OK). Pure. */
export function validateCapabilityGrant(input: {
  granter: RbacSubject & { userId: string | null };
  grantee: { userId: string; role: Role; status: string };
  capability: string;
  reason: string;
}): string[] {
  const errors: string[] = [];
  if (!isCapability(input.capability)) {
    errors.push(`Unknown capability '${input.capability}'.`);
    return errors;
  }
  if (!can(input.granter, "users.manage")) errors.push("Only a user with users.manage may grant capabilities.");
  if (input.granter.userId && input.granter.userId === input.grantee.userId) {
    errors.push("Users cannot grant capabilities to themselves.");
  }
  if (input.grantee.status !== "active") errors.push("Capabilities can only be granted to active users.");
  if (!CAPABILITY_ELIGIBLE_ROLES[input.capability].includes(input.grantee.role)) {
    errors.push(
      `'${input.capability}' can only be granted to: ${CAPABILITY_ELIGIBLE_ROLES[input.capability].join(", ")}.`
    );
  }
  if (!input.reason.trim()) errors.push("A reason is required.");
  return errors;
}
