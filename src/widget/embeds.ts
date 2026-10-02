// c38 — widget embed records (DB). All reads/writes run inside withTenant().

import { and, desc, eq } from "drizzle-orm";
import { widgetEmbeds } from "@/db/tables/platform";
import type { TenantTx } from "@/tenancy/withTenant";
import { audit } from "@/core/audit";
import { getFirmSettings } from "@/core/firmSettings";
import { legalCopyStatus } from "@/compliance/approvals";
import { assertCan } from "@/auth/rbac";
import { actorFor } from "@/auth/principal";
import type { Principal } from "@/auth/types";
import { PLATFORM_GATES } from "@/engines/platform/gates";
import { generateWidgetKey, hashWidgetSecret, originAllowed, parseWidgetKey, validateAllowedOrigins } from "./keys";

export type WidgetEmbedRow = typeof widgetEmbeds.$inferSelect;

export async function createWidgetEmbed(
  tx: TenantTx,
  input: { by: Principal; label: string; allowedOrigins: string[] }
): Promise<{ embed: WidgetEmbedRow; key: string }> {
  assertCan(input.by, "widget.manage");
  const label = input.label.trim();
  if (!label) throw new Error("A label is required.");
  const { origins, invalid } = validateAllowedOrigins(input.allowedOrigins);
  if (invalid.length > 0) throw new Error(`Not a valid https origin: ${invalid.join(", ")}`);
  if (origins.length === 0) throw new Error("At least one allowed origin is required.");

  const { key, keyHash } = generateWidgetKey(input.by.tenantId);
  const [embed] = await tx
    .insert(widgetEmbeds)
    .values({ tenantId: input.by.tenantId, label, keyHash, allowedOrigins: origins, createdByUserId: input.by.userId })
    .returning();
  if (!embed) throw new Error("createWidgetEmbed: insert failed.");
  await audit(tx, {
    tenantId: input.by.tenantId,
    engine: "platform",
    action: "widget.embed_created",
    entityType: "widget_embed",
    entityId: embed.id,
    actor: actorFor(input.by),
    payload: { label, allowedOrigins: origins },
  });
  return { embed, key };
}

export async function listWidgetEmbeds(tx: TenantTx, tenantId: string): Promise<WidgetEmbedRow[]> {
  return tx.select().from(widgetEmbeds).where(eq(widgetEmbeds.tenantId, tenantId)).orderBy(desc(widgetEmbeds.createdAt));
}

export async function setWidgetEmbedEnabled(tx: TenantTx, input: { by: Principal; embedId: string; enabled: boolean; reason: string }) {
  assertCan(input.by, "widget.manage");
  if (!input.reason.trim()) throw new Error("A reason is required.");
  const [row] = await tx
    .update(widgetEmbeds)
    .set({ enabled: input.enabled, updatedAt: new Date() })
    .where(and(eq(widgetEmbeds.tenantId, input.by.tenantId), eq(widgetEmbeds.id, input.embedId)))
    .returning();
  if (!row) throw new Error("Embed not found.");
  await audit(tx, {
    tenantId: input.by.tenantId,
    engine: "platform",
    action: input.enabled ? "widget.embed_enabled" : "widget.embed_disabled",
    entityType: "widget_embed",
    entityId: row.id,
    actor: actorFor(input.by),
    reason: input.reason.trim(),
  });
  return row;
}

export type WidgetResolution =
  | { ok: true; tenantId: string; embed: WidgetEmbedRow }
  | { ok: false; reason: "bad_key" | "unknown_key" | "disabled" | "origin_not_allowed" };

/** Pure-ish first step: which tenant does a key claim? (No DB.) */
export function tenantForWidgetKey(key: string | null | undefined): string | null {
  return parseWidgetKey(key)?.tenantId ?? null;
}

/**
 * Resolve a widget key inside withTenant(tenantForWidgetKey(key)). `hostOrigin`
 * is the embedding page's origin (location.ancestorOrigins where the browser
 * provides it); null skips the allowlist check only when `requireOrigin` is false.
 */
export async function resolveWidgetEmbed(
  tx: TenantTx,
  key: string,
  hostOrigin: string | null,
  opts: { requireOrigin?: boolean } = {}
): Promise<WidgetResolution> {
  const parsed = parseWidgetKey(key);
  if (!parsed) return { ok: false, reason: "bad_key" };
  const [embed] = await tx
    .select()
    .from(widgetEmbeds)
    .where(and(eq(widgetEmbeds.tenantId, parsed.tenantId), eq(widgetEmbeds.keyHash, hashWidgetSecret(parsed.secret))))
    .limit(1);
  if (!embed) return { ok: false, reason: "unknown_key" };
  if (!embed.enabled) return { ok: false, reason: "disabled" };
  if (hostOrigin || (opts.requireOrigin ?? true)) {
    if (!originAllowed(hostOrigin, embed.allowedOrigins)) return { ok: false, reason: "origin_not_allowed" };
  }
  return { ok: true, tenantId: parsed.tenantId, embed };
}

export interface WidgetPublicConfig {
  firmName: string;
  /** Approved notice, or the visible [PENDING ATTORNEY REVIEW …] placeholder. */
  notice: string;
  noticeApproved: boolean;
}

export async function widgetPublicConfig(tx: TenantTx, tenantId: string): Promise<WidgetPublicConfig> {
  const settings = await getFirmSettings(tx, tenantId);
  const firmName = settings.emailFromName?.trim() || "our firm";
  const copy = legalCopyStatus(PLATFORM_GATES.widgetNotice.key, { firmName });
  return { firmName, notice: copy.text, noticeApproved: copy.approved };
}
