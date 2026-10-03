// c93 — statute-of-limitations tracking: database services and daily scans.
// Everything here runs on the REAL clock (deadline-critical tasks, daily
// flags at the firm's local date) — never business hours.

import { and, asc, eq, inArray, isNull, like, sql } from "drizzle-orm";
import { calendarEvents, flags } from "@/db/tables/foundation";
import { matters } from "@/db/schema";
import {
  limitationDateChanges,
  limitationDates,
  limitationReminders,
  limitationVerifications,
  matterLimitationProfiles,
} from "@/db/tables/calendar-core";
import type { TenantTx } from "@/tenancy/withTenant";
import { requireApproval } from "@/compliance/approvals";
import { RULE_GATES } from "@/compliance/gates";
import {
  audit,
  cancelTask,
  changeTaskDue,
  completeTask,
  createTask,
  getFirmSettings,
  getTask,
  raiseFlag,
  resolveFlag,
  SYSTEM_ACTOR,
  type Actor,
  type FirmSettings,
} from "@/core";
import { activeUserIdsByRole, actorOf, requireLawyer, type Staff } from "../actors";
import { endOfLocalDay, todayIn } from "../dates";
import { conflict, forbidden, invalid, notFound } from "../errors";
import { getMatter } from "../matters";
import { ENGINE, readCalendarCoreSettings, type CalendarCoreSettings } from "../settings";
import { insertEvent, LIMITATION_SOURCE_PREFIX } from "../calendar/service";
import { queueEventSync } from "../calendar/sync";
import {
  checkVerifierIndependence,
  dailyDedupeKey,
  daysRemaining,
  dedupePrefix,
  filingTaskDueAt,
  FLAG_TYPES,
  NEEDS_VERIFICATION,
  OPEN_LIMITATION_STATUSES,
  reminderLevel,
  reminderRecipients,
  remindersDue,
  suggestLimitationDate,
  TASK_KINDS,
  unverifiedLevel,
  validateLimitationEntry,
  verificationOutcome,
  type LimitationSuggestion,
  type ReminderLevel,
} from "./rules";

export type LimitationRow = typeof limitationDates.$inferSelect;

interface Ctx {
  firm: FirmSettings;
  settings: CalendarCoreSettings;
  today: string;
}

async function loadCtx(tx: TenantTx, tenantId: string, now: Date): Promise<Ctx> {
  const firm = await getFirmSettings(tx, tenantId);
  return { firm, settings: readCalendarCoreSettings(firm), today: todayIn(firm.timeZone, now) };
}

export async function getLimitation(tx: TenantTx, tenantId: string, id: string): Promise<LimitationRow> {
  const [row] = await tx.select().from(limitationDates).where(and(eq(limitationDates.tenantId, tenantId), eq(limitationDates.id, id))).limit(1);
  if (!row) throw notFound("Limitation date");
  return row;
}

/** Resolve every open flag whose dedupe key starts with `prefix` (optionally except one key). */
async function resolveFlagsByPrefix(tx: TenantTx, tenantId: string, prefix: string, by: Actor, reason: string, exceptKey?: string): Promise<number> {
  const open = await tx
    .select({ id: flags.id, dedupeKey: flags.dedupeKey })
    .from(flags)
    .where(and(eq(flags.tenantId, tenantId), isNull(flags.resolvedAt), like(flags.dedupeKey, `${prefix.replace(/[%_]/g, "\\$&")}%`)));
  let n = 0;
  for (const f of open) {
    if (exceptKey && f.dedupeKey === exceptKey) continue;
    await resolveFlag(tx, { tenantId, flagId: f.id, by, reason, engine: ENGINE });
    n++;
  }
  return n;
}

async function resolveAllForLimitation(tx: TenantTx, tenantId: string, id: string, by: Actor, reason: string): Promise<void> {
  for (const type of [FLAG_TYPES.unverified, FLAG_TYPES.reminder, FLAG_TYPES.passed, FLAG_TYPES.disputed]) {
    await resolveFlagsByPrefix(tx, tenantId, dedupePrefix(type, id), by, reason);
  }
}

async function resolveMatterFlags(tx: TenantTx, tenantId: string, matterId: string, by: Actor, reason: string): Promise<void> {
  await resolveFlagsByPrefix(tx, tenantId, `${FLAG_TYPES.decisionNeeded}:${matterId}`, by, reason);
  await resolveFlagsByPrefix(tx, tenantId, `${FLAG_TYPES.intakeRisk}:${matterId}`, by, reason);
}

async function upsertProfile(
  tx: TenantTx,
  tenantId: string,
  matterId: string,
  set: Partial<typeof matterLimitationProfiles.$inferInsert>
): Promise<void> {
  await tx
    .insert(matterLimitationProfiles)
    .values({ tenantId, matterId, ...set, updatedAt: new Date() })
    .onConflictDoUpdate({ target: [matterLimitationProfiles.tenantId, matterLimitationProfiles.matterId], set: { ...set, updatedAt: new Date() } });
}

