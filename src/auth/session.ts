// c34 — database side of session resolution and capability management.
// Every function takes a withTenant() transaction for the tenant named in the
// verified identity, so RLS scopes every read; tenantId is also filtered
// explicitly (defence in depth, ADR-0001 D5).

import { and, eq, isNull } from "drizzle-orm";
import { users } from "@/db/schema";
import { authIdentities, userCapabilities } from "@/db/tables/platform";
import type { TenantTx } from "@/tenancy/withTenant";
import { audit } from "@/core/audit";
import type { Env } from "./config";
import { actorFor, buildPrincipal, devPrincipal, type PrincipalUserRow } from "./principal";
import { AuthError, UUID_RE } from "./providers";
import { assertCan, isRole, validateCapabilityGrant, type Capability } from "./rbac";
import type { Principal, VerifiedIdentity } from "./types";

export const AUTH_AUDIT_ENGINE = "platform";
/** lastSeenAt is refreshed at most this often, so reads don't write on every request. */
const LAST_SEEN_THROTTLE_MS = 5 * 60_000;

async function getUserRow(tx: TenantTx, tenantId: string, userId: string): Promise<PrincipalUserRow | null> {
  const [u] = await tx
    .select({
      id: users.id,
      tenantId: users.tenantId,
      email: users.email,
      displayName: users.displayName,
      role: users.role,
      status: users.status,
    })
    .from(users)
    .where(and(eq(users.tenantId, tenantId), eq(users.id, userId)))
    .limit(1);
  if (!u || !isRole(u.role)) return null;
  return u;
}

export async function listActiveCapabilities(tx: TenantTx, tenantId: string, userId: string): Promise<Capability[]> {
  const rows = await tx
    .select({ capability: userCapabilities.capability })
    .from(userCapabilities)
    .where(
      and(eq(userCapabilities.tenantId, tenantId), eq(userCapabilities.userId, userId), isNull(userCapabilities.revokedAt))
    );
  return rows.map((r) => r.capability as Capability);
}

/** Resolve the Principal for a verified identity. Throws AuthError(403) when no active user is linked. */
export async function loadPrincipal(
  tx: TenantTx,
  identity: VerifiedIdentity,
  opts: { env?: Env; now?: Date } = {}
): Promise<Principal> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? new Date();

  if (identity.provider === "dev") {
    if (!UUID_RE.test(identity.subject)) return devPrincipal(identity, env);
    const user = await getUserRow(tx, identity.tenantId, identity.subject);
    if (!user) throw new AuthError(403, "DEV_USER_ID does not match a user in the dev tenant.", "dev_user_missing");
    const caps = await listActiveCapabilities(tx, identity.tenantId, user.id);
    return buildPrincipal({ identity, user, capabilities: caps, isDev: true });
  }

  const [link] = await tx
    .select()
    .from(authIdentities)
    .where(
      and(
        eq(authIdentities.tenantId, identity.tenantId),
        eq(authIdentities.provider, identity.provider),
        eq(authIdentities.subject, identity.subject)
      )
    )
    .limit(1);
  if (!link || link.disabledAt) {
    throw new AuthError(403, "Your sign-in is not linked to a user at this firm. Ask your firm administrator.", "identity_not_linked");
  }
  const user = await getUserRow(tx, identity.tenantId, link.userId);
  if (!user) throw new AuthError(403, "Your user record was not found.", "user_missing");
  const caps = await listActiveCapabilities(tx, identity.tenantId, user.id);
  const principal = buildPrincipal({ identity, user, capabilities: caps });

  if (!link.lastSeenAt || now.getTime() - link.lastSeenAt.getTime() > LAST_SEEN_THROTTLE_MS) {
    await tx.update(authIdentities).set({ lastSeenAt: now }).where(eq(authIdentities.id, link.id));
  }
  return principal;
}

