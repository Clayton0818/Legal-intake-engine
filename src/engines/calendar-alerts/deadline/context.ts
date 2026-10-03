// c44 §4.6 — the lawyer's view of a matter's dates when answering a deadline
// question: CONFIRMED entries in the lookahead (and any limitation date),
// plus unconfirmed proposals visibly marked "unconfirmed". Only confirmed
// entries ever count as the matter's deadlines (c44 rule 8). Internal only:
// this is never given to the client-facing AI.

import { and, asc, eq, gte, isNull, lte, or } from "drizzle-orm";
import { calendarEvents } from "@/db/tables/foundation";
import type { TenantTx } from "@/tenancy/withTenant";
import { DEADLINE_EVENT_TYPES } from "../kinds";
import type { RelevantDeadline } from "../replyClock/plan";

export interface DeadlineEntry {
  id: string;
  title: string;
  eventType: string;
  startsAt: Date;
  isDeadline: boolean;
  status: "confirmed" | "proposed";
  /** Label the UI must show next to unconfirmed rows. */
  label: "confirmed" | "unconfirmed";
}

export interface DeadlineContext {
  confirmed: DeadlineEntry[];
  unconfirmed: DeadlineEntry[];
  /** Confirmed deadline-type entries from 48h ago to the end of the lookahead (safety-net input). */
  relevant: RelevantDeadline[];
  lookaheadDays: number;
}

const PAST_GRACE_MS = 48 * 3_600_000;

/** Pure: is this event a deadline for the safety nets? */
export function isDeadlineEvent(e: { eventType: string; isDeadline: boolean }): boolean {
  return e.isDeadline || DEADLINE_EVENT_TYPES.includes(e.eventType);
}

export async function loadDeadlineContext(
  tx: TenantTx,
  tenantId: string,
  matterId: string,
  now: Date,
  lookaheadDays: number
): Promise<DeadlineContext> {
  const from = new Date(now.getTime() - PAST_GRACE_MS);
  const to = new Date(now.getTime() + lookaheadDays * 86_400_000);
  const rows = await tx
    .select({
      id: calendarEvents.id,
      title: calendarEvents.title,
      eventType: calendarEvents.eventType,
      startsAt: calendarEvents.startsAt,
      isDeadline: calendarEvents.isDeadline,
      status: calendarEvents.status,
    })
    .from(calendarEvents)
    .where(
      and(
        eq(calendarEvents.tenantId, tenantId),
        eq(calendarEvents.matterId, matterId),
        isNull(calendarEvents.cancelledAt),
        or(and(gte(calendarEvents.startsAt, from), lte(calendarEvents.startsAt, to)), eq(calendarEvents.eventType, "limitation_date"))
      )
    )
    .orderBy(asc(calendarEvents.startsAt))
    .limit(200);
  return buildDeadlineContext(rows, now, lookaheadDays);
}

/** Pure part of loadDeadlineContext. */
export function buildDeadlineContext(
  rows: ReadonlyArray<{ id: string; title: string; eventType: string; startsAt: Date; isDeadline: boolean; status: string }>,
  now: Date,
  lookaheadDays: number
): DeadlineContext {
  const confirmed: DeadlineEntry[] = [];
  const unconfirmed: DeadlineEntry[] = [];
  const relevant: RelevantDeadline[] = [];
  const to = now.getTime() + lookaheadDays * 86_400_000;
  for (const r of rows) {
    if (r.status === "confirmed") {
      confirmed.push({ ...r, status: "confirmed", label: "confirmed" });
      const t = r.startsAt.getTime();
      if (isDeadlineEvent(r) && t >= now.getTime() - PAST_GRACE_MS && t <= to) {
        relevant.push({ at: r.startsAt, source: "calendar", title: r.title, calendarEventId: r.id });
      }
    } else if (r.status === "proposed") {
      unconfirmed.push({ ...r, status: "proposed", label: "unconfirmed" });
    }
  }
  return { confirmed, unconfirmed, relevant, lookaheadDays };
}