// ---------------------------------------------------------------------------
// Lawyer actions
// ---------------------------------------------------------------------------

/** A lawyer records whether a limitation date applies to the matter at all. */
export async function setApplicability(
  tx: TenantTx,
  input: { tenantId: string; staff: Staff; matterId: string; applicability: "applies" | "not_applicable"; reason?: string | null; now?: Date }
) {
  requireLawyer(input.staff, "decide whether a limitation date applies");
  const now = input.now ?? new Date();
  await getMatter(tx, input.tenantId, input.matterId);
  const reason = input.reason?.trim() || null;
  if (input.applicability === "not_applicable") {
    if (!reason) throw invalid("Say why no limitation date applies; it is logged.");
    const open = await tx
      .select({ id: limitationDates.id })
      .from(limitationDates)
      .where(and(eq(limitationDates.tenantId, input.tenantId), eq(limitationDates.matterId, input.matterId), inArray(limitationDates.status, [...OPEN_LIMITATION_STATUSES])))
      .limit(1);
    if (open.length > 0) throw conflict("Close the matter's open limitation dates (satisfied or withdrawn) first.");
  }
  await upsertProfile(tx, input.tenantId, input.matterId, { applicability: input.applicability, decidedByUserId: input.staff.userId, decidedAt: now, reason });
  await audit(tx, {
    tenantId: input.tenantId,
    engine: ENGINE,
    action: "limitation.applicability_set",
    entityType: "matter",
    entityId: input.matterId,
    matterId: input.matterId,
    actor: actorOf(input.staff),
    reason,
    payload: { applicability: input.applicability },
  });
  if (input.applicability === "not_applicable") {
    await resolveMatterFlags(tx, input.tenantId, input.matterId, actorOf(input.staff), `No limitation date applies: ${reason}`);
  }
  return { matterId: input.matterId, applicability: input.applicability };
}

/** A lawyer enters a limitation date. It starts UNVERIFIED and is flagged daily until a second person verifies it. */
export async function enterLimitationDate(
  tx: TenantTx,
  input: {
    tenantId: string;
    staff: Staff;
    matterId: string;
    claimDescription: string;
    limitationDate: string;
    accrualDate?: string | null;
    basis?: string | null;
    now?: Date;
  }
): Promise<{ limitation: LimitationRow; warnings: string[] }> {
  requireLawyer(input.staff, "enter a limitation date");
  const now = input.now ?? new Date();
  const ctx = await loadCtx(tx, input.tenantId, now);
  const { errors, warnings } = validateLimitationEntry(input, ctx.today);
  if (errors.length > 0) throw invalid("The limitation date is not valid.", errors);
  const matter = await getMatter(tx, input.tenantId, input.matterId);
  const [profile] = await tx
    .select({ id: matterLimitationProfiles.id, intakeRiskFlagId: matterLimitationProfiles.intakeRiskFlagId })
    .from(matterLimitationProfiles)
    .where(and(eq(matterLimitationProfiles.tenantId, input.tenantId), eq(matterLimitationProfiles.matterId, input.matterId)))
    .limit(1);

  const [row] = await tx
    .insert(limitationDates)
    .values({
      tenantId: input.tenantId,
      matterId: input.matterId,
      claimDescription: input.claimDescription.trim(),
      limitationDate: input.limitationDate,
      accrualDate: input.accrualDate ?? null,
      basis: input.basis?.trim() || null,
      status: "unverified",
      enteredByUserId: input.staff.userId,
      enteredAt: now,
      source: profile?.intakeRiskFlagId ? "intake_risk" : "lawyer_entry",
    })
    .returning();
  if (!row) throw new Error("enterLimitationDate: insert failed.");

  const responsible = matter.assignedUserId ?? input.staff.userId;
  const event = await insertEvent(tx, {
    tenantId: input.tenantId,
    draft: {
      matterId: input.matterId,
      eventType: "limitation_date",
      title: `Limitation date — ${row.claimDescription}`,
      startsAt: filingTaskDueAt(row.limitationDate, ctx.firm.timeZone, "00:00"),
      endsAt: endOfLocalDay(row.limitationDate, ctx.firm.timeZone),
      allDay: true,
      isDeadline: true,
      assignedUserIds: [...new Set([responsible, input.staff.userId])],
      source: "lawyer_entry",
      sourceRef: `${LIMITATION_SOURCE_PREFIX}${row.id}`,
    },
    status: "proposed", // confirmed only after the independent verification
    createdByUserId: input.staff.userId,
    actor: actorOf(input.staff),
    now,
  });
  const filing = await createTask(
    tx,
    {
      tenantId: input.tenantId,
      kind: TASK_KINDS.filing,
      title: `File before the limitation date (${row.limitationDate}): ${row.claimDescription}`,
      owner: { type: "user", userId: responsible },
      due: { at: filingTaskDueAt(row.limitationDate, ctx.firm.timeZone, ctx.settings.limitationTaskDueLocalTime) },
      matterId: input.matterId,
      supervisorUserId: responsible !== input.staff.userId ? input.staff.userId : null,
      deadlineCritical: true,
      sourceCard: "c93",
      sourceRef: `limitation:${row.id}`,
      relatedCalendarEventId: event.id,
      createdBy: actorOf(input.staff),
      engine: ENGINE,
    },
    { now }
  );
  const verify = await createVerifyTask(tx, input.tenantId, row, ctx, now, actorOf(input.staff));
  const [updated] = await tx
    .update(limitationDates)
    .set({ calendarEventId: event.id, filingTaskId: filing.id, verifyTaskId: verify.id, updatedAt: now })
    .where(eq(limitationDates.id, row.id))
    .returning();
  await upsertProfile(tx, input.tenantId, input.matterId, { applicability: "applies", decidedByUserId: input.staff.userId, decidedAt: now });
  await audit(tx, {
    tenantId: input.tenantId,
    engine: ENGINE,
    action: "limitation.entered",
    entityType: "limitation_date",
    entityId: row.id,
    matterId: input.matterId,
    actor: actorOf(input.staff),
    payload: { limitationDate: row.limitationDate, claim: row.claimDescription, warnings },
  });
  await resolveMatterFlags(tx, input.tenantId, input.matterId, actorOf(input.staff), "A limitation date was entered.");
  return { limitation: updated ?? row, warnings };
}

