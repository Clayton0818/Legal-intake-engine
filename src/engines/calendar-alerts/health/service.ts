// c53 — case health (database side): gather the signals other tiles already
// record, compute, store a snapshot, flag transitions. INTERNAL ONLY: nothing
// here is reachable from a client route, and no client message, task or
// legal step is ever created from a score.

import { and, desc, eq, gte, inArray, isNotNull, isNull, lte, ne, sql } from "drizzle-orm";
import { matters, parties } from "@/db/schema";
import { calendarEvents, flags, tasks } from "@/db/tables/foundation";
import { clientChaseLadders, clientMessages, clientUpdates, matterHealthSnapshots, replyClocks, stallWatches } from "@/db/tables/calendar-alerts";
import type { TenantTx } from "@/tenancy/withTenant";
import { addBusinessHours, businessHoursBetween } from "@/core/businessHours";
import { audit } from "@/core/audit";
import { toBusinessCalendar } from "@/core/firmSettings";
import { resolveFlag } from "@/core/flags";
import { AlertRuleError, getMatter, jobIsDue, lastJobRun, loadPeople, markJobRun, raiseAlert, responsibleLawyer, type EngineContext } from "../common";
import { DEADLINE_EVENT_TYPES, FLAG_TYPES, TASK_KINDS } from "../kinds";
import { ENGINE } from "../settings";
import { computeHealth, fallingSharply, rankValue, shouldRaiseHealthFlag, type HealthResult, type HealthSignals } from "./score";

export type SnapshotRow = typeof matterHealthSnapshots.$inferSelect;

const DAY_BH = 8;
const DAY_MS = 86_400_000;

export function healthFlagKey(matterId: string): string {
  return `${FLAG_TYPES.health}:${matterId}`;
}

async function countFlags(tx: TenantTx, tenantId: string, matterId: string, types: string[]): Promise<number | null> {
  if (types.length === 0) return null;
  const [r] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(flags)
    .where(and(eq(flags.tenantId, tenantId), eq(flags.matterId, matterId), isNull(flags.resolvedAt), inArray(flags.type, types)));
  return r?.n ?? 0;
}

