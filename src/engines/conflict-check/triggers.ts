// c58 — conflict checks run automatically at every point a conflict can
// appear, not only at intake:
//
//   (1) intake: checkInquiry() (sync.ts) runs on the minimum information —
//       the names of the caller and the other parties — BEFORE the
//       prospective client shares case details (Rule 1.18). The checks API
//       accepts names and identifiers only; there is no field for facts.
//   (2) a new party is added to an open matter: syncMatterParties() (sync.ts,
//       worker tick) picks up every new matter_parties row, from any engine.
//   (3) a matter is reopened: detectReopenedMatters() below (worker tick)
//       notices a closed matter that is open again and re-checks it.
//   (4) a lateral lawyer or staff member joins: lateralService.ts (c61).
//   (5) periodic re-check: runPeriodicRecheck() below (scheduled_tasks,
//       ADR-0001 D6) re-checks open matters that match parties indexed since
//       the last run.
//
// Every run writes `check.completed` to the audit trail (checks.ts) and each
// automatic trigger also writes `trigger.fired` with why it ran (c6).

import { and, asc, eq, gt, inArray, isNotNull, isNull, ne, or } from "drizzle-orm";
import { matterParties, matters, parties, scheduledTasks } from "@/db/schema";
import { conflictMatterWatch, conflictSyncState } from "@/db/tables/conflict-check";
import { audit, getFirmSettings, SYSTEM_ACTOR } from "@/core";
import type { TenantTx } from "@/tenancy/withTenant";
import { matchIndex } from "./matching";
import { loadIndexEntries } from "./partyIndex";
import { ENGINE, readConflictSettings } from "./settings";
import { runMatterCheck, searchedNamesForParty, type PartyForSearch } from "./sync";
import type { IndexEntry, SearchedName } from "./types";

export const PERIODIC_RECHECK_TASK_TYPE = "conflict-check.periodic_recheck";

/** Matter stages that are still open for conflicts purposes (c58 (5)). */
export const OPEN_MATTER_STAGES = ["prospective", "consultation_scheduled", "consult_completed_manual_follow_up", "pending_review", "retained"] as const;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export interface MatterState {
  stage: string;
  closedAt: Date | null;
}

export function isClosedState(s: { stage: string; closedAt: Date | null }): boolean {
  return s.stage === "closed" || s.closedAt !== null;
}

/** A matter we last saw closed is open again. Pure. */
export function detectReopened(prev: { lastStage: string; lastClosedAt: Date | null } | undefined, cur: MatterState): boolean {
  if (!prev) return false;
  return isClosedState({ stage: prev.lastStage, closedAt: prev.lastClosedAt }) && !isClosedState(cur);
}

/** Is the next periodic re-check due? Real clock (a background safety net, not a firm timer). Pure. */
export function nextRecheckAt(now: Date, intervalHours: number): Date {
  return new Date(now.getTime() + Math.max(1, intervalHours) * 3_600_000);
}

export interface OpenMatterParties {
  matterId: string;
  searched: SearchedName[];
}

/**
 * Which open matters have a hit against newly indexed parties. Hits of a
 * matter's own parties on themselves, and parties known only from that
 * matter, are ignored. Returns matter id → hit count. Pure.
 */
export function mattersToRecheck(open: readonly OpenMatterParties[], newEntries: readonly IndexEntry[]): Map<string, number> {
  const out = new Map<string, number>();
  if (newEntries.length === 0) return out;
  for (const m of open) {
    const own = new Set(m.searched.map((s) => s.partyId).filter((x): x is string => !!x));
    const hits = matchIndex(m.searched, newEntries, { exclude: { kind: "matter", id: m.matterId } }).filter(
      (h) => !h.partyId || !own.has(h.partyId)
    );
    if (hits.length > 0) out.set(m.matterId, hits.length);
  }
  return out;
}

// ---------------------------------------------------------------------------
// (3) Reopened matters — worker tick
// ---------------------------------------------------------------------------

