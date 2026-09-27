// Flags: every alert on the board (c40–c64). A flag has an AUDIENCE:
//   'internal' — firm users only (founder rule: overdue flags, stall flags,
//                health meter, routing — never shown or sent to a client);
//   'client'   — the client only (rare);
//   'both'     — client side AND firm side (c46, c49, c50).
//
// Founder rule (c51): every flag ALSO emails the affected party, separately
// from the in-app notification. raiseFlag() does both, through the
// notification outbox, following the audience — an internal flag can never
// be addressed to a client (enforced here AND by a CHECK constraint).

import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { flags } from "@/db/tables/foundation";
import type { TenantTx } from "@/tenancy/withTenant";
import { hasGate, legalCopy } from "@/compliance/approvals";
import { NOTIFY_COPY_GATES } from "@/compliance/gates";
import { audit, SYSTEM_ACTOR, type Actor } from "./audit";
import { enqueueNotification, type NotificationChannel, type NotificationRecipient } from "./notify";
import { clientVisible, type FlagAudience } from "./visibility";

export { clientVisible, isClientVisible, assertClientVisible, type FlagAudience } from "./visibility";

export type FlagSeverity = "info" | "warning" | "high" | "critical";
export const FLAG_SEVERITIES: readonly FlagSeverity[] = ["info", "warning", "high", "critical"];
export type FlagRow = typeof flags.$inferSelect;

/** Default client wording for client/both flags. */
export const DEFAULT_CLIENT_FLAG_COPY = NOTIFY_COPY_GATES.flagUpdate.key;

/** Internal template key used for staff notifications about a flag. */
export const INTERNAL_FLAG_TEMPLATE = "flag.internal";