async function createVerifyTask(tx: TenantTx, tenantId: string, row: LimitationRow, ctx: Ctx, now: Date, by: Actor) {
  const verifier = ctx.settings.limitationVerifierUserIds.find((id) => id !== row.enteredByUserId && id !== row.lastChangedByUserId);
  return createTask(
    tx,
    {
      tenantId,
      kind: TASK_KINDS.verify,
      title: `Independently verify a limitation date (matter ${row.matterId.slice(0, 8)})`,
      description: "Work out the date yourself from the file, then enter it. You will not be shown the date the lawyer entered.",
      owner: verifier ? { type: "user", userId: verifier } : { type: "firm" },
      due: { hours: ctx.settings.verificationDueBusinessHours, clock: "business" },
      matterId: row.matterId,
      supervisorUserId: row.enteredByUserId,
      sourceCard: "c93",
      sourceRef: `limitation:${row.id}:v${row.version}`,
      createdBy: by,
      engine: ENGINE,
    },
    { now }
  );
}

/**
 * What a verifier may see BEFORE verifying: the claim and the matter, never
 * the lawyer's date (blind, independent check).
 */
export async function getVerificationView(tx: TenantTx, tenantId: string, limitationId: string) {
  const row = await getLimitation(tx, tenantId, limitationId);
  return {
    id: row.id,
    matterId: row.matterId,
    claimDescription: row.claimDescription,
    version: row.version,
    status: row.status,
    needsVerification: (NEEDS_VERIFICATION as readonly string[]).includes(row.status),
  };
}