export async function detectReopenedMatters(tx: TenantTx, tenantId: string, now: Date): Promise<{ closedSeen: number; reopened: number; checks: number }> {
  const settings = readConflictSettings(await getFirmSettings(tx, tenantId));

  // Remember matters that are closed now and were not recorded as closed.
  const newlyClosed = await tx
    .select({ id: matters.id, stage: matters.stage, closedAt: matters.closedAt })
    .from(matters)
    .leftJoin(conflictMatterWatch, and(eq(conflictMatterWatch.tenantId, tenantId), eq(conflictMatterWatch.matterId, matters.id)))
    .where(
      and(
        eq(matters.tenantId, tenantId),
        or(eq(matters.stage, "closed"), isNotNull(matters.closedAt)),
        or(isNull(conflictMatterWatch.id), and(ne(conflictMatterWatch.lastStage, "closed"), isNull(conflictMatterWatch.lastClosedAt)))
      )
    )
    .limit(1000);
  for (const m of newlyClosed) {
    await tx
      .insert(conflictMatterWatch)
      .values({ tenantId, matterId: m.id, lastStage: m.stage, lastClosedAt: m.closedAt, updatedAt: now })
      .onConflictDoUpdate({
        target: [conflictMatterWatch.tenantId, conflictMatterWatch.matterId],
        set: { lastStage: m.stage, lastClosedAt: m.closedAt, updatedAt: now },
      });
  }

  // Matters recorded as closed that are open again.
  const candidates = await tx
    .select({ id: matters.id, stage: matters.stage, closedAt: matters.closedAt, watchId: conflictMatterWatch.id, lastStage: conflictMatterWatch.lastStage, lastClosedAt: conflictMatterWatch.lastClosedAt })
    .from(conflictMatterWatch)
    .innerJoin(matters, eq(matters.id, conflictMatterWatch.matterId))
    .where(
      and(
        eq(conflictMatterWatch.tenantId, tenantId),
        or(eq(conflictMatterWatch.lastStage, "closed"), isNotNull(conflictMatterWatch.lastClosedAt)),
        ne(matters.stage, "closed"),
        isNull(matters.closedAt)
      )
    )
    .limit(100);

  let reopened = 0;
  let checks = 0;
  for (const c of candidates) {
    if (!detectReopened({ lastStage: c.lastStage, lastClosedAt: c.lastClosedAt }, { stage: c.stage, closedAt: c.closedAt })) continue;
    reopened++;
    await audit(tx, {
      tenantId,
      engine: ENGINE,
      action: "trigger.fired",
      entityType: "matter",
      entityId: c.id,
      matterId: c.id,
      actor: SYSTEM_ACTOR,
      payload: { trigger: "reopened", enabled: settings.recheckOnReopen },
    });
    if (settings.recheckOnReopen) {
      const result = await runMatterCheck(tx, { tenantId, matterId: c.id, trigger: "reopened", now });
      if (result) checks++;
    }
    await tx
      .update(conflictMatterWatch)
      .set({ lastStage: c.stage, lastClosedAt: null, lastReopenCheckAt: now, updatedAt: now })
      .where(eq(conflictMatterWatch.id, c.watchId));
  }
  return { closedSeen: newlyClosed.length, reopened, checks };
}

// ---------------------------------------------------------------------------
// (5) Periodic re-check — scheduled task
// ---------------------------------------------------------------------------

/** Make sure one periodic re-check is pending for the firm. */
export async function ensurePeriodicRecheckQueued(tx: TenantTx, tenantId: string, now: Date): Promise<boolean> {
  const [pending] = await tx
    .select({ id: scheduledTasks.id })
    .from(scheduledTasks)
    .where(
      and(
        eq(scheduledTasks.tenantId, tenantId),
        eq(scheduledTasks.taskType, PERIODIC_RECHECK_TASK_TYPE),
        isNull(scheduledTasks.completedAt),
        isNull(scheduledTasks.cancelledAt)
      )
    )
    .limit(1);
  if (pending) return false;
  await tx.insert(scheduledTasks).values({ tenantId, taskType: PERIODIC_RECHECK_TASK_TYPE, dueAt: now, payload: {} });
  return true;
}

export interface PeriodicRecheckSummary {
  baselined: boolean;
  newParties: number;
  openMatters: number;
  mattersRechecked: number;
  moreRemaining: boolean;
}

/**
 * Re-check open matters against parties indexed since the last run. The
 * first run only sets the baseline (everything already indexed was checked
 * when it arrived). Queues the next run before returning.
 */
