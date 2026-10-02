// c63 — conflicts log and report. Database side: assembles one read-only
// record per check from the source tables (no second editable copy), the
// open queue, and background exports.

import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { parties, scheduledTasks } from "@/db/schema";
import { auditEvents } from "@/db/tables/foundation";
import {
  conflictChecks,
  conflictDecisions,
  conflictExports,
  conflictScreens,
  conflictWaivers,
  nonEngagementLetters,
} from "@/db/tables/conflict-check";
import { audit, auditBlocked, getFirmSettings, normalizeName, toBusinessCalendar } from "@/core";
import { PendingApprovalError, requireApproval } from "@/compliance/approvals";
import type { TenantTx } from "@/tenancy/withTenant";
import { assertCan, loadAccess, screenedSubjectIds, type ConflictAccess } from "./access";
import type { ConflictCheckRow } from "./checks";
import { CONFLICT_RULE_GATES } from "./gates";
import { canSeeRecord, matchesFilter, redactRecord, summarize, toCsv, waitingTimes, type LogFilter, type LogRecord, type RedactionLevel } from "./log";
import { ENGINE, readConflictSettings } from "./settings";
import type { ConflictHit, SearchedName } from "./types";
import { actorFor, ConflictError } from "./util";

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

async function assemble(tx: TenantTx, tenantId: string, checks: ConflictCheckRow[], withGateHistory: boolean): Promise<LogRecord[]> {
  const ids = checks.map((c) => c.id);
  if (ids.length === 0) return [];
  const [decisions, waivers, screens, letters] = await Promise.all([
    tx.select().from(conflictDecisions).where(and(eq(conflictDecisions.tenantId, tenantId), inArray(conflictDecisions.checkId, ids))).orderBy(asc(conflictDecisions.decidedAt)),
    tx
      .select({ w: conflictWaivers, clientName: parties.fullName })
      .from(conflictWaivers)
      .innerJoin(parties, eq(parties.id, conflictWaivers.clientPartyId))
      .where(and(eq(conflictWaivers.tenantId, tenantId), inArray(conflictWaivers.checkId, ids))),
    tx.select().from(conflictScreens).where(and(eq(conflictScreens.tenantId, tenantId), inArray(conflictScreens.checkId, ids))),
    tx.select().from(nonEngagementLetters).where(and(eq(nonEngagementLetters.tenantId, tenantId), inArray(nonEngagementLetters.checkId, ids))),
  ]);

  let gateEvents: Array<typeof auditEvents.$inferSelect> = [];
  if (withGateHistory) {
    const subjectIds = [...new Set(checks.flatMap((c) => [c.intakeSessionId, c.matterId, ...c.affectedMatterIds]).filter((x): x is string => !!x))];
    if (subjectIds.length > 0) {
      gateEvents = await tx
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.tenantId, tenantId),
            eq(auditEvents.engine, ENGINE),
            eq(auditEvents.action, "gate.changed"),
            inArray(auditEvents.entityId, subjectIds)
          )
        )
        .orderBy(asc(auditEvents.occurredAt));
    }
  }

  return checks.map((c) => {
    const subjectIds = new Set([c.intakeSessionId, c.matterId, ...c.affectedMatterIds].filter(Boolean));
    return {
      checkId: c.id,
      trigger: c.trigger,
      triggeredByUserId: c.triggeredByUserId,
      createdAt: c.createdAt.toISOString(),
      matterId: c.matterId,
      intakeSessionId: c.intakeSessionId,
      searched: c.searchedNames as SearchedName[],
      hits: c.hits as ConflictHit[],
      outcome: c.outcome,
      outcomeReasons: c.outcomeReasons,
      status: c.status,
      assignedUserId: c.assignedUserId,
      dueAt: iso(c.dueAt),
      decisions: decisions
        .filter((d) => d.checkId === c.id)
        .map((d) => ({
          id: d.id,
          decision: d.decision,
          reasonCode: d.reasonCode,
          reasonText: d.reasonText,
          ruleTableRefs: d.ruleTableRefs,
          overrideFlag: d.overrideFlag,
          decidedByUserId: d.decidedByUserId,
          decidedAt: d.decidedAt.toISOString(),
          supersedesDecisionId: d.supersedesDecisionId,
        })),
      waivers: waivers
        .filter((x) => x.w.checkId === c.id)
        .map((x) => ({ id: x.w.id, clientName: x.clientName, status: x.w.status, sentAt: iso(x.w.sentAt), signedAt: iso(x.w.signedAt), countersignedAt: iso(x.w.countersignedAt) })),
      screens: screens
        .filter((s) => s.checkId === c.id)
        .map((s) => ({ id: s.id, screenedUserId: s.screenedUserId, status: s.status, activatedAt: iso(s.activatedAt), noticeSentAt: iso(s.noticeSentAt) })),
      letters: letters.filter((l) => l.checkId === c.id).map((l) => ({ id: l.id, status: l.status, channel: l.channel, sentAt: iso(l.sentAt) })),
      gateHistory: gateEvents
        .filter((e) => e.entityId && subjectIds.has(e.entityId) && e.occurredAt.getTime() >= c.createdAt.getTime())
        .map((e) => ({
          at: e.occurredAt.toISOString(),
          from: (e.payload.from as string | null) ?? null,
          to: String(e.payload.to),
          closedReason: (e.payload.closedReason as string | null) ?? null,
        })),
    };
  });
}