/** A second person enters the date they worked out. Match → verified (and calendared); mismatch → disputed. */
export async function verifyLimitationDate(
  tx: TenantTx,
  input: { tenantId: string; staff: Staff; limitationId: string; verifierDate: string; method?: string | null; notes?: string | null; now?: Date }
) {
  const now = input.now ?? new Date();
  const ctx = await loadCtx(tx, input.tenantId, now);
  const row = await getLimitation(tx, input.tenantId, input.limitationId);
  const ok = checkVerifierIndependence(row, input.staff, ctx.settings.limitationVerifierUserIds);
  if (!ok.ok) throw forbidden(ok.reason);
  const outcome = verificationOutcome(row.limitationDate, input.verifierDate);
  await tx.insert(limitationVerifications).values({
    tenantId: input.tenantId,
    limitationId: row.id,
    version: row.version,
    verifierUserId: input.staff.userId,
    verifierDate: input.verifierDate,
    outcome,
    method: input.method?.trim() || null,
    notes: input.notes?.trim() || null,
    verifiedAt: now,
  });
  const by = actorOf(input.staff);
  if (outcome === "match") {
    const [updated] = await tx
      .update(limitationDates)
      .set({ status: "verified", verifiedByUserId: input.staff.userId, verifiedAt: now, updatedAt: now })
      .where(and(eq(limitationDates.id, row.id), eq(limitationDates.version, row.version)))
      .returning();
    if (!updated) throw conflict("The date changed while you were verifying it. Verify the new version.");
    // The calendar entry is confirmed in the name of the lawyer who set this date.
    if (row.calendarEventId) {
      const [ev] = await tx
        .update(calendarEvents)
        .set({ status: "confirmed", confirmedByUserId: row.lastChangedByUserId ?? row.enteredByUserId, confirmedAt: now, updatedAt: now })
        .where(and(eq(calendarEvents.tenantId, input.tenantId), eq(calendarEvents.id, row.calendarEventId), eq(calendarEvents.status, "proposed")))
        .returning();
      if (ev) await queueEventSync(tx, input.tenantId, ev, now);
    }
    if (row.verifyTaskId) {
      const t = await getTask(tx, input.tenantId, row.verifyTaskId);
      if (t?.status === "open") await completeTask(tx, { tenantId: input.tenantId, taskId: t.id, by, reason: "Limitation date independently verified", engine: ENGINE });
    }
    await resolveFlagsByPrefix(tx, input.tenantId, dedupePrefix(FLAG_TYPES.unverified, row.id), by, "Independently verified.");
    await resolveFlagsByPrefix(tx, input.tenantId, dedupePrefix(FLAG_TYPES.disputed, row.id), by, "Independently verified.");
    await audit(tx, {
      tenantId: input.tenantId,
      engine: ENGINE,
      action: "limitation.verified",
      entityType: "limitation_date",
      entityId: row.id,
      matterId: row.matterId,
      actor: by,
      payload: { version: row.version },
    });
    return { outcome, status: "verified" as const };
  }

  await tx.update(limitationDates).set({ status: "disputed", updatedAt: now }).where(eq(limitationDates.id, row.id));
  const matter = await getMatter(tx, input.tenantId, row.matterId);
  const admins = await activeUserIdsByRole(tx, input.tenantId, ["firm_admin"]);
  await raiseFlag(
    tx,
    {
      tenantId: input.tenantId,
      type: FLAG_TYPES.disputed,
      severity: "critical",
      audience: "internal",
      title: "Limitation date disputed by the independent check",
      summary: `The second person's date does not match the date entered for '${row.claimDescription}'. A lawyer must review: correct the date (with a reason) or have another person verify.`,
      details: { limitationId: row.id, version: row.version },
      matterId: row.matterId,
      recipients: {
        userIds: reminderRecipients({
          responsibleUserId: matter.assignedUserId,
          enteredByUserId: row.lastChangedByUserId ?? row.enteredByUserId,
          escalationUserIds: ctx.settings.limitationEscalationUserIds,
          adminUserIds: admins,
          level: { escalate: true, allAdmins: false },
        }),
      },
      dedupeKey: dailyDedupeKey(FLAG_TYPES.disputed, row.id, `v${row.version}`),
      urgent: true,
      sourceCard: "c93",
      engine: ENGINE,
    },
    { now }
  );
  await audit(tx, {
    tenantId: input.tenantId,
    engine: ENGINE,
    action: "limitation.disputed",
    entityType: "limitation_date",
    entityId: row.id,
    matterId: row.matterId,
    actor: by,
    payload: { version: row.version },
  });
  return { outcome, status: "disputed" as const };
}