export interface RaiseFlagInput {
  tenantId: string;
  /** Namespaced type, e.g. 'task.overdue', 'billing.retainer_below_floor'. */
  type: string;
  severity: FlagSeverity;
  audience: FlagAudience;
  /** Internal headline (never shown to clients). */
  title: string;
  /** Internal detail text (never shown to clients). */
  summary?: string | null;
  /** Internal structured detail (never shown to clients). */
  details?: Record<string, unknown>;
  matterId?: string | null;
  taskId?: string | null;
  recipients: { userIds?: string[]; partyIds?: string[] };
  /** Client wording gate for client/both flags (defaults to 'notify.client.flag_update'). */
  clientCopyKey?: string | null;
  /** One open flag per key; raising again while open returns the existing flag. */
  dedupeKey?: string | null;
  /** Urgent: ignores quiet hours (e.g. deadline-related, c44). */
  urgent?: boolean;
  /** Sensitive: honours "no sensitive email" preferences (DV-safe). */
  sensitive?: boolean;
  raisedBy?: Actor;
  sourceCard?: string | null;
  /** Engine slug recorded in the audit trail. */
  engine?: string;
  /** Channels to notify on (default in_app + email, per the founder rule). */
  channels?: NotificationChannel[];
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Validation errors for a flag (empty array = valid). */
export function validateFlagInput(input: RaiseFlagInput): string[] {
  const errors: string[] = [];
  const userIds = input.recipients.userIds ?? [];
  const partyIds = input.recipients.partyIds ?? [];
  if (!/^[a-z0-9_-]+(\.[a-z0-9_-]+)+$/.test(input.type)) {
    errors.push(`type '${input.type}' must be namespaced, e.g. 'task.overdue'.`);
  }
  if (!FLAG_SEVERITIES.includes(input.severity)) errors.push(`unknown severity '${input.severity}'.`);
  if (!["internal", "client", "both"].includes(input.audience)) errors.push(`unknown audience '${input.audience}'.`);
  if (!input.title.trim()) errors.push("title is required.");
  if (input.audience === "internal" && partyIds.length > 0) {
    errors.push("internal flags can never be addressed to a client (founder rule).");
  }
  if (input.audience !== "internal") {
    const key = input.clientCopyKey ?? DEFAULT_CLIENT_FLAG_COPY;
    if (!hasGate(key)) errors.push(`clientCopyKey '${key}' is not a defined approval gate.`);
    if (partyIds.length === 0) errors.push(`a '${input.audience}' flag needs at least one client party recipient.`);
  }
  if (input.audience === "client" && userIds.length > 0) {
    errors.push("use audience 'both' to notify firm users as well as the client.");
  }
  if (userIds.length === 0 && partyIds.length === 0) {
    errors.push("a flag needs at least one recipient — a flag must never silently go nowhere (c51).");
  }
  return errors;
}

export interface PlannedNotification {
  channel: NotificationChannel;
  recipient: NotificationRecipient;
  templateKey: string;
  payload: Record<string, unknown>;
}

/**
 * The notifications a flag produces: for each recipient, one row per channel
 * (in_app + email by default). Staff get the internal title/summary; clients
 * get only the approved client wording plus the flag id. Pure.
 */
export function planFlagNotifications(
  flag: Pick<
    FlagRow,
    "id" | "audience" | "title" | "summary" | "severity" | "type" | "recipientUserIds" | "recipientPartyIds" | "clientCopyKey"
  >,
  channels: NotificationChannel[] = ["in_app", "email"],
  only?: { userIds?: string[]; partyIds?: string[] }
): PlannedNotification[] {
  const planned: PlannedNotification[] = [];
  const userIds = only?.userIds ?? flag.recipientUserIds;
  const partyIds = flag.audience === "internal" ? [] : only?.partyIds ?? flag.recipientPartyIds;
  for (const userId of userIds) {
    for (const channel of channels) {
      planned.push({
        channel,
        recipient: { type: "user", userId },
        templateKey: INTERNAL_FLAG_TEMPLATE,
        payload: {
          flagId: flag.id,
          type: flag.type,
          severity: flag.severity,
          subject: `[${flag.severity.toUpperCase()}] ${flag.title}`,
          body: flag.summary ?? flag.title,
        },
      });
    }
  }
  for (const partyId of partyIds) {
    for (const channel of channels) {
      planned.push({
        channel,
        recipient: { type: "party", partyId },
        templateKey: flag.clientCopyKey ?? DEFAULT_CLIENT_FLAG_COPY,
        payload: { flagId: flag.id },
      });
    }
  }
  return planned;
}

// ---------------------------------------------------------------------------
// Database operations
// ---------------------------------------------------------------------------

/** Raise a flag and queue its in-app + email notifications. Idempotent per open dedupeKey. */
export async function raiseFlag(
  tx: TenantTx,
  input: RaiseFlagInput,
  opts: { now?: Date } = {}
): Promise<{ flag: FlagRow; created: boolean }> {
  const errors = validateFlagInput(input);
  if (errors.length > 0) throw new Error(`raiseFlag: ${errors.join(" ")}`);
  const raisedBy = input.raisedBy ?? SYSTEM_ACTOR;

  if (input.dedupeKey) {
    const existing = await findOpenFlagByDedupeKey(tx, input.tenantId, input.dedupeKey);
    if (existing) return { flag: existing, created: false };
  }

  const [flag] = await tx
    .insert(flags)
    .values({
      tenantId: input.tenantId,
      type: input.type,
      severity: input.severity,
      audience: input.audience,
      matterId: input.matterId ?? null,
      taskId: input.taskId ?? null,
      title: input.title,
      summary: input.summary ?? null,
      details: input.details ?? {},
      clientCopyKey: input.audience === "internal" ? null : input.clientCopyKey ?? DEFAULT_CLIENT_FLAG_COPY,
      recipientUserIds: [...new Set(input.recipients.userIds ?? [])],
      recipientPartyIds: input.audience === "internal" ? [] : [...new Set(input.recipients.partyIds ?? [])],
      dedupeKey: input.dedupeKey ?? null,
      urgent: input.urgent ?? false,
      sensitive: input.sensitive ?? false,
      raisedByType: raisedBy.type,
      raisedByUserId: raisedBy.type === "user" ? raisedBy.userId : null,
      sourceCard: input.sourceCard ?? null,
      ...(opts.now ? { createdAt: opts.now } : {}),
    })
    .onConflictDoNothing()
    .returning();

  if (!flag) {
    // Lost a race on the open-dedupe unique index: return the winner.
    const existing = input.dedupeKey ? await findOpenFlagByDedupeKey(tx, input.tenantId, input.dedupeKey) : undefined;
    if (!existing) throw new Error("raiseFlag: insert conflicted but no open flag was found.");
    return { flag: existing, created: false };
  }

  await notifyForFlag(tx, flag, input.channels, undefined, opts.now);
  await audit(tx, {
    tenantId: input.tenantId,
    engine: input.engine ?? "core",
    action: "flag.raised",
    entityType: "flag",
    entityId: flag.id,
    matterId: flag.matterId,
    actor: raisedBy,
    payload: { type: flag.type, severity: flag.severity, audience: flag.audience, taskId: flag.taskId },
  });
  return { flag, created: true };
}

async function notifyForFlag(
  tx: TenantTx,
  flag: FlagRow,
  channels: NotificationChannel[] | undefined,
  only?: { userIds?: string[]; partyIds?: string[] },
  now?: Date
): Promise<void> {
  for (const n of planFlagNotifications(flag, channels, only)) {
    await enqueueNotification(
      tx,
      {
        tenantId: flag.tenantId,
        channel: n.channel,
        recipient: n.recipient,
        templateKey: n.templateKey,
        payload: n.payload,
        matterId: flag.matterId,
        flagId: flag.id,
        urgent: flag.urgent,
        sensitive: flag.sensitive,
      },
      { now }
    );
  }
}

async function findOpenFlagByDedupeKey(tx: TenantTx, tenantId: string, dedupeKey: string): Promise<FlagRow | undefined> {
  const [row] = await tx
    .select()
    .from(flags)
    .where(and(eq(flags.tenantId, tenantId), eq(flags.dedupeKey, dedupeKey), isNull(flags.resolvedAt)))
    .limit(1);
  return row;
}

function requireReason(reason: string | null | undefined, what: string): string {
  const r = reason?.trim();
  if (!r) throw new Error(`${what}: a reason is required — flags are never cleared silently (c45).`);
  return r;
}

/** Resolve a flag with a logged reason (and optional check-back date, c47). */
export async function resolveFlag(
  tx: TenantTx,
  input: { tenantId: string; flagId: string; by: Actor; reason: string; checkBackAt?: Date | null; engine?: string; at?: Date }
): Promise<FlagRow> {
  const reason = requireReason(input.reason, "resolveFlag");
  const [row] = await tx
    .update(flags)
    .set({
      resolvedAt: input.at ?? new Date(),
      resolvedByUserId: input.by.type === "user" ? input.by.userId : null,
      resolutionReason: reason,
      checkBackAt: input.checkBackAt ?? null,
    })
    .where(and(eq(flags.tenantId, input.tenantId), eq(flags.id, input.flagId), isNull(flags.resolvedAt)))
    .returning();
  if (!row) throw new Error(`resolveFlag: open flag ${input.flagId} not found.`);
  await audit(tx, {
    tenantId: input.tenantId,
    engine: input.engine ?? "core",
    action: "flag.resolved",
    entityType: "flag",
    entityId: row.id,
    matterId: row.matterId,
    actor: input.by,
    reason,
    payload: { type: row.type, checkBackAt: input.checkBackAt?.toISOString() ?? null },
  });
  return row;
}

/** Resolve every open flag attached to a task (task completed / reassigned / re-dated). Returns the count. */
export async function resolveFlagsForTask(
  tx: TenantTx,
  input: { tenantId: string; taskId: string; by: Actor; reason: string; engine?: string }
): Promise<number> {
  const reason = requireReason(input.reason, "resolveFlagsForTask");
  const open = await tx
    .select({ id: flags.id })
    .from(flags)
    .where(and(eq(flags.tenantId, input.tenantId), eq(flags.taskId, input.taskId), isNull(flags.resolvedAt)));
  for (const f of open) {
    await resolveFlag(tx, { tenantId: input.tenantId, flagId: f.id, by: input.by, reason, engine: input.engine });
  }
  return open.length;
}

/** A person acknowledged the flag (e.g. a court-notice alert, c64). Does not resolve it. */
export async function acknowledgeFlag(
  tx: TenantTx,
  input: { tenantId: string; flagId: string; userId: string; engine?: string; at?: Date }
): Promise<FlagRow> {
  const [row] = await tx
    .update(flags)
    .set({ acknowledgedAt: input.at ?? new Date(), acknowledgedByUserId: input.userId })
    .where(and(eq(flags.tenantId, input.tenantId), eq(flags.id, input.flagId)))
    .returning();
  if (!row) throw new Error(`acknowledgeFlag: flag ${input.flagId} not found.`);
  await audit(tx, {
    tenantId: input.tenantId,
    engine: input.engine ?? "core",
    action: "flag.acknowledged",
    entityType: "flag",
    entityId: row.id,
    matterId: row.matterId,
    actor: { type: "user", userId: input.userId },
  });
  return row;
}

/**
 * Escalate an open flag: bump the level, optionally raise severity, and add
 * firm users (supervisor, admin, backup lawyer). Only the NEW recipients are
 * notified. Escalation never adds client recipients.
 */
export async function escalateFlag(
  tx: TenantTx,
  input: {
    tenantId: string;
    flagId: string;
    addUserIds: string[];
    severity?: FlagSeverity;
    note?: string;
    by?: Actor;
    engine?: string;
    at?: Date;
  }
): Promise<FlagRow> {
  const [current] = await tx
    .select()
    .from(flags)
    .where(and(eq(flags.tenantId, input.tenantId), eq(flags.id, input.flagId), isNull(flags.resolvedAt)))
    .limit(1);
  if (!current) throw new Error(`escalateFlag: open flag ${input.flagId} not found.`);
  const newUserIds = [...new Set(input.addUserIds)].filter((id) => !current.recipientUserIds.includes(id));
  const severity =
    input.severity && FLAG_SEVERITIES.indexOf(input.severity) > FLAG_SEVERITIES.indexOf(current.severity as FlagSeverity)
      ? input.severity
      : current.severity;
  const [row] = await tx
    .update(flags)
    .set({
      escalationLevel: current.escalationLevel + 1,
      lastEscalatedAt: input.at ?? new Date(),
      severity,
      recipientUserIds: [...current.recipientUserIds, ...newUserIds],
    })
    .where(and(eq(flags.tenantId, input.tenantId), eq(flags.id, current.id)))
    .returning();
  if (!row) throw new Error("escalateFlag: update failed.");
  if (newUserIds.length > 0) await notifyForFlag(tx, row, undefined, { userIds: newUserIds, partyIds: [] }, input.at);
  await audit(tx, {
    tenantId: input.tenantId,
    engine: input.engine ?? "core",
    action: "flag.escalated",
    entityType: "flag",
    entityId: row.id,
    matterId: row.matterId,
    actor: input.by ?? SYSTEM_ACTOR,
    reason: input.note ?? null,
    payload: { level: row.escalationLevel, severity: row.severity, addedUserIds: newUserIds },
  });
  return row;
}

/** Firm-side flag list (any audience). Staff only — never call from a client route. */
export async function listInternalFlags(
  tx: TenantTx,
  tenantId: string,
  filter: { matterId?: string; userId?: string; openOnly?: boolean; types?: string[]; limit?: number } = {}
): Promise<FlagRow[]> {
  const conds = [eq(flags.tenantId, tenantId)];
  if (filter.openOnly ?? true) conds.push(isNull(flags.resolvedAt));
  if (filter.matterId) conds.push(eq(flags.matterId, filter.matterId));
  if (filter.userId) conds.push(sql`${filter.userId}::uuid = any(${flags.recipientUserIds})`);
  if (filter.types && filter.types.length > 0) conds.push(inArray(flags.type, filter.types));
  return tx
    .select()
    .from(flags)
    .where(and(...conds))
    .orderBy(desc(flags.createdAt))
    .limit(filter.limit ?? 200);
}

/** What a client may see of a flag: the approved client wording and nothing internal. */
export interface ClientFlagView {
  id: string;
  matterId: string | null;
  createdAt: Date;
  resolved: boolean;
  /** legalCopy(clientCopyKey) — a visible placeholder until the wording is approved. */
  message: string;
}

/**
 * Client-facing flag list for one party. Filters in SQL (audience client/both
 * AND addressed to this party) and again with clientVisible(), then projects
 * to ClientFlagView so internal title/summary/details can never leak.
 */
export async function listClientFlags(
  tx: TenantTx,
  tenantId: string,
  partyId: string,
  filter: { matterId?: string; openOnly?: boolean; vars?: Record<string, string> } = {}
): Promise<ClientFlagView[]> {
  const conds = [
    eq(flags.tenantId, tenantId),
    inArray(flags.audience, ["client", "both"]),
    sql`${partyId}::uuid = any(${flags.recipientPartyIds})`,
  ];
  if (filter.openOnly ?? true) conds.push(isNull(flags.resolvedAt));
  if (filter.matterId) conds.push(eq(flags.matterId, filter.matterId));
  const rows = await tx.select().from(flags).where(and(...conds)).orderBy(desc(flags.createdAt));
  return clientVisible(rows).map((f) => ({
    id: f.id,
    matterId: f.matterId,
    createdAt: f.createdAt,
    resolved: f.resolvedAt !== null,
    message: legalCopy(f.clientCopyKey ?? DEFAULT_CLIENT_FLAG_COPY, filter.vars),
  }));
}