export async function gatherSignals(tx: TenantTx, ctx: EngineContext, tenantId: string, matterId: string, now: Date): Promise<{ signals: HealthSignals; deadlineNear: boolean; newMatter: boolean }> {
  const matter = await getMatter(tx, tenantId, matterId);
  const cal = toBusinessCalendar(ctx.firm);
  const h = ctx.alerts.health;
  const since30 = new Date(now.getTime() - 30 * DAY_MS);

  const clocks = await tx
    .select({ flaggedAt: replyClocks.flaggedAt, promiseMissedAt: replyClocks.promiseMissedAt })
    .from(replyClocks)
    .where(and(eq(replyClocks.tenantId, tenantId), eq(replyClocks.matterId, matterId), gte(replyClocks.startedAt, since30)));
  const openTasks = await tx
    .select({ ownerType: tasks.ownerType, kind: tasks.kind, deadlineCritical: tasks.deadlineCritical })
    .from(tasks)
    .where(and(eq(tasks.tenantId, tenantId), eq(tasks.matterId, matterId), eq(tasks.status, "open"), lte(tasks.dueAt, now)));
  const firmOverdue = openTasks.filter((t) => t.ownerType !== "client");
  const [stalls] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(stallWatches)
    .where(and(eq(stallWatches.tenantId, tenantId), eq(stallWatches.matterId, matterId), eq(stallWatches.status, "flagged")));
  const [lastUpdate] = await tx
    .select({ at: sql<Date | null>`max(${clientUpdates.sentAt})` })
    .from(clientUpdates)
    .where(and(eq(clientUpdates.tenantId, tenantId), eq(clientUpdates.matterId, matterId), eq(clientUpdates.status, "sent")));
  const [lastHumanReply] = await tx
    .select({ at: sql<Date | null>`max(${clientMessages.occurredAt})` })
    .from(clientMessages)
    .where(and(eq(clientMessages.tenantId, tenantId), eq(clientMessages.matterId, matterId), eq(clientMessages.direction, "outbound"), eq(clientMessages.senderType, "user")));
  const [lastInbound] = await tx
    .select({ at: sql<Date | null>`max(${clientMessages.occurredAt})` })
    .from(clientMessages)
    .where(and(eq(clientMessages.tenantId, tenantId), eq(clientMessages.matterId, matterId), eq(clientMessages.direction, "inbound"), eq(clientMessages.autoSubmitted, false)));
  const [nonResponses] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(clientChaseLadders)
    .where(and(eq(clientChaseLadders.tenantId, tenantId), eq(clientChaseLadders.matterId, matterId), eq(clientChaseLadders.subjectType, "message"), inArray(clientChaseLadders.status, ["active", "paused", "awaiting_lawyer"])));
  const [party] = await tx.select({ dv: parties.dvSensitive }).from(parties).where(and(eq(parties.tenantId, tenantId), eq(parties.id, matter.primaryPartyId))).limit(1);

  const asDate = (v: Date | string | null | undefined) => (v ? new Date(v) : null);
  const latest = (...ds: Array<Date | null>) => ds.filter((d): d is Date => d !== null).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  const updateAt = latest(asDate(lastUpdate?.at), asDate(lastHumanReply?.at)) ?? matter.openedAt;
  const clientAt = asDate(lastInbound?.at) ?? matter.openedAt;
  const bd = (from: Date) => Math.max(0, businessHoursBetween(from, now, cal) / DAY_BH);

  const windowEnd = addBusinessHours(now, h.deadlineWindowBusinessDays * DAY_BH, cal);
  const [near] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(calendarEvents)
    .where(
      and(
        eq(calendarEvents.tenantId, tenantId),
        eq(calendarEvents.matterId, matterId),
        eq(calendarEvents.status, "confirmed"),
        isNull(calendarEvents.cancelledAt),
        gte(calendarEvents.startsAt, now),
        lte(calendarEvents.startsAt, windowEnd),
        sql`(${calendarEvents.isDeadline} or ${inArray(calendarEvents.eventType, [...DEADLINE_EVENT_TYPES])})`
      )
    );

  const signals: HealthSignals = {
    replyTargetsMissed: clocks.filter((c) => c.flaggedAt && !c.promiseMissedAt).length,
    replyPromisesMissed: clocks.filter((c) => c.promiseMissedAt).length,
    overdueFirmTasks: firmOverdue.length,
    overdueCriticalFirmTasks: firmOverdue.filter((t) => t.deadlineCritical).length,
    openStalls: stalls?.n ?? 0,
    businessDaysSinceUpdate: bd(updateAt),
    openNonResponses: nonResponses?.n ?? 0,
    overdueClientTasks: openTasks.filter((t) => t.ownerType === "client" && t.kind !== TASK_KINDS.clientReplyDue).length,
    missingDocuments: await countFlags(tx, tenantId, matterId, h.signalFlagTypes.missingDocuments),
    delayedSignOffs: await countFlags(tx, tenantId, matterId, h.signalFlagTypes.signOffs),
    retainerIssues: await countFlags(tx, tenantId, matterId, h.signalFlagTypes.retainer),
    businessDaysSinceClientActivity: party?.dv && h.excludeActivityForDv ? null : bd(clientAt),
  };
  return { signals, deadlineNear: (near?.n ?? 0) > 0, newMatter: bd(matter.openedAt) < h.newMatterGraceBusinessDays };
}