/** Only a lawyer changes the date, with a logged reason. The change needs a fresh independent verification. */
export async function changeLimitationDate(
  tx: TenantTx,
  input: { tenantId: string; staff: Staff; limitationId: string; newDate: string; reason: string; now?: Date }
) {
  requireLawyer(input.staff, "change a limitation date");
  const reason = input.reason?.trim();
  if (!reason) throw invalid("A reason is required to change a limitation date; it is logged.");
  const now = input.now ?? new Date();
  const ctx = await loadCtx(tx, input.tenantId, now);
  const row = await getLimitation(tx, input.tenantId, input.limitationId);
  if (!(OPEN_LIMITATION_STATUSES as readonly string[]).includes(row.status)) throw conflict(`This limitation date is ${row.status}.`);
  if (row.limitationDate === input.newDate) throw invalid("The new date is the same as the current one.");
  const { errors, warnings } = validateLimitationEntry({ claimDescription: row.claimDescription, limitationDate: input.newDate, accrualDate: row.accrualDate }, ctx.today);
  if (errors.length > 0) throw invalid("The new date is not valid.", errors);

  await tx.insert(limitationDateChanges).values({
    tenantId: input.tenantId,
    limitationId: row.id,
    fromVersion: row.version,
    toVersion: row.version + 1,
    fromDate: row.limitationDate,
    toDate: input.newDate,
    reason,
    changedByUserId: input.staff.userId,
    changedAt: now,
  });
  const [updated] = await tx
    .update(limitationDates)
    .set({
      limitationDate: input.newDate,
      version: row.version + 1,
      status: "unverified",
      verifiedByUserId: null,
      verifiedAt: null,
      lastChangedByUserId: input.staff.userId,
      lastChangedAt: now,
      updatedAt: now,
    })
    .where(and(eq(limitationDates.id, row.id), eq(limitationDates.version, row.version)))
    .returning();
  if (!updated) throw conflict("The date was changed by someone else at the same time. Reload and try again.");
  const by = actorOf(input.staff);
  if (row.calendarEventId) {
    const [ev] = await tx
      .update(calendarEvents)
      .set({
        startsAt: filingTaskDueAt(input.newDate, ctx.firm.timeZone, "00:00"),
        endsAt: endOfLocalDay(input.newDate, ctx.firm.timeZone),
        status: "proposed",
        confirmedByUserId: null,
        confirmedAt: null,
        updatedAt: now,
      })
      .where(and(eq(calendarEvents.tenantId, input.tenantId), eq(calendarEvents.id, row.calendarEventId)))
      .returning();
    if (ev) await queueEventSync(tx, input.tenantId, ev, now);
  }
  if (row.filingTaskId) {
    const t = await getTask(tx, input.tenantId, row.filingTaskId);
    if (t?.status === "open") {
      await changeTaskDue(tx, {
        tenantId: input.tenantId,
        taskId: t.id,
        dueAt: filingTaskDueAt(input.newDate, ctx.firm.timeZone, ctx.settings.limitationTaskDueLocalTime),
        by,
        reason: `Limitation date changed: ${reason}`,
        engine: ENGINE,
      });
    }
  }
  // A fresh verification is needed: close the old verification task and open a new one.
  if (row.verifyTaskId) {
    const t = await getTask(tx, input.tenantId, row.verifyTaskId);
    if (t?.status === "open") await cancelTask(tx, { tenantId: input.tenantId, taskId: t.id, by, reason: "Date changed — a new verification is needed", engine: ENGINE });
  }
  const verify = await createVerifyTask(tx, input.tenantId, updated, ctx, now, by);
  await tx.update(limitationDates).set({ verifyTaskId: verify.id }).where(eq(limitationDates.id, row.id));
  await resolveAllForLimitation(tx, input.tenantId, row.id, by, `Limitation date changed: ${reason}`);
  await audit(tx, {
    tenantId: input.tenantId,
    engine: ENGINE,
    action: "limitation.changed",
    entityType: "limitation_date",
    entityId: row.id,
    matterId: row.matterId,
    actor: by,
    reason,
    payload: { from: row.limitationDate, to: input.newDate, version: updated.version, warnings },
  });
  return { limitation: { ...updated, verifyTaskId: verify.id }, warnings };
}

/** A lawyer closes the watch: 'satisfied' (claim filed/resolved) or 'withdrawn' (entered in error / claim not pursued). */
export async function closeLimitation(
  tx: TenantTx,
  input: { tenantId: string; staff: Staff; limitationId: string; outcome: "satisfied" | "withdrawn"; reason: string; now?: Date }
) {
  requireLawyer(input.staff, "close a limitation date");
  const reason = input.reason?.trim();
  if (!reason) throw invalid("A reason is required; it is logged.");
  const now = input.now ?? new Date();
  const row = await getLimitation(tx, input.tenantId, input.limitationId);
  if (!(OPEN_LIMITATION_STATUSES as readonly string[]).includes(row.status)) throw conflict(`This limitation date is already ${row.status}.`);
  const [updated] = await tx
    .update(limitationDates)
    .set({ status: input.outcome, closedReason: reason, closedByUserId: input.staff.userId, closedAt: now, updatedAt: now })
    .where(eq(limitationDates.id, row.id))
    .returning();
  const by = actorOf(input.staff);
  for (const taskId of [row.filingTaskId, row.verifyTaskId]) {
    if (!taskId) continue;
    const t = await getTask(tx, input.tenantId, taskId);
    if (t?.status !== "open") continue;
    if (input.outcome === "satisfied" && taskId === row.filingTaskId) {
      await completeTask(tx, { tenantId: input.tenantId, taskId, by, reason: `Limitation satisfied: ${reason}`, engine: ENGINE });
    } else {
      await cancelTask(tx, { tenantId: input.tenantId, taskId, by, reason: `Limitation ${input.outcome}: ${reason}`, engine: ENGINE });
    }
  }
  if (row.calendarEventId) {
    const [ev] = await tx
      .update(calendarEvents)
      .set({ status: "cancelled", cancelledAt: now, cancelReason: `Limitation ${input.outcome}: ${reason}`, updatedAt: now })
      .where(and(eq(calendarEvents.tenantId, input.tenantId), eq(calendarEvents.id, row.calendarEventId)))
      .returning();
    if (ev) await queueEventSync(tx, input.tenantId, ev, now);
  }
  await resolveAllForLimitation(tx, input.tenantId, row.id, by, `Limitation ${input.outcome}: ${reason}`);
  await audit(tx, {
    tenantId: input.tenantId,
    engine: ENGINE,
    action: `limitation.${input.outcome}`,
    entityType: "limitation_date",
    entityId: row.id,
    matterId: row.matterId,
    actor: by,
    reason,
  });
  return updated;
}

