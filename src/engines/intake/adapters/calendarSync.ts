// VENDOR ADAPTER: lawyers' external calendars (Microsoft 365 / Google) for
// consultation availability (c67).
//
// Reads free/busy ONLY (never event contents, c67 rule 3). The calendar
// providers are subprocessors: until 'vendor.calendar_sync' is approved
// (signed DPA), the stub provider records the request and returns nothing,
// and a lawyer with a connection shows no slots (a callback is offered
// instead). Lawyers without a connection are booked against the product's
// own calendar only.

import { and, eq, gte, lte } from "drizzle-orm";
import { intakeBusyBlocks, intakeCalendarConnections } from "@/db/tables/intake";
import type { TenantTx } from "@/tenancy/withTenant";
import { isApproved } from "@/compliance/approvals";
import { VENDOR_GATES } from "@/compliance/gates";

export interface BusyInterval {
  start: Date;
  end: Date;
}

export interface CalendarConnectionRef {
  userId: string;
  provider: "microsoft" | "google";
  /** Secret-store reference, never a token. */
  tokenRef: string | null;
}

export type FreeBusyResult = { outcome: "ok"; busy: BusyInterval[] } | { outcome: "held" | "failed"; detail: string };

export interface CalendarSyncProvider {
  readonly name: string;
  readonly isStub: boolean;
  fetchFreeBusy(conn: CalendarConnectionRef, from: Date, to: Date): Promise<FreeBusyResult>;
}

/** Records what would have been fetched; never calls a vendor. */
export class StubCalendarSyncProvider implements CalendarSyncProvider {
  readonly name = "stub";
  readonly isStub = true;
  readonly recorded: Array<{ conn: CalendarConnectionRef; from: Date; to: Date }> = [];
  async fetchFreeBusy(conn: CalendarConnectionRef, from: Date, to: Date): Promise<FreeBusyResult> {
    this.recorded.push({ conn, from, to });
    return { outcome: "held", detail: "Stub calendar provider: recorded, not fetched." };
  }
}

let provider: CalendarSyncProvider = new StubCalendarSyncProvider();

export function getCalendarSyncProvider(): CalendarSyncProvider {
  return provider;
}

/** Swap in a real provider (only once 'vendor.calendar_sync' is approved). */
export function setCalendarSyncProvider(next: CalendarSyncProvider): void {
  provider = next;
}

export function calendarSyncApproved(): boolean {
  return isApproved(VENDOR_GATES.calendarSync.key);
}

/**
 * Refresh one lawyer's busy blocks for [from, to). Returns what happened;
 * never throws for a vendor problem (the connection records the error and
 * booking falls back to the callback path).
 */
export async function syncLawyerCalendar(
  tx: TenantTx,
  input: { tenantId: string; userId: string; from: Date; to: Date; now?: Date }
): Promise<{ synced: number; outcome: "ok" | "held" | "failed" | "no_connection" }> {
  const now = input.now ?? new Date();
  const conns = await tx
    .select()
    .from(intakeCalendarConnections)
    .where(and(eq(intakeCalendarConnections.tenantId, input.tenantId), eq(intakeCalendarConnections.userId, input.userId), eq(intakeCalendarConnections.active, true)));
  if (conns.length === 0) return { synced: 0, outcome: "no_connection" };
  let synced = 0;
  let outcome: "ok" | "held" | "failed" = "ok";
  for (const c of conns) {
    if (!calendarSyncApproved()) {
      await tx.update(intakeCalendarConnections).set({ lastError: "Pending vendor (DPA) approval: vendor.calendar_sync" }).where(eq(intakeCalendarConnections.id, c.id));
      outcome = "held";
      continue;
    }
    const result = await getCalendarSyncProvider().fetchFreeBusy({ userId: c.userId, provider: c.provider as "microsoft" | "google", tokenRef: c.tokenRef }, input.from, input.to);
    if (result.outcome !== "ok") {
      await tx.update(intakeCalendarConnections).set({ lastError: result.detail }).where(eq(intakeCalendarConnections.id, c.id));
      outcome = result.outcome;
      continue;
    }
    await tx
      .delete(intakeBusyBlocks)
      .where(
        and(
          eq(intakeBusyBlocks.tenantId, input.tenantId),
          eq(intakeBusyBlocks.userId, input.userId),
          eq(intakeBusyBlocks.provider, c.provider),
          gte(intakeBusyBlocks.startsAt, input.from),
          lte(intakeBusyBlocks.startsAt, input.to)
        )
      );
    for (const b of result.busy) {
      await tx.insert(intakeBusyBlocks).values({ tenantId: input.tenantId, userId: input.userId, startsAt: b.start, endsAt: b.end, provider: c.provider, syncedAt: now });
      synced++;
    }
    await tx.update(intakeCalendarConnections).set({ lastSyncedAt: now, lastError: null }).where(eq(intakeCalendarConnections.id, c.id));
  }
  return { synced, outcome };
}
