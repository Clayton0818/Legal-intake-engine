// Platform tables: staff authentication & RBAC (c34) and embeddable-widget
// configuration (c38). Same conventions as ./foundation.ts: NOT NULL tenantId
// -> firms.id on every row, text + CHECK for statuses, timestamptz for times.
//
// Tenant resolution never needs a cross-tenant lookup: a vendor session token
// carries a signed tenant claim and a widget public key embeds its tenant id,
// so every read below runs inside withTenant(tenantId) under RLS.

import { sql } from "drizzle-orm";
import { pgTable, uuid, text, boolean, timestamp, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { firms, users } from "../schema";

// ---------------------------------------------------------------------------
// c34 — auth identities
// ---------------------------------------------------------------------------

/**
 * Links an external identity (the auth vendor's subject id) to a firm user.
 * A session is accepted only when its (provider, subject) pair maps to an
 * ACTIVE user of the tenant named in the token's signed tenant claim.
 */
export const authIdentities = pgTable("auth_identities", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  userId: uuid("user_id").notNull().references(() => users.id),
  /** 'clerk' | 'workos' | 'dev' … (the AuthProvider's name). */
  provider: text("provider").notNull(),
  /** The vendor's stable subject id (e.g. Clerk user id). */
  subject: text("subject").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  disabledAt: timestamp("disabled_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("auth_identities_provider_subject_key").on(table.tenantId, table.provider, table.subject),
  index("auth_identities_tenant_user_idx").on(table.tenantId, table.userId),
]);

// ---------------------------------------------------------------------------
// c34 — capabilities layered on top of users.role
// ---------------------------------------------------------------------------

/**
 * Extra capabilities granted to a user on top of their role (see
 * src/auth/rbac.ts). History is kept: a revoke sets revokedAt + reason, and a
 * fresh grant inserts a new row.
 */
export const userCapabilities = pgTable("user_capabilities", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  userId: uuid("user_id").notNull().references(() => users.id),
  /** 'conflicts_attorney' | 'bookkeeper'. */
  capability: text("capability").notNull(),
  grantedByUserId: uuid("granted_by_user_id").references(() => users.id),
  grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
  grantReason: text("grant_reason").notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokedByUserId: uuid("revoked_by_user_id").references(() => users.id),
  revokeReason: text("revoke_reason"),
}, (table) => [
  index("user_capabilities_tenant_user_idx").on(table.tenantId, table.userId),
  uniqueIndex("user_capabilities_active_key")
    .on(table.tenantId, table.userId, table.capability)
    .where(sql`${table.revokedAt} is null`),
  check("user_capabilities_capability_check", sql`${table.capability} in ('conflicts_attorney','bookkeeper')`),
  check(
    "user_capabilities_revoke_reason_check",
    sql`${table.revokedAt} is null or ${table.revokeReason} is not null`
  ),
]);

// ---------------------------------------------------------------------------
// c38 — embeddable widget installs
// ---------------------------------------------------------------------------

/**
 * One row per place a firm embeds the intake widget. The public key is not a
 * secret (it sits in the firm's page source); the ORIGIN ALLOWLIST is the
 * control. Only the key's hash is stored.
 */
export const widgetEmbeds = pgTable("widget_embeds", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  label: text("label").notNull(),
  /** sha256 hex of the key's secret part (see src/widget/keys.ts). */
  keyHash: text("key_hash").notNull(),
  /** Exact origins ('https://firm.com') or one-level wildcards ('https://*.firm.com'). */
  allowedOrigins: text("allowed_origins").array().notNull().default(sql`'{}'::text[]`),
  enabled: boolean("enabled").notNull().default(true),
  createdByUserId: uuid("created_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("widget_embeds_key_hash_key").on(table.tenantId, table.keyHash),
]);

// ---------------------------------------------------------------------------
// MIGRATION NOTES for the integration step (hand-add to the generated SQL):
//
// 1. RLS + tenant_isolation policy (same text as migrations/0000) on:
//    auth_identities, user_capabilities, widget_embeds.
// 2. GRANT SELECT, INSERT, UPDATE ON auth_identities, user_capabilities,
//    widget_embeds TO app_runtime;  (no DELETE: capability history and
//    identity links are kept; disable/revoke instead.)
// ---------------------------------------------------------------------------
