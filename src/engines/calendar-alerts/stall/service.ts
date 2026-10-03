// c47 — the stall sweep (database side). Runs hourly per firm (alert_job_runs)
// and reads the timestamps other engines already record: intake_sessions +
// intake_events, conflict_check_results, documents, matters + audit_events.
// It never imports another engine; it only reads shared tables.

import { and, eq, inArray, isNull, max, ne, sql } from "drizzle-orm";
import { conflictCheckResults, documents, intakeEvents, intakeSessions, matters, users } from "@/db/schema";
import { auditEvents, tasks } from "@/db/tables/foundation";
import { stallWatches } from "@/db/tables/calendar-alerts";
import type { TenantTx } from "@/tenancy/withTenant";
import { audit, SYSTEM_ACTOR } from "@/core/audit";
import { toBusinessCalendar } from "@/core/firmSettings";
import { resolveFlag } from "@/core/flags";
import { AlertRuleError, loadPeople, raiseAlert, type EngineContext } from "../common";
import { FLAG_TYPES } from "../kinds";
import { ENGINE } from "../settings";
import { decideStall, stallFlagKey, stallSummary, validateCheckBack, type LiveWatch, type StallCandidate, type StallItemType } from "./plan";

export type StallWatchRow = typeof stallWatches.$inferSelect;

function typesInUse(ctx: EngineContext): Set<StallItemType> {
  return new Set(Object.keys(ctx.alerts.stallDurations).map((k) => k.split(":")[0] as StallItemType));
}

async function openTaskRefs(tx: TenantTx, tenantId: string) {
  const rows = await tx
    .select({ sourceRef: tasks.sourceRef, intakeSessionId: tasks.intakeSessionId, matterId: tasks.matterId })
    .from(tasks)
    .where(and(eq(tasks.tenantId, tenantId), eq(tasks.status, "open")));
  return {
    refs: new Set(rows.map((r) => r.sourceRef).filter((x): x is string => Boolean(x))),
    sessions: new Set(rows.map((r) => r.intakeSessionId).filter((x): x is string => Boolean(x))),
    matters: new Set(rows.map((r) => r.matterId).filter((x): x is string => Boolean(x))),
  };
}

/** Every item currently in a watchable state, for the item types the firm configured. */
export async function loadStallCandidates(tx: TenantTx, ctx: EngineContext, tenantId: string): Promise<StallCandidate[]> {
  const types = typesInUse(ctx);
  const watched = await openTaskRefs(tx, tenantId);
  const out: StallCandidate[] = [];

  if (types.has("intake_session")) {
    const sessions = await tx
      .select({ id: intakeSessions.id, matterId: intakeSessions.matterId, stage: intakeSessions.currentNode, startedAt: intakeSessions.startedAt, owner: matters.assignedUserId })
      .from(intakeSessions)
      .leftJoin(matters, eq(matters.id, intakeSessions.matterId))
      .where(and(eq(intakeSessions.tenantId, tenantId), isNull(intakeSessions.terminalState)))
      .limit(2000);
    const ids = sessions.map((s) => s.id);
    const last = ids.length
      ? await tx
          .select({ id: intakeEvents.intakeSessionId, at: max(intakeEvents.occurredAt) })
          .from(intakeEvents)
          .where(and(eq(intakeEvents.tenantId, tenantId), inArray(intakeEvents.intakeSessionId, ids)))
          .groupBy(intakeEvents.intakeSessionId)
      : [];
    const lastBy = new Map(last.map((l) => [l.id, l.at]));
    for (const s of sessions) {
      const at = lastBy.get(s.id) ?? null;
      out.push({
        itemType: "intake_session",
        itemId: s.id,
        matterId: s.matterId,
        stage: s.stage,
        lastActivityAt: at ?? s.startedAt,
        lastActivityLabel: at ? "intake event" : "session started",
        ownerUserId: s.owner ?? null,
        watchedElsewhere: watched.sessions.has(s.id),
      });
    }
  }

  if (types.has("conflict_check")) {
    const rows = await tx
      .select({ id: conflictCheckResults.id, sessionId: conflictCheckResults.intakeSessionId, createdAt: conflictCheckResults.createdAt, matterId: intakeSessions.matterId })
      .from(conflictCheckResults)
      .leftJoin(intakeSessions, eq(intakeSessions.id, conflictCheckResults.intakeSessionId))
      .where(and(eq(conflictCheckResults.tenantId, tenantId), eq(conflictCheckResults.outcome, "possible"), isNull(conflictCheckResults.resolvedAt)))
      .limit(2000);
    for (const r of rows) {
      out.push({
        itemType: "conflict_check",
        itemId: r.id,
        matterId: r.matterId ?? null,
        stage: "possible",
        lastActivityAt: r.createdAt,
        lastActivityLabel: "conflict check run",
        ownerUserId: null,
        watchedElsewhere: watched.refs.has(`conflict_check:${r.id}`) || watched.sessions.has(r.sessionId),
      });
    }
  }

  if (types.has("document")) {
    const docStages = [...new Set(Object.keys(ctx.alerts.stallDurations).filter((k) => k.startsWith("document:")).map((k) => k.slice("document:".length)))];
    const statuses = docStages.includes("*") ? null : docStages;
    const rows = await tx
      .select({ id: documents.id, matterId: documents.matterId, status: documents.status, updatedAt: documents.updatedAt, owner: documents.uploadedByUserId })
      .from(documents)
      .where(and(eq(documents.tenantId, tenantId), statuses ? inArray(documents.status, statuses) : sql`${documents.status} not in ('final','filed','superseded','archived')`))
      .limit(2000);
    for (const d of rows) {
      out.push({
        itemType: "document",
        itemId: d.id,
        matterId: d.matterId,
        stage: d.status,
        lastActivityAt: d.updatedAt,
        lastActivityLabel: "document updated",
        ownerUserId: d.owner,
        watchedElsewhere: watched.refs.has(`document:${d.id}`),
      });
    }
  }

  if (types.has("matter")) {
    const rows = await tx
      .select({ id: matters.id, stage: matters.stage, openedAt: matters.openedAt, owner: matters.assignedUserId })
      .from(matters)
      .where(and(eq(matters.tenantId, tenantId), isNull(matters.closedAt), ne(matters.stage, "closed")))
      .limit(2000);
    const ids = rows.map((m) => m.id);
    const last = ids.length
      ? await tx
          .select({ id: auditEvents.matterId, at: max(auditEvents.occurredAt) })
          .from(auditEvents)
          .where(and(eq(auditEvents.tenantId, tenantId), inArray(auditEvents.matterId, ids), ne(auditEvents.engine, ENGINE)))
          .groupBy(auditEvents.matterId)
      : [];
    const lastBy = new Map(last.map((l) => [l.id, l.at]));
    for (const m of rows) {
      const at = lastBy.get(m.id) ?? null;
      out.push({
        itemType: "matter",
        itemId: m.id,
        matterId: m.id,
        stage: m.stage,
        lastActivityAt: at ?? m.openedAt,
        lastActivityLabel: at ? "matter activity" : "matter opened",
        ownerUserId: m.owner,
        watchedElsewhere: watched.matters.has(m.id),
      });
    }
  }
  return out;
}