/** A SUGGESTION from the firm's period table — gated on 'rules.limitation_periods'; never saved as the date. */
export async function suggestDate(
  tx: TenantTx,
  input: { tenantId: string; staff: Staff; matterId: string; periodKey: string; accrualDate: string }
): Promise<LimitationSuggestion> {
  requireLawyer(input.staff, "ask for a limitation-date suggestion");
  requireApproval(RULE_GATES.limitationPeriods.key, { action: "limitation.suggest", tenantId: input.tenantId, detail: { periodKey: input.periodKey } });
  const settings = readCalendarCoreSettings(await getFirmSettings(tx, input.tenantId));
  const period = settings.limitationPeriods.find((p) => p.key === input.periodKey);
  if (!period) throw notFound("Limitation period in the firm's table");
  const suggestion = suggestLimitationDate(input.accrualDate, period);
  await audit(tx, {
    tenantId: input.tenantId,
    engine: ENGINE,
    action: "limitation.suggestion_shown",
    entityType: "matter",
    entityId: input.matterId,
    matterId: input.matterId,
    actor: actorOf(input.staff),
    payload: { periodKey: period.key, accrualDate: input.accrualDate, suggestedDate: suggestion.suggestedDate },
  });
  return suggestion;
}

/** A matter's limitation dates with their change and verification history (staff only). */
export async function listForMatter(tx: TenantTx, tenantId: string, matterId: string, now: Date = new Date()) {
  const ctx = await loadCtx(tx, tenantId, now);
  const rows = await tx.select().from(limitationDates).where(and(eq(limitationDates.tenantId, tenantId), eq(limitationDates.matterId, matterId))).orderBy(asc(limitationDates.limitationDate));
  const ids = rows.map((r) => r.id);
  const [changes, verifications, profile] = await Promise.all([
    ids.length ? tx.select().from(limitationDateChanges).where(and(eq(limitationDateChanges.tenantId, tenantId), inArray(limitationDateChanges.limitationId, ids))) : [],
    ids.length ? tx.select().from(limitationVerifications).where(and(eq(limitationVerifications.tenantId, tenantId), inArray(limitationVerifications.limitationId, ids))) : [],
    tx.select().from(matterLimitationProfiles).where(and(eq(matterLimitationProfiles.tenantId, tenantId), eq(matterLimitationProfiles.matterId, matterId))).limit(1),
  ]);
  return {
    profile: profile[0] ?? null,
    limitations: rows.map((r) => ({
      ...r,
      daysRemaining: daysRemaining(r.limitationDate, ctx.today),
      changes: changes.filter((c) => c.limitationId === r.id),
      verifications: verifications.filter((v) => v.limitationId === r.id),
    })),
  };
}

/** Firm dashboard: every open limitation date, soonest first, with verification state. */
export async function listOpenLimitations(tx: TenantTx, tenantId: string, now: Date = new Date()) {
  const ctx = await loadCtx(tx, tenantId, now);
  const rows = await tx
    .select()
    .from(limitationDates)
    .where(and(eq(limitationDates.tenantId, tenantId), inArray(limitationDates.status, [...OPEN_LIMITATION_STATUSES])))
    .orderBy(asc(limitationDates.limitationDate));
  return rows.map((r) => ({
    id: r.id,
    matterId: r.matterId,
    claimDescription: r.claimDescription,
    limitationDate: r.limitationDate,
    status: r.status,
    version: r.version,
    daysRemaining: daysRemaining(r.limitationDate, ctx.today),
    needsVerification: (NEEDS_VERIFICATION as readonly string[]).includes(r.status),
  }));
}

// ---------------------------------------------------------------------------
// Worker scans (real clock)
// ---------------------------------------------------------------------------

async function recipientsFor(tx: TenantTx, tenantId: string, row: LimitationRow, level: Pick<ReminderLevel, "escalate" | "allAdmins">, ctx: Ctx, assigned: string | null) {
  const admins = await activeUserIdsByRole(tx, tenantId, ["firm_admin"]);
  const ids = reminderRecipients({
    responsibleUserId: assigned,
    enteredByUserId: row.lastChangedByUserId ?? row.enteredByUserId,
    escalationUserIds: ctx.settings.limitationEscalationUserIds,
    adminUserIds: admins,
    level,
  });
  return ids;
}