/** Searchable log (c63 §4.1). Returns only records this user may see. */
export async function listLog(tx: TenantTx, input: { tenantId: string; access: ConflictAccess; filter?: LogFilter; limit?: number }): Promise<LogRecord[]> {
  assertCan(input.access, "log.view");
  const checks = await tx
    .select()
    .from(conflictChecks)
    .where(eq(conflictChecks.tenantId, input.tenantId))
    .orderBy(desc(conflictChecks.createdAt))
    .limit(Math.min(input.limit ?? 500, 5000));
  const screened = await screenedSubjectIds(tx, input.tenantId, input.access.userId);
  const records = (await assemble(tx, input.tenantId, checks, false)).filter((r) => canSeeRecord(r, input.access.caps, screened));
  // Name search is only for users who may search party details.
  const filter = { ...(input.filter ?? {}) };
  if (filter.q && !input.access.caps.has("index.search")) delete filter.q;
  const shown = records.filter((r) => matchesFilter(r, filter, normalizeName));
  return input.access.caps.has("index.search") ? shown : shown.map((r) => redactRecord(r, "summary"));
}

/** One full record; every view is logged (c63 rule 5). */
export async function getLogRecord(tx: TenantTx, input: { tenantId: string; checkId: string; access: ConflictAccess }): Promise<LogRecord> {
  assertCan(input.access, "log.view");
  const [check] = await tx.select().from(conflictChecks).where(and(eq(conflictChecks.tenantId, input.tenantId), eq(conflictChecks.id, input.checkId))).limit(1);
  if (!check) throw new ConflictError("Record not found.", 404);
  const [record] = await assemble(tx, input.tenantId, [check], true);
  const screened = await screenedSubjectIds(tx, input.tenantId, input.access.userId);
  if (!record || !canSeeRecord(record, input.access.caps, screened)) throw new ConflictError("Record not found.", 404);
  const full = input.access.caps.has("index.search");
  await audit(tx, {
    tenantId: input.tenantId,
    engine: ENGINE,
    action: "log.record_viewed",
    entityType: "conflict_check",
    entityId: check.id,
    actor: actorFor(input.access),
    payload: { level: full ? "full" : "summary" },
  });
  return full ? record : redactRecord(record, "summary");
}

export interface QueueItem {
  checkId: string;
  trigger: string;
  outcome: string;
  createdAt: string;
  dueAt: string | null;
  assignedUserId: string | null;
  waitingBusinessHours: number;
  ageRealHours: number;
  overdue: boolean;
  hitCount: number;
}

/** Open 'possible'/'definite' checks waiting on a decision, oldest first (c63 §4.2). */
export async function openQueue(tx: TenantTx, input: { tenantId: string; access: ConflictAccess; now?: Date }): Promise<QueueItem[]> {
  assertCan(input.access, "queue.view");
  const now = input.now ?? new Date();
  const calendar = toBusinessCalendar(await getFirmSettings(tx, input.tenantId));
  const checks = await tx
    .select()
    .from(conflictChecks)
    .where(and(eq(conflictChecks.tenantId, input.tenantId), eq(conflictChecks.status, "open")))
    .orderBy(asc(conflictChecks.createdAt));
  const screened = await screenedSubjectIds(tx, input.tenantId, input.access.userId);
  const caps = new Set(input.access.caps);
  caps.add("log.view"); // queue visibility follows the same record rules
  return checks
    .filter((c) => canSeeRecord({ trigger: c.trigger, hits: c.hits as ConflictHit[], matterId: c.matterId, intakeSessionId: c.intakeSessionId }, caps, screened))
    .map((c) => {
      const w = waitingTimes(c.createdAt, now, calendar);
      return {
        checkId: c.id,
        trigger: c.trigger,
        outcome: c.outcome,
        createdAt: c.createdAt.toISOString(),
        dueAt: iso(c.dueAt),
        assignedUserId: c.assignedUserId,
        waitingBusinessHours: w.businessHours,
        ageRealHours: w.realHours,
        overdue: !!c.dueAt && now.getTime() > c.dueAt.getTime(),
        hitCount: (c.hits as unknown[]).length,
      };
    });
}

// ---------------------------------------------------------------------------
// Exports (c63 §4.3)
// ---------------------------------------------------------------------------

export const EXPORT_TASK_TYPE = "conflict-check.export_generate";

function requireFullExportApproval(tenantId: string): void {
  // What may go to an insurer or the bar with names in it is a legal question (c63 §9).
  requireApproval(CONFLICT_RULE_GATES.exportDisclosure.key, { action: "conflict-check.export_full", tenantId });
}