export async function runStallSweep(tx: TenantTx, ctx: EngineContext, tenantId: string, now: Date): Promise<{ flagged: number; cleared: number; reflagged: number }> {
  const candidates = await loadStallCandidates(tx, ctx, tenantId);
  const byKey = new Map(candidates.map((c) => [`${c.itemType}:${c.itemId}`, c]));
  const live = await tx
    .select()
    .from(stallWatches)
    .where(and(eq(stallWatches.tenantId, tenantId), ne(stallWatches.status, "cleared")));
  const liveByKey = new Map(live.map((w) => [`${w.itemType}:${w.itemId}`, w]));
  const keys = new Set([...byKey.keys(), ...liveByKey.keys()]);
  const cal = toBusinessCalendar(ctx.firm);
  const people = await loadPeople(tx, tenantId, ctx.alerts);
  const recipients = [...new Set([...people.owners, ...people.admins])];
  const names = new Map((await tx.select({ id: users.id, name: users.displayName }).from(users).where(eq(users.tenantId, tenantId))).map((u) => [u.id, u.name]));
  const result = { flagged: 0, cleared: 0, reflagged: 0 };

  for (const key of keys) {
    const candidate = byKey.get(key) ?? null;
    const watch = liveByKey.get(key) ?? null;
    const lw: LiveWatch | null = watch ? { id: watch.id, status: watch.status as LiveWatch["status"], stage: watch.stage, lastActivityAt: watch.lastActivityAt, checkBackAt: watch.checkBackAt } : null;
    const decision = decideStall(candidate, lw, now, ctx.alerts, cal);
    if (decision.kind === "none") continue;

    if (decision.kind === "clear" && watch) {
      await clearWatch(tx, watch, decision.reason, now);
      result.cleared++;
      continue;
    }
    if ((decision.kind === "flag" || decision.kind === "reflag_after_check_back") && candidate) {
      if (recipients.length === 0) continue; // nobody to tell; retried next sweep
      const res = await raiseAlert(
        tx,
        ctx,
        {
          tenantId,
          type: FLAG_TYPES.stalled,
          severity: "warning",
          audience: "internal",
          title: `Stalled: ${candidate.itemType.replace("_", " ")} at '${candidate.stage}'`,
          summary: stallSummary(candidate, decision.stuckBusinessHours, decision.expectedBusinessHours, now, candidate.ownerUserId ? names.get(candidate.ownerUserId) ?? null : null),
          details: { itemType: candidate.itemType, itemId: candidate.itemId, stage: candidate.stage, lastActivityAt: candidate.lastActivityAt.toISOString(), ownerUserId: candidate.ownerUserId },
          matterId: candidate.matterId,
          recipients: { userIds: recipients },
          dedupeKey: stallFlagKey(candidate.itemType, candidate.itemId),
          sourceCard: "c47",
        },
        now
      );
      if (watch) {
        await tx
          .update(stallWatches)
          .set({ status: "flagged", flagId: res.flag.id, checkBackAt: null })
          .where(and(eq(stallWatches.tenantId, tenantId), eq(stallWatches.id, watch.id)));
        await audit(tx, { tenantId, engine: ENGINE, action: "stall.reflagged", entityType: "stall_watch", entityId: watch.id, matterId: candidate.matterId, payload: { itemType: candidate.itemType, stage: candidate.stage } });
        result.reflagged++;
      } else {
        const [row] = await tx
          .insert(stallWatches)
          .values({
            tenantId,
            itemType: candidate.itemType,
            itemId: candidate.itemId,
            matterId: candidate.matterId,
            stage: candidate.stage,
            lastActivityAt: candidate.lastActivityAt,
            lastActivityLabel: candidate.lastActivityLabel,
            ownerUserId: candidate.ownerUserId,
            flagId: res.flag.id,
            status: "flagged",
            createdAt: now,
          })
          .onConflictDoNothing()
          .returning();
        if (row) {
          await audit(tx, { tenantId, engine: ENGINE, action: "stall.flagged", entityType: "stall_watch", entityId: row.id, matterId: candidate.matterId, payload: { itemType: candidate.itemType, stage: candidate.stage, stuckBusinessHours: decision.stuckBusinessHours } });
          result.flagged++;
        }
      }
    }
  }
  return result;
}