export async function runPeriodicRecheck(
  tx: TenantTx,
  tenantId: string,
  now: Date,
  opts: { partyBatch?: number; maxMatters?: number; /** false for an on-demand run: the scheduled chain continues on its own. */ queueNext?: boolean } = {}
): Promise<PeriodicRecheckSummary> {
  const settings = readConflictSettings(await getFirmSettings(tx, tenantId));
  const queueNext = async (at: Date) => {
    if (opts.queueNext === false) return;
    await tx.insert(scheduledTasks).values({ tenantId, taskType: PERIODIC_RECHECK_TASK_TYPE, dueAt: at, payload: {} });
  };

  const [state] = await tx.select().from(conflictSyncState).where(eq(conflictSyncState.tenantId, tenantId)).limit(1);
  if (!state || !state.recheckCursor) {
    // Baseline: the index sync creates the state row on its first tick.
    if (state) await tx.update(conflictSyncState).set({ recheckCursor: now, recheckCursorId: null }).where(eq(conflictSyncState.id, state.id));
    await audit(tx, { tenantId, engine: ENGINE, action: "recheck.baselined", payload: { at: now.toISOString() } });
    await queueNext(nextRecheckAt(now, settings.periodicRecheckIntervalHours));
    return { baselined: true, newParties: 0, openMatters: 0, mattersRechecked: 0, moreRemaining: false };
  }

  const batch = opts.partyBatch ?? 200;
  const newParties = await tx
    .select({ id: parties.id, createdAt: parties.createdAt })
    .from(parties)
    .where(
      and(
        eq(parties.tenantId, tenantId),
        state.recheckCursorId
          ? or(gt(parties.createdAt, state.recheckCursor), and(eq(parties.createdAt, state.recheckCursor), gt(parties.id, state.recheckCursorId)))
          : gt(parties.createdAt, state.recheckCursor)
      )
    )
    .orderBy(asc(parties.createdAt), asc(parties.id))
    .limit(batch);

  let openCount = 0;
  let rechecked = 0;
  if (newParties.length > 0) {
    const newEntries = await loadIndexEntries(tx, { tenantId, names: [], sources: ["party"], extraPartyIds: newParties.map((p) => p.id) });
    const rows = await tx
      .select({
        matterId: matterParties.matterId,
        role: matterParties.role,
        party: {
          id: parties.id,
          fullName: parties.fullName,
          aliases: parties.aliases,
          dateOfBirth: parties.dateOfBirth,
          email: parties.email,
          phone: parties.phone,
        },
      })
      .from(matterParties)
      .innerJoin(matters, eq(matters.id, matterParties.matterId))
      .innerJoin(parties, eq(parties.id, matterParties.partyId))
      .where(
        and(
          eq(matterParties.tenantId, tenantId),
          isNull(matterParties.endedAt),
          isNull(matters.closedAt),
          inArray(matters.stage, [...OPEN_MATTER_STAGES])
        )
      )
      .limit(20_000);
    const byMatter = new Map<string, SearchedName[]>();
    for (const r of rows) {
      const list = byMatter.get(r.matterId) ?? [];
      list.push(...searchedNamesForParty(r.party satisfies PartyForSearch, r.role));
      byMatter.set(r.matterId, list);
    }
    openCount = byMatter.size;
    const toCheck = mattersToRecheck(
      [...byMatter.entries()].map(([matterId, searched]) => ({ matterId, searched })),
      newEntries
    );
    // Every matched matter is re-checked (no cap: a skipped matter would never be re-checked for these parties).
    const max = opts.maxMatters ?? Number.POSITIVE_INFINITY;
    for (const [matterId, hitCount] of [...toCheck.entries()].slice(0, max)) {
      await audit(tx, {
        tenantId,
        engine: ENGINE,
        action: "trigger.fired",
        entityType: "matter",
        entityId: matterId,
        matterId,
        actor: SYSTEM_ACTOR,
        payload: { trigger: "periodic", newPartyHits: hitCount },
      });
      if (await runMatterCheck(tx, { tenantId, matterId, trigger: "periodic", now })) rechecked++;
    }
    const last = newParties.at(-1)!;
    await tx.update(conflictSyncState).set({ recheckCursor: last.createdAt, recheckCursorId: last.id }).where(eq(conflictSyncState.id, state.id));
  }

  const moreRemaining = newParties.length === batch;
  await audit(tx, {
    tenantId,
    engine: ENGINE,
    action: "recheck.periodic_completed",
    payload: { newParties: newParties.length, openMatters: openCount, mattersRechecked: rechecked, moreRemaining },
  });
  // A full batch means more parties are waiting: run again soon instead of waiting a whole interval.
  await queueNext(moreRemaining ? new Date(now.getTime() + 60_000) : nextRecheckAt(now, settings.periodicRecheckIntervalHours));
  return { baselined: false, newParties: newParties.length, openMatters: openCount, mattersRechecked: rechecked, moreRemaining };
}
