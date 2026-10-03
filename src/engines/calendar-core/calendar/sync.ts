// c91 — two-way sync with each lawyer's Outlook / Google calendar.
//
// VENDOR ADAPTER. Microsoft 365 and Google are subprocessors: until
// 'vendor.calendar_sync' is approved (signed DPA) nothing is pushed or pulled —
// each pending link is marked 'held' with the visible placeholder as its
// reason, and the stub provider records instead of calling anyone.
//
// Rules:
//  - the product is the source of truth for matter events: an edit made in
//    Outlook/Google to an event WE pushed never moves a court date or
//    deadline (it is logged and ignored);
//  - events created in the lawyer's own calendar come in as 'proposed',
//    non-deadline, type 'other', assigned to that lawyer (busy time); a
//    lawyer confirms them if they matter;
//  - what is pushed is minimal (title, time, place, a "proposed" marker) —
//    never the description, which may hold privileged detail.

import { and, eq, gte, inArray, isNull, ne, sql } from "drizzle-orm";
import { calendarEvents } from "@/db/tables/foundation";
import { calendarSyncConnections, calendarSyncLinks } from "@/db/tables/calendar-core";
import type { TenantTx } from "@/tenancy/withTenant";
import { isApproved, placeholderFor } from "@/compliance/approvals";
import { VENDOR_GATES } from "@/compliance/gates";
import { audit } from "@/core";
import { ENGINE } from "../settings";
import type { CalendarEventRow } from "./events";

export type SyncProviderName = "microsoft" | "google";
export type SyncOp = "create" | "update" | "delete";

export interface ConnectionRef {
  id: string;
  userId: string;
  provider: SyncProviderName;
  /** Secret-store reference, never a token. */
  tokenRef: string | null;
  externalCalendarId: string | null;
}

export interface ExternalEventPayload {
  title: string;
  startsAt: string;
  endsAt: string | null;
  allDay: boolean;
  location: string | null;
}

export interface ExternalEvent {
  externalId: string;
  etag: string | null;
  title: string;
  startsAt: Date;
  endsAt: Date | null;
  allDay: boolean;
  location: string | null;
  deleted: boolean;
}

export type PushResult = { outcome: "ok"; externalId: string; etag: string | null } | { outcome: "held" | "failed"; detail: string };
export type PullResult = { outcome: "ok"; events: ExternalEvent[]; cursor: string | null } | { outcome: "held" | "failed"; detail: string };

export interface CalendarSyncProvider {
  readonly name: string;
  readonly isStub: boolean;
  push(conn: ConnectionRef, op: SyncOp, payload: ExternalEventPayload, externalId: string | null): Promise<PushResult>;
  pull(conn: ConnectionRef, cursor: string | null, window: { from: Date; to: Date }): Promise<PullResult>;
}

/** Records what would have been sent or fetched; never calls a vendor. */
export class StubCalendarSyncProvider implements CalendarSyncProvider {
  readonly name = "stub";
  readonly isStub = true;
  readonly pushes: Array<{ conn: ConnectionRef; op: SyncOp; payload: ExternalEventPayload; externalId: string | null }> = [];
  readonly pulls: Array<{ conn: ConnectionRef; cursor: string | null }> = [];
  async push(conn: ConnectionRef, op: SyncOp, payload: ExternalEventPayload, externalId: string | null): Promise<PushResult> {
    this.pushes.push({ conn, op, payload, externalId });
    return { outcome: "held", detail: "Stub calendar provider: recorded, not sent." };
  }
  async pull(conn: ConnectionRef, cursor: string | null): Promise<PullResult> {
    this.pulls.push({ conn, cursor });
    return { outcome: "held", detail: "Stub calendar provider: recorded, not fetched." };
  }
}

let provider: CalendarSyncProvider = new StubCalendarSyncProvider();

export function getSyncProvider(): CalendarSyncProvider {
  return provider;
}

/** Swap in a real provider (only once 'vendor.calendar_sync' is approved). */
export function setSyncProvider(next: CalendarSyncProvider): void {
  provider = next;
}