async function clearWatch(tx: TenantTx, watch: StallWatchRow, reason: string, now: Date): Promise<void> {
  await tx
    .update(stallWatches)
    .set({ status: "cleared", clearedAt: now, reason })
    .where(and(eq(stallWatches.tenantId, watch.tenantId), eq(stallWatches.id, watch.id)));
  if (watch.flagId) {
    await resolveFlag(tx, { tenantId: watch.tenantId, flagId: watch.flagId, by: SYSTEM_ACTOR, reason, engine: ENGINE, at: now }).catch((err: unknown) => {
      // Already resolved by a person (with their own reason): nothing more to clear.
      if (!(err instanceof Error && /not found/.test(err.message))) throw err;
    });
  }
  await audit(tx, { tenantId: watch.tenantId, engine: ENGINE, action: "stall.cleared", entityType: "stall_watch", entityId: watch.id, matterId: watch.matterId, reason });
}

/** "Waiting on the court until Oct 10": clears the flag and holds re-flagging until that date. Logged. */
export async function setCheckBack(
  tx: TenantTx,
  ctx: EngineContext,
  input: { tenantId: string; watchId: string; userId: string; reason: string; checkBackAt: Date; now: Date }
): Promise<StallWatchRow> {
  const problem = validateCheckBack(input.reason, input.checkBackAt, input.now, ctx.alerts.checkBackMaxDays);
  if (problem) throw new AlertRuleError(problem);
  const [watch] = await tx
    .select()
    .from(stallWatches)
    .where(and(eq(stallWatches.tenantId, input.tenantId), eq(stallWatches.id, input.watchId), ne(stallWatches.status, "cleared")))
    .limit(1);
  if (!watch) throw new AlertRuleError("Stalled item not found.", 404);
  const reason = input.reason.trim();
  const by = { type: "user" as const, userId: input.userId };
  if (watch.flagId) {
    await resolveFlag(tx, { tenantId: input.tenantId, flagId: watch.flagId, by, reason, checkBackAt: input.checkBackAt, engine: ENGINE, at: input.now }).catch((err: unknown) => {
      if (!(err instanceof Error && /not found/.test(err.message))) throw err;
    });
  }
  const [row] = await tx
    .update(stallWatches)
    .set({ status: "check_back", checkBackAt: input.checkBackAt, reason, setByUserId: input.userId })
    .where(and(eq(stallWatches.tenantId, input.tenantId), eq(stallWatches.id, watch.id)))
    .returning();
  await audit(tx, { tenantId: input.tenantId, engine: ENGINE, action: "stall.check_back_set", entityType: "stall_watch", entityId: watch.id, matterId: watch.matterId, actor: by, reason, payload: { checkBackAt: input.checkBackAt.toISOString() } });
  return row!;
}

export async function listStalls(tx: TenantTx, tenantId: string, filter: { includeCheckBack?: boolean } = {}): Promise<StallWatchRow[]> {
  const statuses = filter.includeCheckBack === false ? ["flagged"] : ["flagged", "check_back"];
  return tx.select().from(stallWatches).where(and(eq(stallWatches.tenantId, tenantId), inArray(stallWatches.status, statuses))).limit(500);
}
