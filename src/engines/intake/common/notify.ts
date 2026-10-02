// Thin wrappers over the shared notification outbox (src/core/notify.ts).
// Client (party) messages carry ids only and use an approval-gated template
// key; the core holds them while the wording or the vendor is pending, and
// picks the DV-safe address. Staff messages carry a short internal subject
// and body with no case narrative (c66 rule 9, c48 §7).

import type { TenantTx } from "@/tenancy/withTenant";
import { enqueueNotification, type NotificationChannel } from "@/core/notify";

export async function notifyParty(
  tx: TenantTx,
  input: {
    tenantId: string;
    partyId: string;
    templateKey: string;
    channels: NotificationChannel[];
    matterId?: string | null;
    /** Used to build per-channel dedupe keys: `${dedupeBase}:${channel}`. */
    dedupeBase?: string;
    urgent?: boolean;
    sensitive?: boolean;
    notBefore?: Date | null;
    payload?: Record<string, unknown>;
  },
  opts: { now?: Date } = {}
): Promise<Array<{ channel: NotificationChannel; status: string; reason: string | null }>> {
  const out: Array<{ channel: NotificationChannel; status: string; reason: string | null }> = [];
  for (const channel of input.channels) {
    const row = await enqueueNotification(
      tx,
      {
        tenantId: input.tenantId,
        channel,
        recipient: { type: "party", partyId: input.partyId },
        templateKey: input.templateKey,
        payload: input.payload ?? {},
        matterId: input.matterId ?? null,
        urgent: input.urgent,
        sensitive: input.sensitive,
        notBefore: input.notBefore ?? null,
        dedupeKey: input.dedupeBase ? `${input.dedupeBase}:${channel}` : null,
      },
      opts
    );
    out.push({ channel, status: row.status, reason: row.lastError });
  }
  return out;
}

export async function notifyStaff(
  tx: TenantTx,
  input: {
    tenantId: string;
    userIds: readonly string[];
    templateKey: string;
    subject: string;
    body: string;
    channels?: NotificationChannel[];
    matterId?: string | null;
    dedupeBase?: string;
    urgent?: boolean;
  },
  opts: { now?: Date } = {}
): Promise<number> {
  let count = 0;
  for (const userId of new Set(input.userIds)) {
    for (const channel of input.channels ?? (["in_app", "email"] as NotificationChannel[])) {
      await enqueueNotification(
        tx,
        {
          tenantId: input.tenantId,
          channel,
          recipient: { type: "user", userId },
          templateKey: input.templateKey,
          payload: { subject: input.subject, body: input.body },
          matterId: input.matterId ?? null,
          urgent: input.urgent,
          dedupeKey: input.dedupeBase ? `${input.dedupeBase}:${userId}:${channel}` : null,
        },
        opts
      );
      count++;
    }
  }
  return count;
}
