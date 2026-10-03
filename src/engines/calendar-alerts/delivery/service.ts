// c51 — delivery watch and daily digest (database side). See ./plan.ts.

import { and, asc, eq, gte, inArray, isNull } from "drizzle-orm";
import { firms } from "@/db/schema";
import { flags, notificationOutbox } from "@/db/tables/foundation";
import { alertDigestItems, deliveryFollowups } from "@/db/tables/calendar-alerts";
import type { TenantTx } from "@/tenancy/withTenant";
import { requireApproval } from "@/compliance/approvals";
import { VENDOR_GATES } from "@/compliance/gates";
import { enqueueNotification, recordDeliveryStatus, type NotificationRow } from "@/core/notify";
import { getMatter, lastJobRun, listFirmAdminIds, markJobRun, raiseAlert, responsibleLawyer, type EngineContext } from "../common";
import { composeDigest, digestDue, planFollowup } from "./plan";

const WATCH_WINDOW_MS = 30 * 86_400_000;

export async function runDeliveryWatch(tx: TenantTx, ctx: EngineContext, tenantId: string, now: Date): Promise<{ followups: number }> {
  const rows = await tx
    .select({ row: notificationOutbox })
    .from(notificationOutbox)
    .leftJoin(
      deliveryFollowups,
      and(eq(deliveryFollowups.tenantId, notificationOutbox.tenantId), eq(deliveryFollowups.notificationId, notificationOutbox.id))
    )
    .where(
      and(
        eq(notificationOutbox.tenantId, tenantId),
        eq(notificationOutbox.channel, "email"),
        inArray(notificationOutbox.status, ["bounced", "failed", "suppressed"]),
        gte(notificationOutbox.createdAt, new Date(now.getTime() - WATCH_WINDOW_MS)),
        isNull(deliveryFollowups.id)
      )
    )
    .orderBy(asc(notificationOutbox.createdAt))
    .limit(200);
  let followups = 0;
  const admins = await listFirmAdminIds(tx, tenantId);
  for (const { row } of rows) {
    const plan = planFollowup(row);
    if (!plan) continue;
    let recipients = admins;
    if (plan.notify === "lawyer" && row.matterId) {
      const lawyer = await responsibleLawyer(tx, tenantId, await getMatter(tx, tenantId, row.matterId));
      if (lawyer) recipients = [lawyer];
    }
    let flagId: string | null = null;
    if (recipients.length > 0) {
      // One open "no safe address" flag per client; one flag per bounced/failed delivery.
      const dedupeKey = plan.kind === "suppressed_no_address" ? `${plan.flagType}:${row.recipientPartyId}` : `${plan.flagType}:${row.id}`;
      const res = await raiseAlert(
        tx,
        ctx,
        {
          tenantId,
          type: plan.flagType,
          severity: plan.kind === "suppressed_no_address" ? "warning" : "high",
          audience: "internal",
          title: plan.title,
          summary: plan.summary,
          details: { notificationId: row.id, recipientType: row.recipientType, recipientPartyId: row.recipientPartyId, recipientUserId: row.recipientUserId, originalFlagId: row.flagId },
          matterId: row.matterId,
          recipients: { userIds: recipients },
          dedupeKey,
          sourceCard: "c51",
          // A bounce report about a user's email must not itself go only by email.
          channels: plan.notify === "admin" && row.recipientType === "user" ? ["in_app"] : undefined,
        },
        now
      );
      flagId = res.flag.id;
    }
    await tx.insert(deliveryFollowups).values({ tenantId, notificationId: row.id, kind: plan.kind, flagId, createdAt: now }).onConflictDoNothing();
    followups++;
  }
  return { followups };
}

/** Daily digest of non-urgent internal flag emails (only when the firm turned digests on). */
export async function runDigest(tx: TenantTx, ctx: EngineContext, tenantId: string, now: Date): Promise<{ sent: number } | { skipped: string }> {
  if (!ctx.firm.internalEmailDigest) return { skipped: "digest off" };
  const job = "digest";
  if (!digestDue(await lastJobRun(tx, tenantId, job), now, ctx.firm.timeZone, ctx.alerts.digestTimeLocal)) return { skipped: "not due" };
  const pending = await tx
    .select({ id: alertDigestItems.id, userId: alertDigestItems.userId, title: flags.title, severity: flags.severity, resolvedAt: flags.resolvedAt, matterId: flags.matterId })
    .from(alertDigestItems)
    .innerJoin(flags, eq(flags.id, alertDigestItems.flagId))
    .where(and(eq(alertDigestItems.tenantId, tenantId), isNull(alertDigestItems.sentAt)))
    .limit(5000);
  const [firm] = await tx.select({ name: firms.name }).from(firms).where(eq(firms.id, tenantId)).limit(1);
  const firmName = ctx.firm.emailFromName ?? firm?.name ?? "Your firm";
  const byUser = new Map<string, typeof pending>();
  for (const p of pending) byUser.set(p.userId, [...(byUser.get(p.userId) ?? []), p]);
  let sent = 0;
  for (const [userId, items] of byUser) {
    const { subject, body } = composeDigest(items.map((i) => ({ title: i.title, severity: i.severity, resolved: i.resolvedAt !== null })), firmName);
    const row: NotificationRow = await enqueueNotification(
      tx,
      { tenantId, channel: "email", recipient: { type: "user", userId }, templateKey: "calendar-alerts.digest", payload: { subject, body, count: items.length }, dedupeKey: `calendar-alerts.digest:${userId}:${now.toISOString().slice(0, 10)}` },
      { now }
    );
    await tx
      .update(alertDigestItems)
      .set({ sentAt: now, notificationId: row.id })
      .where(and(eq(alertDigestItems.tenantId, tenantId), inArray(alertDigestItems.id, items.map((i) => i.id))));
    sent++;
  }
  await markJobRun(tx, tenantId, job, now, { users: sent, items: pending.length });
  return { sent };
}

/**
 * Provider delivery callback (sent → delivered / bounced / failed). Refused
 * while the email vendor gate is pending: no vendor is wired, so nothing can
 * legitimately report deliveries yet. Follow-up flags are raised by the
 * delivery watch on the next tick.
 */
export async function recordProviderEvent(
  tx: TenantTx,
  input: { tenantId: string; notificationId?: string; providerMessageId?: string; status: "delivered" | "bounced" | "failed"; detail?: string; at?: Date }
): Promise<NotificationRow | null> {
  requireApproval(VENDOR_GATES.email.key, { action: "calendar-alerts.email_delivery_event", tenantId: input.tenantId });
  return recordDeliveryStatus(tx, input);
}