/**
 * Daily: every unverified/disputed date gets today's flag (yesterday's is
 * resolved as superseded); escalating reminders at the firm's thresholds; a
 * date that has passed while still open is flagged critical every day.
 */
export async function runLimitationScan(tx: TenantTx, tenantId: string, now: Date) {
  const ctx = await loadCtx(tx, tenantId, now);
  const rows = await tx
    .select({ l: limitationDates, assigned: matters.assignedUserId })
    .from(limitationDates)
    .innerJoin(matters, eq(matters.id, limitationDates.matterId))
    .where(and(eq(limitationDates.tenantId, tenantId), inArray(limitationDates.status, [...OPEN_LIMITATION_STATUSES])));
  const out = { unverifiedFlags: 0, reminders: 0, passedFlags: 0 };
  for (const { l, assigned } of rows) {
    const days = daysRemaining(l.limitationDate, ctx.today);

    if (days < 0) {
      const key = dailyDedupeKey(FLAG_TYPES.passed, l.id, ctx.today);
      await resolveFlagsByPrefix(tx, tenantId, dedupePrefix(FLAG_TYPES.passed, l.id), SYSTEM_ACTOR, `Re-flagged on ${ctx.today}.`, key);
      const r = await raiseFlag(
        tx,
        {
          tenantId,
          type: FLAG_TYPES.passed,
          severity: "critical",
          audience: "internal",
          title: "Limitation date has passed and is not marked satisfied",
          summary: `'${l.claimDescription}': the limitation date ${l.limitationDate} passed ${-days} day(s) ago. A lawyer must review now and record what happened.`,
          details: { limitationId: l.id, limitationDate: l.limitationDate, daysRemaining: days },
          matterId: l.matterId,
          recipients: { userIds: await recipientsFor(tx, tenantId, l, { escalate: true, allAdmins: true }, ctx, assigned) },
          dedupeKey: key,
          urgent: true,
          sourceCard: "c93",
          engine: ENGINE,
        },
        { now }
      );
      if (r.created) out.passedFlags++;
    }

    if ((NEEDS_VERIFICATION as readonly string[]).includes(l.status)) {
      const key = dailyDedupeKey(FLAG_TYPES.unverified, l.id, ctx.today);
      await resolveFlagsByPrefix(tx, tenantId, dedupePrefix(FLAG_TYPES.unverified, l.id), SYSTEM_ACTOR, `Still unverified — re-flagged on ${ctx.today}.`, key);
      const level = unverifiedLevel(days, l.status, ctx.settings);
      const r = await raiseFlag(
        tx,
        {
          tenantId,
          type: FLAG_TYPES.unverified,
          severity: level.severity,
          audience: "internal",
          title: l.status === "disputed" ? "Limitation date disputed — still not verified" : "Limitation date not yet independently verified",
          summary: `'${l.claimDescription}' (${days >= 0 ? `${days} day(s) left` : "date passed"}). A second person must verify it.`,
          details: { limitationId: l.id, version: l.version, daysRemaining: days, status: l.status },
          matterId: l.matterId,
          recipients: { userIds: await recipientsFor(tx, tenantId, l, level, ctx, assigned) },
          dedupeKey: key,
          urgent: level.urgent,
          sourceCard: "c93",
          engine: ENGINE,
        },
        { now }
      );
      if (r.created) out.unverifiedFlags++;
    }

    const recorded = await tx
      .select({ t: limitationReminders.thresholdDays })
      .from(limitationReminders)
      .where(and(eq(limitationReminders.tenantId, tenantId), eq(limitationReminders.limitationId, l.id), eq(limitationReminders.version, l.version)));
    const due = remindersDue(ctx.settings.limitationReminderDays, days, new Set(recorded.map((r) => r.t)));
    for (const t of due.skip) {
      await tx.insert(limitationReminders).values({ tenantId, limitationId: l.id, version: l.version, thresholdDays: t, sent: false }).onConflictDoNothing();
    }
    if (due.send !== null) {
      const level = reminderLevel(days, ctx.settings);
      const { flag } = await raiseFlag(
        tx,
        {
          tenantId,
          type: FLAG_TYPES.reminder,
          severity: level.severity,
          audience: "internal",
          title: `Limitation date in ${days} day(s): ${l.limitationDate}`,
          summary: `'${l.claimDescription}' — ${l.status === "verified" ? "verified" : "NOT YET VERIFIED"}. Reminder at the ${due.send}-day mark.`,
          details: { limitationId: l.id, version: l.version, thresholdDays: due.send, daysRemaining: days },
          matterId: l.matterId,
          recipients: { userIds: await recipientsFor(tx, tenantId, l, level, ctx, assigned) },
          dedupeKey: dailyDedupeKey(FLAG_TYPES.reminder, l.id, `v${l.version}-${due.send}`),
          urgent: level.urgent,
          sourceCard: "c93",
          engine: ENGINE,
        },
        { now }
      );
      // Older, less urgent reminders for this record are superseded by this one.
      await resolveFlagsByPrefix(tx, tenantId, dedupePrefix(FLAG_TYPES.reminder, l.id), SYSTEM_ACTOR, `Superseded by the ${due.send}-day reminder.`, flag.dedupeKey ?? undefined);
      await tx
        .insert(limitationReminders)
        .values({ tenantId, limitationId: l.id, version: l.version, thresholdDays: due.send, sent: true, flagId: flag.id })
        .onConflictDoNothing();
      out.reminders++;
    }
  }
  return out;
}

