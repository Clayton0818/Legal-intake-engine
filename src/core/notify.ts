// Notifications (c51): every flag and client update is delivered as separate
// rows in `notification_outbox` — one per channel — so an email failure never
// blocks the in-app notification and vice versa.
//
//   enqueueNotification(tx, {...})      write a row (in_app rows are delivered immediately)
//   drainNotificationOutbox(tx, id)     the worker hook: send pending email/SMS rows
//
// Vendors are behind EmailProvider / SmsProvider. Until the vendor's DPA is
// approved (gates 'vendor.email', 'vendor.sms') nothing is sent: rows are
// HELD with the placeholder text as the reason. The default provider is the
// StubProvider, which records what it would have sent and also holds.
//
// Client content is minimal on purpose (c51): client-facing wording comes
// only from an approved legalCopy() gate, the payload may carry only ids,
// and the address comes only from the party's safe-contact preferences.

import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { notificationOutbox } from "@/db/tables/foundation";
import { firms, parties, users } from "@/db/schema";
import type { TenantTx } from "@/tenancy/withTenant";
import {
  hasGate,
  isApproved,
  legalCopyStatus,
  PendingApprovalError,
  requireApproval,
} from "@/compliance/approvals";
import { VENDOR_GATES } from "@/compliance/gates";
import { endOfQuietTime, isQuietTime, type QuietWindow } from "./businessHours";
import { resolveClientAddress, type ContactPoints } from "./contacts";
import { getFirmSettings } from "./firmSettings";
import { audit } from "./audit";

export type NotificationChannel = "in_app" | "email" | "sms";
export type NotificationStatus =
  | "pending"
  | "held"
  | "sent"
  | "delivered"
  | "bounced"
  | "failed"
  | "suppressed"
  | "cancelled";
export type NotificationRow = typeof notificationOutbox.$inferSelect;

export type NotificationRecipient = { type: "user"; userId: string } | { type: "party"; partyId: string };

export interface EnqueueNotificationInput {
  tenantId: string;
  channel: NotificationChannel;
  recipient: NotificationRecipient;
  /** Party recipients: a legalCopy() gate key (client wording must be reviewed). Users: any internal template key. */
  templateKey: string;
  /** Party recipients: ids only (see CLIENT_PAYLOAD_ALLOWED_KEYS). Users: e.g. { subject, body }. */
  payload?: Record<string, unknown>;
  matterId?: string | null;
  flagId?: string | null;
  /** Urgent messages ignore quiet hours. */
  urgent?: boolean;
  /** Sensitive notices honour the party's "no sensitive email" preference (DV-safe). */
  sensitive?: boolean;
  /** Idempotency: one row per (tenant, dedupeKey). */
  dedupeKey?: string | null;
  /** Earliest send time (digests, scheduled reminders). */
  notBefore?: Date | null;
}

/** Keys a client-bound payload may carry — identifiers for portal deep links, never case facts. */
export const CLIENT_PAYLOAD_ALLOWED_KEYS: readonly string[] = ["flagId", "taskId", "updateId", "documentId", "invoiceId"];

export const CHANNEL_GATES = {
  email: VENDOR_GATES.email.key,
  sms: VENDOR_GATES.sms.key,
} as const;

const MAX_ATTEMPTS = 5;

// ---------------------------------------------------------------------------
// Pure planning
// ---------------------------------------------------------------------------

export function assertMinimalClientPayload(payload: Record<string, unknown>): void {
  const extra = Object.keys(payload).filter((k) => !CLIENT_PAYLOAD_ALLOWED_KEYS.includes(k));
  if (extra.length > 0) {
    throw new Error(
      `Client notifications carry ids only (c51 minimal content). Remove: ${extra.join(", ")}. ` +
        `Put details in the portal, not the message.`
    );
  }
}

export interface DeliveryPlan {
  status: "pending" | "delivered" | "suppressed";
  address: string | null;
  notBefore: Date | null;
  reason: string | null;
}

export type PlanRecipient =
  | { type: "user"; email: string | null; status?: string }
  | { type: "party"; contact: ContactPoints };

/**
 * Decide how one notification row should start life. Pure.
 *  - in_app: delivered on insert (the row IS the in-app notification);
 *  - staff email: pending to users.email; staff SMS is not supported (no phone on users);
 *  - party email/SMS: address from resolveClientAddress(), else suppressed with the reason;
 *    non-urgent party messages wait until quiet hours end.
 */