/** Queue an export; generated by the worker, downloadable by the requester only until it expires. */
export async function requestExport(
  tx: TenantTx,
  input: { tenantId: string; access: ConflictAccess; filter?: LogFilter; format?: "csv" | "json"; redaction?: RedactionLevel; now?: Date }
) {
  assertCan(input.access, "log.export");
  const now = input.now ?? new Date();
  const settings = readConflictSettings(await getFirmSettings(tx, input.tenantId));
  const redaction = input.redaction ?? settings.defaultExportRedaction;
  if (redaction === "full") {
    if (!input.access.caps.has("index.search")) throw new ConflictError("Full exports need access to party details.", 403);
    try {
      requireFullExportApproval(input.tenantId);
    } catch (err) {
      if (err instanceof PendingApprovalError) {
        await auditBlocked(tx, err, { tenantId: input.tenantId, engine: ENGINE, entityType: "conflict_export", actor: actorFor(input.access) });
      }
      throw err;
    }
  }
  const [row] = await tx
    .insert(conflictExports)
    .values({
      tenantId: input.tenantId,
      requestedByUserId: input.access.userId,
      filter: { ...(input.filter ?? {}) },
      format: input.format ?? "csv",
      redactionLevel: redaction,
      expiresAt: new Date(now.getTime() + settings.exportLinkHours * 3_600_000),
    })
    .returning();
  await tx.insert(scheduledTasks).values({ tenantId: input.tenantId, taskType: EXPORT_TASK_TYPE, dueAt: now, payload: { exportId: row!.id } });
  await audit(tx, {
    tenantId: input.tenantId,
    engine: ENGINE,
    action: "log.export_requested",
    entityType: "conflict_export",
    entityId: row!.id,
    actor: actorFor(input.access),
    payload: { filter: row!.filter, format: row!.format, redaction },
  });
  return row!;
}

/** Worker handler body: build the file with the requester's CURRENT access. */
export async function generateExport(tx: TenantTx, tenantId: string, exportId: string, now = new Date()) {
  const [req] = await tx.select().from(conflictExports).where(and(eq(conflictExports.tenantId, tenantId), eq(conflictExports.id, exportId))).limit(1);
  if (!req || req.status !== "queued") return;
  const access = await loadAccess(tx, tenantId, req.requestedByUserId);
  const level = req.redactionLevel as RedactionLevel;
  const fail = async (status: "failed" | "blocked", error: string) => {
    await tx.update(conflictExports).set({ status, error }).where(eq(conflictExports.id, req.id));
    await audit(tx, { tenantId, engine: ENGINE, action: `log.export_${status}`, entityType: "conflict_export", entityId: req.id, payload: { error } });
  };
  if (!access.caps.has("log.export")) return fail("failed", "The requester no longer has export access.");
  if (level === "full") {
    try {
      requireFullExportApproval(tenantId);
    } catch (err) {
      if (err instanceof PendingApprovalError) return fail("blocked", err.placeholder);
      throw err;
    }
  }
  const records = await listLog(tx, { tenantId, access, filter: req.filter as LogFilter, limit: 5000 });
  const shaped = records.map((r) => redactRecord(r, level));
  const content =
    req.format === "json"
      ? JSON.stringify({ generatedAt: now.toISOString(), redaction: level, summary: summarize(shaped), records: level === "summary" ? undefined : shaped }, null, 2)
      : toCsv(shaped, level);
  await tx
    .update(conflictExports)
    .set({ status: "ready", content, rowCount: shaped.length, generatedAt: now })
    .where(eq(conflictExports.id, req.id));
  await audit(tx, { tenantId, engine: ENGINE, action: "log.export_generated", entityType: "conflict_export", entityId: req.id, payload: { rows: shaped.length } });
}

export async function downloadExport(tx: TenantTx, input: { tenantId: string; exportId: string; access: ConflictAccess; now?: Date }) {
  const now = input.now ?? new Date();
  const [req] = await tx.select().from(conflictExports).where(and(eq(conflictExports.tenantId, input.tenantId), eq(conflictExports.id, input.exportId))).limit(1);
  // The requester only (c63 §4.3.4); others get "not found", not "forbidden".
  if (!req || req.requestedByUserId !== input.access.userId) throw new ConflictError("Export not found.", 404);
  if (now.getTime() > req.expiresAt.getTime()) throw new ConflictError("This export link has expired.", 410);
  if (req.status !== "ready" || req.content === null) {
    return { ready: false as const, status: req.status, error: req.error };
  }
  await audit(tx, { tenantId: input.tenantId, engine: ENGINE, action: "log.export_downloaded", entityType: "conflict_export", entityId: req.id, actor: actorFor(input.access) });
  return {
    ready: true as const,
    format: req.format,
    filename: `conflicts-log-${req.createdAt.toISOString().slice(0, 10)}-${req.redactionLevel}.${req.format}`,
    content: req.content,
  };
}