export function syncApproved(): boolean {
  return isApproved(VENDOR_GATES.calendarSync.key);
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Minimal outbound payload (no description — it may be privileged). Pure. */
export function toExternalPayload(e: Pick<CalendarEventRow, "title" | "startsAt" | "endsAt" | "allDay" | "location" | "status">): ExternalEventPayload {
  return {
    title: e.status === "proposed" ? `[Proposed — not confirmed] ${e.title}` : e.title,
    startsAt: e.startsAt.toISOString(),
    endsAt: e.endsAt ? e.endsAt.toISOString() : null,
    allDay: e.allDay,
    location: e.location,
  };
}

/** What a link must do next, given the event's state. Pure. */
export function planLinkOp(eventStatus: string, link: { externalId: string | null } | null): SyncOp | "none" {
  if (eventStatus === "cancelled") return link?.externalId ? "delete" : "none";
  return link?.externalId ? "update" : "create";
}

/** Should a connection receive pushes / pulls? Pure. */
export function pushes(direction: string): boolean {
  return direction === "two_way" || direction === "push_only";
}
export function pulls(direction: string): boolean {
  return direction === "two_way" || direction === "pull_only";
}

/** Next status after a push attempt. Pure. */
export function afterPush(result: PushResult, attempts: number, maxAttempts: number): { status: "synced" | "held" | "pending" | "failed"; error: string | null } {
  if (result.outcome === "ok") return { status: "synced", error: null };
  if (result.outcome === "held") return { status: "held", error: result.detail };
  return { status: attempts >= maxAttempts ? "failed" : "pending", error: result.detail };
}

// ---------------------------------------------------------------------------
// Database operations
// ---------------------------------------------------------------------------

/** Mark every relevant sync link of an event as needing a push (called after any event change). */
export async function queueEventSync(tx: TenantTx, tenantId: string, event: CalendarEventRow, now: Date = new Date()): Promise<number> {
  if (event.assignedUserIds.length === 0) return 0;
  const conns = await tx
    .select()
    .from(calendarSyncConnections)
    .where(
      and(
        eq(calendarSyncConnections.tenantId, tenantId),
        eq(calendarSyncConnections.active, true),
        inArray(calendarSyncConnections.userId, event.assignedUserIds)
      )
    );
  let queued = 0;
  for (const c of conns) {
    if (!pushes(c.direction)) continue;
    const [link] = await tx
      .select()
      .from(calendarSyncLinks)
      .where(and(eq(calendarSyncLinks.tenantId, tenantId), eq(calendarSyncLinks.eventId, event.id), eq(calendarSyncLinks.connectionId, c.id)))
      .limit(1);
    if (link?.origin === "inbound") continue; // came from that calendar; nothing to push back
    const op = planLinkOp(event.status, link ?? null);
    if (op === "none") continue;
    if (link) {
      await tx
        .update(calendarSyncLinks)
        .set({ pendingOp: op, status: "pending", attempts: 0, updatedAt: now })
        .where(eq(calendarSyncLinks.id, link.id));
    } else {
      await tx.insert(calendarSyncLinks).values({ tenantId, eventId: event.id, connectionId: c.id, pendingOp: op, status: "pending", updatedAt: now });
    }
    queued++;
  }
  return queued;
}

function connRef(c: typeof calendarSyncConnections.$inferSelect): ConnectionRef {
  return { id: c.id, userId: c.userId, provider: c.provider as SyncProviderName, tokenRef: c.tokenRef, externalCalendarId: c.externalCalendarId };
}

/** Push pending changes. While the vendor gate is pending every link is 'held' (nothing leaves). */
export async function runOutboundSync(
  tx: TenantTx,
  tenantId: string,
  opts: { now?: Date; maxAttempts?: number; limit?: number } = {}
): Promise<{ pushed: number; held: number; failed: number }> {
  const now = opts.now ?? new Date();
  const rows = await tx
    .select({ link: calendarSyncLinks, conn: calendarSyncConnections, event: calendarEvents })
    .from(calendarSyncLinks)
    .innerJoin(calendarSyncConnections, eq(calendarSyncConnections.id, calendarSyncLinks.connectionId))
    .innerJoin(calendarEvents, eq(calendarEvents.id, calendarSyncLinks.eventId))
    .where(and(eq(calendarSyncLinks.tenantId, tenantId), eq(calendarSyncLinks.status, "pending"), ne(calendarSyncLinks.pendingOp, "none")))
    .limit(opts.limit ?? 200);
  const out = { pushed: 0, held: 0, failed: 0 };
  const approved = syncApproved();
  for (const { link, conn, event } of rows) {
    if (!conn.active) {
      await tx.update(calendarSyncLinks).set({ status: "held", lastError: "Connection disconnected.", updatedAt: now }).where(eq(calendarSyncLinks.id, link.id));
      out.held++;
      continue;
    }
    if (!approved) {
      await tx
        .update(calendarSyncLinks)
        .set({ status: "held", lastError: placeholderFor(VENDOR_GATES.calendarSync.key), updatedAt: now })
        .where(eq(calendarSyncLinks.id, link.id));
      out.held++;
      continue;
    }
    const attempts = link.attempts + 1;
    const result = await getSyncProvider().push(connRef(conn), link.pendingOp as SyncOp, toExternalPayload(event), link.externalId);
    const next = afterPush(result, attempts, opts.maxAttempts ?? 5);
    await tx
      .update(calendarSyncLinks)
      .set({
        status: next.status,
        lastError: next.error,
        attempts,
        ...(result.outcome === "ok"
          ? { externalId: link.pendingOp === "delete" ? link.externalId : result.externalId, externalEtag: result.etag, pendingOp: "none", lastSyncedAt: now }
          : {}),
        updatedAt: now,
      })
      .where(eq(calendarSyncLinks.id, link.id));
    if (next.status === "synced") {
      out.pushed++;
      await tx.update(calendarSyncConnections).set({ lastPushedAt: now, lastError: null }).where(eq(calendarSyncConnections.id, conn.id));
    } else if (next.status === "held") out.held++;
    else if (next.status === "failed") {
      out.failed++;
      await tx.update(calendarSyncConnections).set({ lastError: next.error }).where(eq(calendarSyncConnections.id, conn.id));
    }
  }
  return out;
}

/**
 * Pull changes from each lawyer's calendar. Inbound-origin events are created
 * or updated as proposed, non-deadline busy time; external edits to events
 * this product pushed are logged and ignored (we are the source of truth).
 */
export async function runInboundSync(
  tx: TenantTx,
  tenantId: string,
  opts: { now?: Date; windowDays?: number } = {}
): Promise<{ created: number; updated: number; ignored: number; held: number }> {
  const now = opts.now ?? new Date();
  const out = { created: 0, updated: 0, ignored: 0, held: 0 };
  const conns = await tx
    .select()
    .from(calendarSyncConnections)
    .where(and(eq(calendarSyncConnections.tenantId, tenantId), eq(calendarSyncConnections.active, true), isNull(calendarSyncConnections.disconnectedAt)));
  const approved = syncApproved();
  const windowMs = (opts.windowDays ?? 60) * 86_400_000;
  for (const c of conns) {
    if (!pulls(c.direction)) continue;
    if (!approved) {
      await tx.update(calendarSyncConnections).set({ lastError: placeholderFor(VENDOR_GATES.calendarSync.key) }).where(eq(calendarSyncConnections.id, c.id));
      out.held++;
      continue;
    }
    const result = await getSyncProvider().pull(connRef(c), c.pullCursor, { from: new Date(now.getTime() - windowMs), to: new Date(now.getTime() + windowMs) });
    if (result.outcome !== "ok") {
      await tx.update(calendarSyncConnections).set({ lastError: result.detail }).where(eq(calendarSyncConnections.id, c.id));
      out.held++;
      continue;
    }
    for (const ext of result.events) {
      const r = await applyInbound(tx, tenantId, c, ext, now);
      out[r]++;
    }
    await tx.update(calendarSyncConnections).set({ pullCursor: result.cursor, lastPulledAt: now, lastError: null }).where(eq(calendarSyncConnections.id, c.id));
  }
  return out;
}

async function applyInbound(
  tx: TenantTx,
  tenantId: string,
  conn: typeof calendarSyncConnections.$inferSelect,
  ext: ExternalEvent,
  now: Date
): Promise<"created" | "updated" | "ignored"> {
  const [link] = await tx
    .select()
    .from(calendarSyncLinks)
    .where(and(eq(calendarSyncLinks.tenantId, tenantId), eq(calendarSyncLinks.connectionId, conn.id), eq(calendarSyncLinks.externalId, ext.externalId)))
    .limit(1);
  if (link && link.origin === "outbound") {
    await audit(tx, {
      tenantId,
      engine: ENGINE,
      action: "calendar.sync_external_edit_ignored",
      entityType: "calendar_event",
      entityId: link.eventId,
      payload: { provider: conn.provider, externalId: ext.externalId, deleted: ext.deleted },
    });
    return "ignored";
  }
  if (link) {
    const set = ext.deleted
      ? { status: "cancelled", cancelledAt: now, cancelReason: `Deleted in the lawyer's ${conn.provider} calendar.`, updatedAt: now }
      : { title: ext.title.slice(0, 200), startsAt: ext.startsAt, endsAt: ext.endsAt, allDay: ext.allDay, location: ext.location, updatedAt: now };
    await tx
      .update(calendarEvents)
      .set(set)
      .where(and(eq(calendarEvents.tenantId, tenantId), eq(calendarEvents.id, link.eventId), eq(calendarEvents.isDeadline, false)));
    await tx.update(calendarSyncLinks).set({ externalEtag: ext.etag, lastSyncedAt: now, updatedAt: now }).where(eq(calendarSyncLinks.id, link.id));
    return "updated";
  }
  if (ext.deleted) return "ignored";
  const [event] = await tx
    .insert(calendarEvents)
    .values({
      tenantId,
      matterId: null,
      eventType: "other",
      title: ext.title.slice(0, 200) || "(busy)",
      startsAt: ext.startsAt,
      endsAt: ext.endsAt,
      allDay: ext.allDay,
      location: ext.location,
      isDeadline: false,
      source: "external_sync",
      sourceRef: `${conn.provider}:${ext.externalId}`,
      status: "proposed",
      assignedUserIds: [conn.userId],
      externalRefs: { [conn.provider]: ext.externalId },
    })
    .returning({ id: calendarEvents.id });
  if (!event) return "ignored";
  await tx.insert(calendarSyncLinks).values({
    tenantId,
    eventId: event.id,
    connectionId: conn.id,
    externalId: ext.externalId,
    externalEtag: ext.etag,
    pendingOp: "none",
    status: "synced",
    origin: "inbound",
    lastSyncedAt: now,
    updatedAt: now,
  });
  return "created";
}

/** A lawyer connects their own calendar (the OAuth token is stored in the secret store; only its reference here). */
export async function connectCalendar(
  tx: TenantTx,
  input: { tenantId: string; userId: string; provider: SyncProviderName; tokenRef: string | null; externalCalendarId?: string | null; direction?: "two_way" | "push_only" | "pull_only"; now?: Date }
) {
  const now = input.now ?? new Date();
  await tx
    .update(calendarSyncConnections)
    .set({ active: false, disconnectedAt: now })
    .where(
      and(
        eq(calendarSyncConnections.tenantId, input.tenantId),
        eq(calendarSyncConnections.userId, input.userId),
        eq(calendarSyncConnections.provider, input.provider),
        eq(calendarSyncConnections.active, true)
      )
    );
  const [row] = await tx
    .insert(calendarSyncConnections)
    .values({
      tenantId: input.tenantId,
      userId: input.userId,
      provider: input.provider,
      tokenRef: input.tokenRef,
      externalCalendarId: input.externalCalendarId ?? null,
      direction: input.direction ?? "two_way",
      createdByUserId: input.userId,
      ...(syncApproved() ? {} : { lastError: placeholderFor(VENDOR_GATES.calendarSync.key) }),
    })
    .returning();
  await audit(tx, {
    tenantId: input.tenantId,
    engine: ENGINE,
    action: "calendar.sync_connected",
    entityType: "calendar_sync_connection",
    entityId: row?.id ?? null,
    actor: { type: "user", userId: input.userId },
    payload: { provider: input.provider, direction: input.direction ?? "two_way", vendorApproved: syncApproved() },
  });
  // Queue the lawyer's upcoming events for the first push.
  if (row && pushes(row.direction)) {
    const upcoming = await tx
      .select()
      .from(calendarEvents)
      .where(
        and(
          eq(calendarEvents.tenantId, input.tenantId),
          ne(calendarEvents.status, "cancelled"),
          sql`${input.userId}::uuid = any(${calendarEvents.assignedUserIds})`,
          gte(calendarEvents.startsAt, now)
        )
      )
      .limit(500);
    for (const e of upcoming) await queueEventSync(tx, input.tenantId, e, now);
  }
  return row;
}

export async function disconnectCalendar(tx: TenantTx, input: { tenantId: string; userId: string; connectionId: string; now?: Date }) {
  const now = input.now ?? new Date();
  const [row] = await tx
    .update(calendarSyncConnections)
    .set({ active: false, disconnectedAt: now })
    .where(
      and(
        eq(calendarSyncConnections.tenantId, input.tenantId),
        eq(calendarSyncConnections.id, input.connectionId),
        eq(calendarSyncConnections.userId, input.userId)
      )
    )
    .returning();
  if (row) {
    await audit(tx, {
      tenantId: input.tenantId,
      engine: ENGINE,
      action: "calendar.sync_disconnected",
      entityType: "calendar_sync_connection",
      entityId: row.id,
      actor: { type: "user", userId: input.userId },
    });
  }
  return row ?? null;
}

export async function listConnections(tx: TenantTx, tenantId: string, userId?: string) {
  const conds = [eq(calendarSyncConnections.tenantId, tenantId), eq(calendarSyncConnections.active, true)];
  if (userId) conds.push(eq(calendarSyncConnections.userId, userId));
  const rows = await tx.select().from(calendarSyncConnections).where(and(...conds));
  // Never return the token reference to a client of the API.
  return rows.map((c) => ({
    id: c.id,
    userId: c.userId,
    provider: c.provider,
    externalCalendarId: c.externalCalendarId,
    direction: c.direction,
    active: c.active,
    lastPushedAt: c.lastPushedAt,
    lastPulledAt: c.lastPulledAt,
    lastError: c.lastError,
    createdAt: c.createdAt,
  }));
}