export async function computeMatterHealth(tx: TenantTx, ctx: EngineContext, tenantId: string, matterId: string, now: Date): Promise<{ snapshot: SnapshotRow; result: HealthResult; flagged: boolean }> {
  const h = ctx.alerts.health;
  const cal = toBusinessCalendar(ctx.firm);
  const { signals, deadlineNear, newMatter } = await gatherSignals(tx, ctx, tenantId, matterId, now);
  const result = computeHealth(signals, h, { newMatter });

  const history = await tx
    .select({ computedAt: matterHealthSnapshots.computedAt, score: matterHealthSnapshots.score, band: matterHealthSnapshots.band, falling: matterHealthSnapshots.fallingSharply })
    .from(matterHealthSnapshots)
    .where(and(eq(matterHealthSnapshots.tenantId, tenantId), eq(matterHealthSnapshots.matterId, matterId), gte(matterHealthSnapshots.computedAt, new Date(now.getTime() - 120 * DAY_MS))))
    .orderBy(desc(matterHealthSnapshots.computedAt))
    .limit(400);
  const inWindow = history.filter((s) => businessHoursBetween(s.computedAt, now, cal) <= h.trendWindowBusinessDays * DAY_BH);
  const falling = fallingSharply(result.score, inWindow.map((s) => s.score), h);
  const unhealthy = result.band === "red" || falling;
  const { multiplierPct, rank } = rankValue(result.score, deadlineNear, h);

  // Business days the matter has been continuously healthy just before now.
  let runStart: Date | null = null;
  for (const s of history) {
    if (s.band === "red" || s.falling) break;
    runStart = s.computedAt;
  }
  const healthyRun = runStart && history[0] && !(history[0].band === "red" || history[0].falling) ? businessHoursBetween(runStart, now, cal) / DAY_BH : 0;

  const [openFlag] = await tx.select({ id: flags.id }).from(flags).where(and(eq(flags.tenantId, tenantId), eq(flags.dedupeKey, healthFlagKey(matterId)), isNull(flags.resolvedAt))).limit(1);
  const [lastResolved] = await tx
    .select({ checkBackAt: flags.checkBackAt })
    .from(flags)
    .where(and(eq(flags.tenantId, tenantId), eq(flags.dedupeKey, healthFlagKey(matterId)), isNotNull(flags.resolvedAt)))
    .orderBy(desc(flags.resolvedAt))
    .limit(1);

  let flagId: string | null = null;
  const raise = shouldRaiseHealthFlag({
    unhealthy,
    openFlag: Boolean(openFlag),
    checkBackAt: lastResolved?.checkBackAt ?? null,
    everFlagged: Boolean(lastResolved) || Boolean(openFlag),
    healthyRunBusinessDays: healthyRun,
    quietBusinessDays: h.reflagQuietBusinessDays,
    now,
  });
  if (raise) {
    const matter = await getMatter(tx, tenantId, matterId);
    const people = await loadPeople(tx, tenantId, ctx.alerts);
    const lawyer = await responsibleLawyer(tx, tenantId, matter);
    const recipients = [...new Set([lawyer, ...people.admins].filter((x): x is string => Boolean(x)))];
    if (recipients.length > 0) {
      const reasons = [...result.firmReasons.map((r) => `firm: ${r}`), ...result.clientReasons.map((r) => `client: ${r}`)];
      const res = await raiseAlert(
        tx,
        ctx,
        {
          tenantId,
          type: FLAG_TYPES.health,
          severity: deadlineNear ? "high" : "warning",
          urgent: deadlineNear,
          audience: "internal",
          title: falling && result.band !== "red" ? "Matter health is falling sharply" : "Matter health is red",
          summary: `Health ${result.score}/100 (firm ${result.firmSubscore ?? "n/a"}, client ${result.clientSubscore ?? "n/a"}). ${reasons.join("; ")}.${deadlineNear ? " A confirmed court deadline is near." : ""} This is a prompt to review the matter; no action is taken automatically.`,
          details: { score: result.score, band: result.band, falling, reasons: { firm: result.firmReasons, client: result.clientReasons } },
          matterId,
          recipients: { userIds: recipients },
          dedupeKey: healthFlagKey(matterId),
          sourceCard: "c53",
        },
        now
      );
      flagId = res.flag.id;
    }
  }

  const [snapshot] = await tx
    .insert(matterHealthSnapshots)
    .values({
      tenantId,
      matterId,
      computedAt: now,
      score: result.score,
      firmSubscore: result.firmSubscore,
      clientSubscore: result.clientSubscore,
      band: result.band,
      fallingSharply: falling,
      urgencyMultiplier: multiplierPct,
      rankValue: rank,
      reasons: { firm: result.firmReasons, client: result.clientReasons, notMeasured: result.notMeasured },
      signals: { ...signals },
      flagId,
    })
    .returning();
  return { snapshot: snapshot!, result, flagged: flagId !== null };
}

/** Nightly recompute of every open matter (once per 24h per firm). */
export async function runHealthJob(tx: TenantTx, ctx: EngineContext, tenantId: string, now: Date): Promise<{ computed: number; flagged: number } | { skipped: string }> {
  const job = "health";
  if (!jobIsDue(await lastJobRun(tx, tenantId, job), now, 24 * 3_600_000)) return { skipped: "not due" };
  const open = await tx
    .select({ id: matters.id })
    .from(matters)
    .where(and(eq(matters.tenantId, tenantId), isNull(matters.closedAt), ne(matters.stage, "closed")))
    .limit(2000);
  let flagged = 0;
  for (const m of open) {
    const r = await computeMatterHealth(tx, ctx, tenantId, m.id, now);
    if (r.flagged) flagged++;
  }
  await markJobRun(tx, tenantId, job, now, { computed: open.length, flagged });
  return { computed: open.length, flagged };
}