export function planDelivery(args: {
  channel: NotificationChannel;
  recipient: PlanRecipient;
  urgent?: boolean;
  sensitive?: boolean;
  now: Date;
  notBefore?: Date | null;
  quiet?: { window: QuietWindow; timeZone: string } | null;
}): DeliveryPlan {
  const { channel, recipient, now } = args;
  if (channel === "in_app") return { status: "delivered", address: null, notBefore: null, reason: null };

  if (recipient.type === "user") {
    if (recipient.status && recipient.status === "disabled") {
      return { status: "suppressed", address: null, notBefore: null, reason: "User account is disabled." };
    }
    if (channel === "sms") {
      return { status: "suppressed", address: null, notBefore: null, reason: "Staff SMS is not supported (no phone on users)." };
    }
    if (!recipient.email) return { status: "suppressed", address: null, notBefore: null, reason: "User has no email." };
    return { status: "pending", address: recipient.email, notBefore: args.notBefore ?? null, reason: null };
  }

  const decision = resolveClientAddress(recipient.contact, channel, { sensitive: args.sensitive });
  if (!decision.deliver) return { status: "suppressed", address: null, notBefore: null, reason: decision.reason };

  let notBefore = args.notBefore ?? null;
  if (!args.urgent && args.quiet) {
    const from = notBefore && notBefore > now ? notBefore : now;
    if (isQuietTime(from, args.quiet.window, args.quiet.timeZone)) {
      notBefore = endOfQuietTime(from, args.quiet.window, args.quiet.timeZone);
    }
  }
  return { status: "pending", address: decision.address, notBefore, reason: null };
}

export interface RenderedMessage {
  subject: string;
  text: string;
  /** False when the wording is still a pending-review placeholder (client messages are then held). */
  approved: boolean;
  pendingGate: string | null;
}

/**
 * Render a row into a subject + text body. Party messages use the approved
 * legalCopy() text for `templateKey` (first line "Subject: …" is the subject),
 * with only {firmName} and {portalUrl} available. Staff messages use
 * payload.subject / payload.body.
 */
export function renderNotification(
  row: Pick<NotificationRow, "recipientType" | "templateKey" | "payload">,
  ctx: { firmName: string; portalUrl: string | null }
): RenderedMessage {
  if (row.recipientType === "party") {
    const copy = legalCopyStatus(row.templateKey, {
      firmName: ctx.firmName,
      portalUrl: ctx.portalUrl ?? "your client portal",
    });
    const { subject, body } = splitSubject(copy.text, `Update from ${ctx.firmName}`);
    return { subject, text: body, approved: copy.approved, pendingGate: copy.approved ? null : row.templateKey };
  }
  const payload = row.payload ?? {};
  const subject = typeof payload.subject === "string" && payload.subject ? payload.subject : "Notification";
  const body = typeof payload.body === "string" ? payload.body : subject;
  return { subject, text: body, approved: true, pendingGate: null };
}

function splitSubject(text: string, fallback: string): { subject: string; body: string } {
  const m = /^Subject:\s*(.+)\r?\n(?:\r?\n)?/.exec(text);
  if (!m) return { subject: fallback, body: text };
  return { subject: (m[1] ?? fallback).trim(), body: text.slice(m[0].length) };
}