/**
 * Retained matters with no lawyer decision on limitations (or "applies" but
 * no open date), and matters an intake deadline-risk alert (c66) pointed at.
 * One open flag per matter until a lawyer acts.
 */
export async function runLimitationCoverageScan(tx: TenantTx, tenantId: string, now: Date) {
  const ctx = await loadCtx(tx, tenantId, now);
  const out = { decisionFlags: 0, intakeRiskFlags: 0 };
  const admins = await activeUserIdsByRole(tx, tenantId, ["firm_admin"]);

  // c66 → c93: open intake deadline-risk flags on a matter.
  const riskFlags = await tx
    .select({ id: flags.id, matterId: flags.matterId })
    .from(flags)
    .where(and(eq(flags.tenantId, tenantId), eq(flags.type, "intake.deadline_risk"), isNull(flags.resolvedAt), sql`${flags.matterId} is not null`));
  const riskByMatter = new Map(riskFlags.map((f) => [f.matterId as string, f.id]));

  const candidates = await tx
    .select({
      matterId: matters.id,
      assigned: matters.assignedUserId,
      stage: matters.stage,
      applicability: matterLimitationProfiles.applicability,
      profileRiskFlag: matterLimitationProfiles.intakeRiskFlagId,
    })
    .from(matters)
    .leftJoin(matterLimitationProfiles, and(eq(matterLimitationProfiles.tenantId, matters.tenantId), eq(matterLimitationProfiles.matterId, matters.id)))
    .where(and(eq(matters.tenantId, tenantId), sql`${matters.stage} <> 'closed'`));
  const openRows = await tx
    .select({ matterId: limitationDates.matterId })
    .from(limitationDates)
    .where(and(eq(limitationDates.tenantId, tenantId), inArray(limitationDates.status, [...OPEN_LIMITATION_STATUSES])));
  const withOpenDate = new Set(openRows.map((r) => r.matterId));

  for (const m of candidates) {
    const recipients = m.assigned ? [m.assigned] : admins;
    if (recipients.length === 0) continue;
    const riskFlagId = riskByMatter.get(m.matterId);
    if (riskFlagId && m.applicability !== "not_applicable" && !withOpenDate.has(m.matterId)) {
      if (m.profileRiskFlag !== riskFlagId) await upsertProfile(tx, tenantId, m.matterId, { intakeRiskFlagId: riskFlagId });
      const r = await raiseFlag(
        tx,
        {
          tenantId,
          type: FLAG_TYPES.intakeRisk,
          severity: "high",
          audience: "internal",
          title: "Intake noted a possible deadline risk — no limitation date recorded",
          summary: "A lawyer should decide whether a limitation date applies and, if so, enter it for independent verification.",
          details: { intakeFlagId: riskFlagId },
          matterId: m.matterId,
          recipients: { userIds: recipients },
          dedupeKey: `${FLAG_TYPES.intakeRisk}:${m.matterId}`,
          urgent: true,
          sourceCard: "c93",
          engine: ENGINE,
        },
        { now }
      );
      if (r.created) out.intakeRiskFlags++;
      continue;
    }
    if (!ctx.settings.requireLimitationDecision || m.stage !== "retained") continue;
    const needsDecision = !m.applicability || m.applicability === "unknown" || (m.applicability === "applies" && !withOpenDate.has(m.matterId));
    if (!needsDecision) continue;
    const r = await raiseFlag(
      tx,
      {
        tenantId,
        type: FLAG_TYPES.decisionNeeded,
        severity: "warning",
        audience: "internal",
        title: m.applicability === "applies" ? "Limitation applies but no open limitation date is recorded" : "Decide whether a limitation date applies to this matter",
        summary: "Enter the limitation date (it will be verified by a second person), or record that none applies with a reason.",
        details: { applicability: m.applicability ?? "unknown" },
        matterId: m.matterId,
        recipients: { userIds: recipients },
        dedupeKey: `${FLAG_TYPES.decisionNeeded}:${m.matterId}`,
        sourceCard: "c93",
        engine: ENGINE,
      },
      { now }
    );
    if (r.created) out.decisionFlags++;
  }
  return out;
}