/** Lawyer acknowledges with a note and a check-back date (c53 §4.10); the score keeps updating. */
export async function acknowledgeHealthFlag(
  tx: TenantTx,
  ctx: EngineContext,
  input: { tenantId: string; matterId: string; userId: string; note: string; checkBackAt: Date | null; now: Date }
): Promise<void> {
  const note = input.note?.trim();
  if (!note) throw new AlertRuleError("A note is required to acknowledge a health flag.");
  if (input.checkBackAt && (input.checkBackAt.getTime() <= input.now.getTime() || input.checkBackAt.getTime() - input.now.getTime() > ctx.alerts.checkBackMaxDays * DAY_MS)) {
    throw new AlertRuleError(`The check-back date must be in the future and at most ${ctx.alerts.checkBackMaxDays} days ahead.`);
  }
  const [open] = await tx.select({ id: flags.id }).from(flags).where(and(eq(flags.tenantId, input.tenantId), eq(flags.dedupeKey, healthFlagKey(input.matterId)), isNull(flags.resolvedAt))).limit(1);
  if (!open) throw new AlertRuleError("No open health flag on this matter.", 404);
  await resolveFlag(tx, { tenantId: input.tenantId, flagId: open.id, by: { type: "user", userId: input.userId }, reason: `Acknowledged: ${note}`, checkBackAt: input.checkBackAt, engine: ENGINE, at: input.now });
  await audit(tx, { tenantId: input.tenantId, engine: ENGINE, action: "health.acknowledged", entityType: "matter", entityId: input.matterId, matterId: input.matterId, actor: { type: "user", userId: input.userId }, reason: note, payload: { checkBackAt: input.checkBackAt?.toISOString() ?? null } });
}

export interface HealthRow {
  matterId: string;
  assignedUserId: string | null;
  practiceArea: string | null;
  computedAt: Date;
  score: number | null;
  firmSubscore: number | null;
  clientSubscore: number | null;
  band: string;
  fallingSharply: boolean;
  urgencyMultiplier: number;
  rankValue: number;
  reasons: Record<string, unknown>;
}

/** Firm dashboard: latest snapshot per OPEN matter, highest rank first. Filter by lawyer / band / trend. */
export async function listHealthDashboard(tx: TenantTx, tenantId: string, filter: { userId?: string; band?: string; fallingOnly?: boolean } = {}): Promise<HealthRow[]> {
  const latest = await tx
    .selectDistinctOn([matterHealthSnapshots.matterId])
    .from(matterHealthSnapshots)
    .where(eq(matterHealthSnapshots.tenantId, tenantId))
    .orderBy(matterHealthSnapshots.matterId, desc(matterHealthSnapshots.computedAt));
  if (latest.length === 0) return [];
  const ms = await tx
    .select({ id: matters.id, assignedUserId: matters.assignedUserId, practiceArea: matters.practiceArea, closedAt: matters.closedAt, stage: matters.stage })
    .from(matters)
    .where(and(eq(matters.tenantId, tenantId), inArray(matters.id, latest.map((l) => l.matterId))));
  const byId = new Map(ms.map((m) => [m.id, m]));
  return latest
    .filter((s) => {
      const m = byId.get(s.matterId);
      if (!m || m.closedAt || m.stage === "closed") return false; // closed: frozen and hidden
      if (filter.userId && m.assignedUserId !== filter.userId) return false;
      if (filter.band && s.band !== filter.band) return false;
      if (filter.fallingOnly && !s.fallingSharply) return false;
      return true;
    })
    .map((s) => {
      const m = byId.get(s.matterId)!;
      return {
        matterId: s.matterId,
        assignedUserId: m.assignedUserId,
        practiceArea: m.practiceArea,
        computedAt: s.computedAt,
        score: s.score,
        firmSubscore: s.firmSubscore,
        clientSubscore: s.clientSubscore,
        band: s.band,
        fallingSharply: s.fallingSharply,
        urgencyMultiplier: s.urgencyMultiplier,
        rankValue: s.rankValue,
        reasons: s.reasons,
      };
    })
    .sort((a, b) => b.rankValue - a.rankValue);
}

export async function matterHealthHistory(tx: TenantTx, tenantId: string, matterId: string, limit = 60): Promise<SnapshotRow[]> {
  return tx.select().from(matterHealthSnapshots).where(and(eq(matterHealthSnapshots.tenantId, tenantId), eq(matterHealthSnapshots.matterId, matterId))).orderBy(desc(matterHealthSnapshots.computedAt)).limit(limit);
}