/** Retry backoff after a failed send: 1, 4, 9, 16 … minutes. */
export function retryDelayMs(attempts: number): number {
  return Math.max(1, attempts) ** 2 * 60_000;
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

export interface OutboundEmail {
  notificationId: string;
  tenantId: string;
  to: string;
  fromName: string;
  fromAddress: string | null;
  replyTo: string | null;
  subject: string;
  text: string;
}

export interface OutboundSms {
  notificationId: string;
  tenantId: string;
  to: string;
  text: string;
}

export interface SendResult {
  /** 'sent' = accepted by the provider; 'held' = deliberately not sent; 'failed' = try again later. */
  outcome: "sent" | "held" | "failed";
  providerMessageId?: string | null;
  detail?: string | null;
}

export interface EmailProvider {
  readonly name: string;
  /** Stubs never send; held rows are only retried for a real provider. */
  readonly isStub: boolean;
  sendEmail(message: OutboundEmail): Promise<SendResult>;
}

export interface SmsProvider {
  readonly name: string;
  readonly isStub: boolean;
  sendSms(message: OutboundSms): Promise<SendResult>;
}

/**
 * Placeholder adapter for every messaging vendor: records the message it was
 * asked to send (in memory + one log line without the body) and reports it
 * as HELD. Swap in a real adapter with setNotificationProviders() only after
 * the vendor gate is approved.
 */
export class StubProvider implements EmailProvider, SmsProvider {
  readonly name = "stub";
  readonly isStub = true;
  readonly recorded: Array<{ channel: "email" | "sms"; message: OutboundEmail | OutboundSms; at: Date }> = [];

  async sendEmail(message: OutboundEmail): Promise<SendResult> {
    return this.record("email", message);
  }

  async sendSms(message: OutboundSms): Promise<SendResult> {
    return this.record("sms", message);
  }

  private record(channel: "email" | "sms", message: OutboundEmail | OutboundSms): SendResult {
    this.recorded.push({ channel, message, at: new Date() });
    console.info(
      JSON.stringify({
        level: "info",
        event: "notify.stub_recorded",
        channel,
        notificationId: message.notificationId,
        tenantId: message.tenantId,
      })
    );
    return { outcome: "held", detail: "StubProvider: recorded, not sent — no approved vendor adapter is configured." };
  }
}

let providers: { email: EmailProvider; sms: SmsProvider } = (() => {
  const stub = new StubProvider();
  return { email: stub, sms: stub };
})();

export function getNotificationProviders(): { email: EmailProvider; sms: SmsProvider } {
  return providers;
}

/** Install real adapters (once their vendor gate is approved). Omitted channels keep their current provider. */
export function setNotificationProviders(next: { email?: EmailProvider; sms?: SmsProvider }): void {
  providers = { email: next.email ?? providers.email, sms: next.sms ?? providers.sms };
}

// ---------------------------------------------------------------------------
// Database operations
// ---------------------------------------------------------------------------

/** Queue one notification row. Returns the existing row when `dedupeKey` was already used. */
export async function enqueueNotification(
  tx: TenantTx,
  input: EnqueueNotificationInput,
  opts: { now?: Date } = {}
): Promise<NotificationRow> {
  const now = opts.now ?? new Date();
  const payload = input.payload ?? {};
  let planRecipient: PlanRecipient;
  let quiet: { window: QuietWindow; timeZone: string } | null = null;

  if (input.recipient.type === "party") {
    if (!hasGate(input.templateKey)) {
      throw new Error(
        `Client notification template '${input.templateKey}' is not an approval gate. ` +
          `Client-facing wording must come from defineGate()/legalCopy().`
      );
    }
    assertMinimalClientPayload(payload);
    const [party] = await tx
      .select()
      .from(parties)
      .where(and(eq(parties.tenantId, input.tenantId), eq(parties.id, input.recipient.partyId)))
      .limit(1);
    if (!party) throw new Error(`enqueueNotification: party ${input.recipient.partyId} not found.`);
    planRecipient = { type: "party", contact: party };
    if (input.channel !== "in_app") {
      const settings = await getFirmSettings(tx, input.tenantId);
      const window = party.safeContact?.quietHours ?? settings.quietHours;
      if (window) quiet = { window, timeZone: settings.timeZone };
    }
  } else {
    const [user] = await tx
      .select({ email: users.email, status: users.status })
      .from(users)
      .where(and(eq(users.tenantId, input.tenantId), eq(users.id, input.recipient.userId)))
      .limit(1);
    if (!user) throw new Error(`enqueueNotification: user ${input.recipient.userId} not found.`);
    planRecipient = { type: "user", email: user.email, status: user.status };
  }

  const plan = planDelivery({
    channel: input.channel,
    recipient: planRecipient,
    urgent: input.urgent,
    sensitive: input.sensitive,
    now,
    notBefore: input.notBefore ?? null,
    quiet,
  });

  const values: typeof notificationOutbox.$inferInsert = {
    tenantId: input.tenantId,
    channel: input.channel,
    recipientType: input.recipient.type,
    recipientUserId: input.recipient.type === "user" ? input.recipient.userId : null,
    recipientPartyId: input.recipient.type === "party" ? input.recipient.partyId : null,
    recipientAddress: plan.address,
    templateKey: input.templateKey,
    payload,
    matterId: input.matterId ?? null,
    flagId: input.flagId ?? null,
    urgent: input.urgent ?? false,
    status: plan.status,
    notBefore: plan.notBefore,
    lastError: plan.reason,
    dedupeKey: input.dedupeKey ?? null,
    deliveredAt: plan.status === "delivered" ? now : null,
  };

  const [inserted] = await tx.insert(notificationOutbox).values(values).onConflictDoNothing().returning();
  if (inserted) return inserted;
  if (!input.dedupeKey) throw new Error("enqueueNotification: insert failed without a dedupe conflict.");
  const [existing] = await tx
    .select()
    .from(notificationOutbox)
    .where(and(eq(notificationOutbox.tenantId, input.tenantId), eq(notificationOutbox.dedupeKey, input.dedupeKey)))
    .limit(1);
  if (!existing) throw new Error("enqueueNotification: dedupe conflict but no existing row found.");
  return existing;
}

export interface DrainResult {
  examined: number;
  sent: number;
  held: number;
  failed: number;
  suppressed: number;
}

/** What processing one outbox row decided: the column updates to apply and an optional audit entry. */
export interface OutboxRowOutcome {
  result: "delivered" | "held" | "suppressed" | "sent" | "failed";
  set: Partial<typeof notificationOutbox.$inferInsert>;
  audit?: { action: string; payload: Record<string, unknown> };
}

export interface OutboxRowContext {
  tenantId: string;
  now: Date;
  firmName: string;
  settings: { emailFromAddress: string | null; emailReplyTo: string | null; clientPortalUrl: string | null };
  providers: { email: EmailProvider; sms: SmsProvider };
}

/**
 * Decide what happens to ONE due outbox row (no database access; the only
 * side effect is the provider call). Order of checks, each failing safe:
 *  1. vendor gate ('vendor.email' / 'vendor.sms') — pending → HELD with the placeholder, logged;
 *  2. client wording gate — still a placeholder → HELD (never send placeholder text to a client);
 *  3. no destination address → SUPPRESSED;
 *  4. provider call — sent / held (stub) / failed (retried with backoff, then given up).
 */
export async function processOutboxRow(
  row: Pick<
    NotificationRow,
    "id" | "channel" | "recipientType" | "recipientAddress" | "templateKey" | "payload" | "attempts" | "notBefore" | "flagId" | "matterId"
  >,
  ctx: OutboxRowContext
): Promise<OutboxRowOutcome> {
  const { now, tenantId } = ctx;
  if (row.channel === "in_app") return { result: "delivered", set: { status: "delivered", deliveredAt: now } };
  if (row.channel !== "email" && row.channel !== "sms") {
    return { result: "suppressed", set: { status: "suppressed", lastError: `Unknown channel '${row.channel}'.` } };
  }
  const channel = row.channel;

  // 1. Vendor gate (DPA). Blocked → held + logged; never silently proceeds.
  try {
    requireApproval(CHANNEL_GATES[channel], { action: `notify.send_${channel}`, tenantId, detail: { notificationId: row.id } });
  } catch (err) {
    if (!(err instanceof PendingApprovalError)) throw err;
    return { result: "held", set: { status: "held", lastError: err.placeholder } };
  }

  // 2. Client wording must be approved before it leaves the building.
  const rendered = renderNotification(row, { firmName: ctx.firmName, portalUrl: ctx.settings.clientPortalUrl });
  if (!rendered.approved) {
    return { result: "held", set: { status: "held", lastError: `Client wording pending review: ${rendered.text}` } };
  }
  if (!row.recipientAddress) {
    return { result: "suppressed", set: { status: "suppressed", lastError: "No destination address." } };
  }

  // 3. Hand to the provider.
  const provider = channel === "email" ? ctx.providers.email : ctx.providers.sms;
  let send: SendResult;
  try {
    send =
      channel === "email"
        ? await ctx.providers.email.sendEmail({
            notificationId: row.id,
            tenantId,
            to: row.recipientAddress,
            fromName: ctx.firmName,
            fromAddress: ctx.settings.emailFromAddress,
            replyTo: ctx.settings.emailReplyTo,
            subject: rendered.subject,
            text: rendered.text,
          })
        : await ctx.providers.sms.sendSms({ notificationId: row.id, tenantId, to: row.recipientAddress, text: rendered.text });
  } catch (err) {
    send = { outcome: "failed", detail: err instanceof Error ? err.message : String(err) };
  }

  if (send.outcome === "sent") {
    return {
      result: "sent",
      set: {
        status: "sent",
        sentAt: now,
        attempts: row.attempts + 1,
        provider: provider.name,
        providerMessageId: send.providerMessageId ?? null,
        lastError: null,
      },
      audit: { action: "notification.sent", payload: { channel, provider: provider.name, flagId: row.flagId } },
    };
  }
  if (send.outcome === "held") {
    return { result: "held", set: { status: "held", provider: provider.name, lastError: send.detail ?? "Held by provider." } };
  }
  const attempts = row.attempts + 1;
  const giveUp = attempts >= MAX_ATTEMPTS;
  return {
    result: "failed",
    set: {
      status: giveUp ? "failed" : "pending",
      attempts,
      provider: provider.name,
      lastError: send.detail ?? "Send failed.",
      notBefore: giveUp ? row.notBefore : new Date(now.getTime() + retryDelayMs(attempts)),
    },
    audit: giveUp
      ? { action: "notification.failed", payload: { channel, provider: provider.name, attempts, flagId: row.flagId } }
      : undefined,
  };
}

/**
 * Worker hook: send due email/SMS rows for one tenant through the configured
 * providers. Must run inside withTenant(tenantId). Gate checks happen per
 * row, at send time, so approving a vendor takes effect on the next tick.
 * Registered as the core tick hook in src/worker/hooks.ts.
 */
export async function drainNotificationOutbox(
  tx: TenantTx,
  tenantId: string,
  opts: { now?: Date; limit?: number; providers?: { email: EmailProvider; sms: SmsProvider } } = {}
): Promise<DrainResult> {
  const now = opts.now ?? new Date();
  const active = opts.providers ?? providers;
  const result: DrainResult = { examined: 0, sent: 0, held: 0, failed: 0, suppressed: 0 };

  // Held rows are retried only for channels that could now actually send.
  const retryHeld: NotificationChannel[] = [];
  if (isApproved(CHANNEL_GATES.email) && !active.email.isStub) retryHeld.push("email");
  if (isApproved(CHANNEL_GATES.sms) && !active.sms.isStub) retryHeld.push("sms");

  const statusCond =
    retryHeld.length > 0
      ? or(
          eq(notificationOutbox.status, "pending"),
          and(eq(notificationOutbox.status, "held"), inArray(notificationOutbox.channel, retryHeld))
        )
      : eq(notificationOutbox.status, "pending");

  const rows = await tx
    .select()
    .from(notificationOutbox)
    .where(
      and(
        eq(notificationOutbox.tenantId, tenantId),
        statusCond,
        or(isNull(notificationOutbox.notBefore), lte(notificationOutbox.notBefore, now))
      )
    )
    .orderBy(asc(notificationOutbox.createdAt))
    .limit(opts.limit ?? 100)
    .for("update", { skipLocked: true });

  if (rows.length === 0) return result;

  const settings = await getFirmSettings(tx, tenantId);
  const [firm] = await tx.select({ name: firms.name }).from(firms).where(eq(firms.id, tenantId)).limit(1);
  const ctx: OutboxRowContext = {
    tenantId,
    now,
    firmName: settings.emailFromName ?? firm?.name ?? "Your law firm",
    settings,
    providers: active,
  };

  for (const row of rows) {
    result.examined++;
    const outcome = await processOutboxRow(row, ctx);
    await tx
      .update(notificationOutbox)
      .set(outcome.set)
      .where(and(eq(notificationOutbox.tenantId, tenantId), eq(notificationOutbox.id, row.id)));
    if (outcome.audit) {
      await audit(tx, {
        tenantId,
        engine: "core",
        action: outcome.audit.action,
        entityType: "notification",
        entityId: row.id,
        matterId: row.matterId,
        payload: outcome.audit.payload,
      });
    }
    if (outcome.result === "sent") result.sent++;
    else if (outcome.result === "held") result.held++;
    else if (outcome.result === "failed") result.failed++;
    else if (outcome.result === "suppressed") result.suppressed++;
  }
  return result;
}

/**
 * Record a provider delivery callback (delivered / bounced / failed). Logged
 * to the audit trail (c51 delivery tracking). A bounced CLIENT email must be
 * flagged to the lawyer by the caller (the c51 owner) — see src/core/flags.ts.
 */
export async function recordDeliveryStatus(
  tx: TenantTx,
  input: {
    tenantId: string;
    notificationId?: string;
    providerMessageId?: string;
    status: "delivered" | "bounced" | "failed";
    detail?: string;
    at?: Date;
  }
): Promise<NotificationRow | null> {
  if (!input.notificationId && !input.providerMessageId) {
    throw new Error("recordDeliveryStatus: pass notificationId or providerMessageId.");
  }
  const at = input.at ?? new Date();
  const idCond = input.notificationId
    ? eq(notificationOutbox.id, input.notificationId)
    : eq(notificationOutbox.providerMessageId, input.providerMessageId as string);
  const [row] = await tx
    .update(notificationOutbox)
    .set({
      status: input.status,
      deliveredAt: input.status === "delivered" ? at : sql`${notificationOutbox.deliveredAt}`,
      lastError: input.status === "delivered" ? null : input.detail ?? input.status,
    })
    .where(and(eq(notificationOutbox.tenantId, input.tenantId), idCond))
    .returning();
  if (!row) return null;
  await audit(tx, {
    tenantId: input.tenantId,
    engine: "core",
    action: `notification.${input.status}`,
    entityType: "notification",
    entityId: row.id,
    matterId: row.matterId,
    payload: { channel: row.channel, recipientType: row.recipientType, flagId: row.flagId, detail: input.detail ?? null },
  });
  return row;
}

/** In-app notifications for a firm user (their bell), newest first. */
export async function listInAppForUser(
  tx: TenantTx,
  tenantId: string,
  userId: string,
  opts: { unreadOnly?: boolean; limit?: number } = {}
): Promise<NotificationRow[]> {
  const conds = [
    eq(notificationOutbox.tenantId, tenantId),
    eq(notificationOutbox.channel, "in_app"),
    eq(notificationOutbox.recipientUserId, userId),
  ];
  if (opts.unreadOnly) conds.push(isNull(notificationOutbox.readAt));
  return tx
    .select()
    .from(notificationOutbox)
    .where(and(...conds))
    .orderBy(sql`${notificationOutbox.createdAt} desc`)
    .limit(opts.limit ?? 50);
}

export interface ClientInAppView {
  id: string;
  matterId: string | null;
  createdAt: Date;
  readAt: Date | null;
  /** Rendered client wording (a visible placeholder until approved). */
  message: string;
  /** Deep-link ids only. */
  links: Record<string, unknown>;
}

/** In-app notifications for a client (portal), rendered through legalCopy(); never includes internal fields. */
export async function listInAppForParty(
  tx: TenantTx,
  tenantId: string,
  partyId: string,
  ctx: { firmName: string; portalUrl: string | null },
  opts: { limit?: number } = {}
): Promise<ClientInAppView[]> {
  const rows = await tx
    .select()
    .from(notificationOutbox)
    .where(
      and(
        eq(notificationOutbox.tenantId, tenantId),
        eq(notificationOutbox.channel, "in_app"),
        eq(notificationOutbox.recipientType, "party"),
        eq(notificationOutbox.recipientPartyId, partyId)
      )
    )
    .orderBy(sql`${notificationOutbox.createdAt} desc`)
    .limit(opts.limit ?? 50);
  return rows.map((row) => {
    const rendered = renderNotification(row, ctx);
    const links: Record<string, unknown> = {};
    for (const key of CLIENT_PAYLOAD_ALLOWED_KEYS) if (row.payload[key] !== undefined) links[key] = row.payload[key];
    return {
      id: row.id,
      matterId: row.matterId,
      createdAt: row.createdAt,
      readAt: row.readAt,
      message: rendered.text,
      links,
    };
  });
}

/**
 * Mark an in-app notification read. Pass the reader as `recipient` so one
 * person can never mark another person's notification read.
 */
export async function markNotificationRead(
  tx: TenantTx,
  tenantId: string,
  notificationId: string,
  recipient: NotificationRecipient,
  at = new Date()
): Promise<boolean> {
  const recipientCond =
    recipient.type === "user"
      ? eq(notificationOutbox.recipientUserId, recipient.userId)
      : eq(notificationOutbox.recipientPartyId, recipient.partyId);
  const rows = await tx
    .update(notificationOutbox)
    .set({ readAt: at })
    .where(and(eq(notificationOutbox.tenantId, tenantId), eq(notificationOutbox.id, notificationId), recipientCond))
    .returning({ id: notificationOutbox.id });
  return rows.length > 0;
}