/** Link a vendor identity to a firm user (an admin action; no auto-linking by email). */
export async function linkIdentity(
  tx: TenantTx,
  input: { by: Principal; userId: string; provider: string; subject: string; reason: string }
): Promise<{ id: string }> {
  assertCan(input.by, "users.manage");
  const tenantId = input.by.tenantId;
  if (!input.reason.trim()) throw new AuthError(403, "A reason is required.", "reason_required");
  if (!input.provider.trim() || input.provider === "dev") throw new AuthError(403, "Invalid provider.", "bad_provider");
  if (!input.subject.trim()) throw new AuthError(403, "Subject is required.", "bad_subject");
  const user = await getUserRow(tx, tenantId, input.userId);
  if (!user) throw new AuthError(403, "User not found at this firm.", "user_missing");

  const [row] = await tx
    .insert(authIdentities)
    .values({ tenantId, userId: user.id, provider: input.provider, subject: input.subject.trim() })
    .returning({ id: authIdentities.id });
  if (!row) throw new Error("linkIdentity: insert failed.");
  await audit(tx, {
    tenantId,
    engine: AUTH_AUDIT_ENGINE,
    action: "auth.identity_linked",
    entityType: "user",
    entityId: user.id,
    actor: actorFor(input.by),
    reason: input.reason.trim(),
    payload: { provider: input.provider, identityId: row.id },
  });
  return row;
}

export async function grantCapability(
  tx: TenantTx,
  input: { by: Principal; userId: string; capability: string; reason: string; now?: Date }
): Promise<{ id: string; created: boolean }> {
  const tenantId = input.by.tenantId;
  const grantee = await getUserRow(tx, tenantId, input.userId);
  if (!grantee) throw new AuthError(403, "User not found at this firm.", "user_missing");
  const errors = validateCapabilityGrant({
    granter: input.by,
    grantee: { userId: grantee.id, role: grantee.role, status: grantee.status },
    capability: input.capability,
    reason: input.reason,
  });
  if (errors.length > 0) throw new AuthError(403, errors.join(" "), "invalid_grant");

  const existing = await listActiveCapabilities(tx, tenantId, grantee.id);
  if (existing.includes(input.capability as Capability)) {
    const [row] = await tx
      .select({ id: userCapabilities.id })
      .from(userCapabilities)
      .where(
        and(
          eq(userCapabilities.tenantId, tenantId),
          eq(userCapabilities.userId, grantee.id),
          eq(userCapabilities.capability, input.capability),
          isNull(userCapabilities.revokedAt)
        )
      )
      .limit(1);
    return { id: row!.id, created: false };
  }

  const [row] = await tx
    .insert(userCapabilities)
    .values({
      tenantId,
      userId: grantee.id,
      capability: input.capability,
      grantedByUserId: input.by.userId,
      grantReason: input.reason.trim(),
      ...(input.now ? { grantedAt: input.now } : {}),
    })
    .returning({ id: userCapabilities.id });
  if (!row) throw new Error("grantCapability: insert failed.");
  await audit(tx, {
    tenantId,
    engine: AUTH_AUDIT_ENGINE,
    action: "auth.capability_granted",
    entityType: "user",
    entityId: grantee.id,
    actor: actorFor(input.by),
    reason: input.reason.trim(),
    payload: { capability: input.capability, grantId: row.id },
  });
  return { id: row.id, created: true };
}

export async function revokeCapability(
  tx: TenantTx,
  input: { by: Principal; userId: string; capability: string; reason: string; now?: Date }
): Promise<number> {
  assertCan(input.by, "users.manage");
  const reason = input.reason.trim();
  if (!reason) throw new AuthError(403, "A reason is required.", "reason_required");
  const tenantId = input.by.tenantId;
  const rows = await tx
    .update(userCapabilities)
    .set({ revokedAt: input.now ?? new Date(), revokedByUserId: input.by.userId, revokeReason: reason })
    .where(
      and(
        eq(userCapabilities.tenantId, tenantId),
        eq(userCapabilities.userId, input.userId),
        eq(userCapabilities.capability, input.capability),
        isNull(userCapabilities.revokedAt)
      )
    )
    .returning({ id: userCapabilities.id });
  if (rows.length > 0) {
    await audit(tx, {
      tenantId,
      engine: AUTH_AUDIT_ENGINE,
      action: "auth.capability_revoked",
      entityType: "user",
      entityId: input.userId,
      actor: actorFor(input.by),
      reason,
      payload: { capability: input.capability },
    });
  }
  return rows.length;
}
