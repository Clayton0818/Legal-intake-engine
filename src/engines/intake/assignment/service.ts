// c48 — automatic assignment (database operations).

import { and, count, desc, eq, gte, inArray, isNull, lte, ne, notInArray, or, sql } from "drizzle-orm";
import { matters, users } from "@/db/schema";
import { calendarEvents, tasks } from "@/db/tables/foundation";
import {
  intakeAssignmentBlocks,
  intakeLawyerProfiles,
  intakeMatterAssignments,
  intakeOutOfOffice,
} from "@/db/tables/intake";
import { matterParties } from "@/db/schema";
import type { TenantTx } from "@/tenancy/withTenant";
import { businessHoursBetween } from "@/core/businessHours";
import { raiseFlag } from "@/core/flags";
import { practiceAreaForClassifierLabel } from "@/core/practiceAreas";
import type { Actor } from "@/core/audit";
import { requireStaff, resolveEscalationContacts, SUPERVISOR_ROLES, userActor } from "../common/actors";
import { loadIntakeContext, type IntakeContext } from "../common/context";
import { IntakeRuleError, requireReason } from "../common/errors";
import { recordIntakeEvent } from "../common/events";
import { notifyStaff } from "../common/notify";
import { getMatter, latestSessionForMatter, type IntakeSessionRow, type MatterRow } from "../common/sessions";
import { addBusinessDays } from "../common/time";
import { getConflictStatusForMatter, isConflictCleared } from "../adapters/conflictStatus";
import { INTAKE_ENGINE, settingsVersion } from "../settings";
import { decideAssignment, overrideCheck, type AssignmentDecision, type AssignmentMatter, type Candidate } from "./scoring";

/** Matter stages that count as "open work" for workload. */
const CLOSED_STAGES = ["closed", "declined_conflict", "did_not_schedule", "did_not_hire_referred_out"] as const;

/** Pure: the assignment view of a matter, from the matter and its intake session. */
export function assignmentMatterFrom(matter: Pick<MatterRow, "practiceArea">, session: Pick<IntakeSessionRow, "language" | "classifierOutput" | "collectedAnswers"> | null): AssignmentMatter {
  const classifier = (session?.classifierOutput ?? {}) as Record<string, unknown>;
  const answers = (session?.collectedAnswers ?? {}) as Record<string, unknown>;
  const label = typeof classifier.practiceArea === "string" ? classifier.practiceArea : null;
  const practiceArea = matter.practiceArea ?? practiceAreaForClassifierLabel(label) ?? null;
  const county = typeof answers.county === "string" && answers.county.trim() ? answers.county.trim() : null;
  return {
    practiceArea,
    matterType: label && label !== "unknown" ? label : null,
    language: session?.language ?? "en",
    county,
  };
}

/** Load every attorney with the inputs the scoring needs. */
export async function gatherCandidates(
  tx: TenantTx,
  ctx: IntakeContext,
  matter: MatterRow,
  am: AssignmentMatter,
  now: Date
): Promise<Candidate[]> {
  const tenantId = ctx.tenantId;
  const s = ctx.settings.assignment;
  const lawyers = await tx
    .select({
      id: users.id,
      displayName: users.displayName,
      role: users.role,
      status: users.status,
      restricted: users.restrictedToUnassignedMatters,
    })
    .from(users)
    .where(and(eq(users.tenantId, tenantId), eq(users.role, "attorney")));
  if (lawyers.length === 0) return [];
  const ids = lawyers.map((l) => l.id);

  const profiles = await tx
    .select()
    .from(intakeLawyerProfiles)
    .where(and(eq(intakeLawyerProfiles.tenantId, tenantId), inArray(intakeLawyerProfiles.userId, ids)));

  const windowEnd = addBusinessDays(now, s.outOfOfficeWindowBusinessDays, ctx.calendar);
  const ooo = await tx
    .select({ userId: intakeOutOfOffice.userId })
    .from(intakeOutOfOffice)
    .where(
      and(
        eq(intakeOutOfOffice.tenantId, tenantId),
        inArray(intakeOutOfOffice.userId, ids),
        lte(intakeOutOfOffice.startsAt, windowEnd),
        gte(intakeOutOfOffice.endsAt, now)
      )
    );

  const partyIds = (
    await tx
      .select({ partyId: matterParties.partyId })
      .from(matterParties)
      .where(and(eq(matterParties.tenantId, tenantId), eq(matterParties.matterId, matter.id)))
  ).map((r) => r.partyId);
  const allParties = [...new Set([matter.primaryPartyId, ...partyIds])];
  const blocks = await tx
    .select({ userId: intakeAssignmentBlocks.userId, reason: intakeAssignmentBlocks.reason })
    .from(intakeAssignmentBlocks)
    .where(
      and(
        eq(intakeAssignmentBlocks.tenantId, tenantId),
        isNull(intakeAssignmentBlocks.endedAt),
        or(eq(intakeAssignmentBlocks.matterId, matter.id), inArray(intakeAssignmentBlocks.partyId, allParties))
      )
    );

  const lastAssigned = await tx
    .select({ userId: intakeMatterAssignments.assigneeUserId, at: sql<Date>`max(${intakeMatterAssignments.createdAt})` })
    .from(intakeMatterAssignments)
    .where(and(eq(intakeMatterAssignments.tenantId, tenantId), inArray(intakeMatterAssignments.assigneeUserId, ids)))
    .groupBy(intakeMatterAssignments.assigneeUserId);
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
  const lastWeek = await tx
    .select({ userId: intakeMatterAssignments.assigneeUserId, n: count() })
    .from(intakeMatterAssignments)
    .where(
      and(
        eq(intakeMatterAssignments.tenantId, tenantId),
        inArray(intakeMatterAssignments.assigneeUserId, ids),
        gte(intakeMatterAssignments.createdAt, weekAgo),
        inArray(intakeMatterAssignments.method, ["auto", "override", "manual"])
      )
    )
    .groupBy(intakeMatterAssignments.assigneeUserId);

  const openMatters = await tx
    .select({ userId: matters.assignedUserId, practiceArea: matters.practiceArea, n: count() })
    .from(matters)
    .where(and(eq(matters.tenantId, tenantId), inArray(matters.assignedUserId, ids), notInArray(matters.stage, [...CLOSED_STAGES]), ne(matters.id, matter.id)))
    .groupBy(matters.assignedUserId, matters.practiceArea);

  const taskRows = await tx
    .select({
      userId: tasks.ownerUserId,
      open: count(),
      overdue: sql<number>`count(*) filter (where ${tasks.dueAt} < ${now})`,
    })
    .from(tasks)
    .where(and(eq(tasks.tenantId, tenantId), eq(tasks.status, "open"), inArray(tasks.ownerUserId, ids)))
    .groupBy(tasks.ownerUserId);

  const deadlineEnd = addBusinessDays(now, s.lookaheadBusinessDays, ctx.calendar);
  const deadlines = await tx
    .select({ assigned: calendarEvents.assignedUserIds })
    .from(calendarEvents)
    .where(
      and(
        eq(calendarEvents.tenantId, tenantId),
        eq(calendarEvents.isDeadline, true),
        ne(calendarEvents.status, "cancelled"),
        gte(calendarEvents.startsAt, now),
        lte(calendarEvents.startsAt, deadlineEnd)
      )
    );

  const continuity = await tx
    .select({ userId: matters.assignedUserId })
    .from(matters)
    .where(and(eq(matters.tenantId, tenantId), eq(matters.primaryPartyId, matter.primaryPartyId), ne(matters.id, matter.id)))
    .orderBy(desc(matters.openedAt))
    .limit(1);
  const continuityUserId = continuity[0]?.userId ?? null;

  return lawyers.map((l): Candidate => {
    const profile = profiles.find((p) => p.userId === l.id);
    const block = blocks.find((b) => b.userId === l.id);
    const last = lastAssigned.find((r) => r.userId === l.id)?.at;
    const lastDate = last ? new Date(last) : null;
    const mine = openMatters.filter((r) => r.userId === l.id);
    const t = taskRows.find((r) => r.userId === l.id);
    return {
      userId: l.id,
      displayName: l.displayName,
      role: l.role,
      status: l.status,
      restrictedToUnassignedMatters: l.restricted,
      block: block ? (block.reason as Candidate["block"]) : null,
      hasProfile: Boolean(profile),
      acceptsNewMatters: profile?.acceptsNewMatters ?? false,
      practiceAreas: profile?.practiceAreas ?? [],
      languages: profile?.languages ?? [],
      counties: profile?.counties ?? [],
      seniority: profile?.seniority ?? 1,
      weeklyCap: profile?.weeklyNewMatterCap ?? null,
      outOfOffice: ooo.some((o) => o.userId === l.id),
      businessHoursSinceLastAssignment: lastDate ? Math.max(0, businessHoursBetween(lastDate, now, ctx.calendar)) : null,
      newMattersLast7Days: Number(lastWeek.find((r) => r.userId === l.id)?.n ?? 0),
      weightedOpenMatters: mine.reduce((sum, r) => sum + Number(r.n) * (s.complexityWeights[r.practiceArea ?? ""] ?? 1), 0),
      openMatterCount: mine.reduce((sum, r) => sum + Number(r.n), 0),
      openTasks: Number(t?.open ?? 0),
      overdueTasks: Number(t?.overdue ?? 0),
      upcomingDeadlines: deadlines.filter((d) => d.assigned.includes(l.id)).length,
      isContinuityLawyer: continuityUserId === l.id,
    };
  });
}

export type AssignmentRunResult =
  | { status: "assigned"; assigneeUserId: string; decision: AssignmentDecision }
  | { status: "unassigned"; reason: string; decision: AssignmentDecision }
  | { status: "blocked_conflict"; conflictState: string }
  | { status: "already_assigned"; assigneeUserId: string };

/** Compute the decision without writing anything (used by booking and the fit rules' capacity signal). */
export async function previewAssignment(tx: TenantTx, tenantId: string, matterId: string, now = new Date()): Promise<AssignmentDecision> {
  const ctx = await loadIntakeContext(tx, tenantId);
  const matter = await getMatter(tx, tenantId, matterId);
  const session = await latestSessionForMatter(tx, tenantId, matterId);
  const am = assignmentMatterFrom(matter, session ?? null);
  return decideAssignment(await gatherCandidates(tx, ctx, matter, am, now), am, ctx.settings.assignment);
}

/**
 * Run auto-assignment for a matter (c48). Never before a clear conflict
 * result or an attorney clearing decision; a possible conflict stays with the
 * conflicts attorney. Being assigned does not change the matter stage.
 */
export async function runAutoAssignment(
  tx: TenantTx,
  input: { tenantId: string; matterId: string; trigger: string; now?: Date; force?: boolean }
): Promise<AssignmentRunResult> {
  const now = input.now ?? new Date();
  const ctx = await loadIntakeContext(tx, input.tenantId);
  const matter = await getMatter(tx, input.tenantId, input.matterId);
  const session = await latestSessionForMatter(tx, input.tenantId, matter.id);
  if (matter.assignedUserId && !input.force) return { status: "already_assigned", assigneeUserId: matter.assignedUserId };

  const conflict = await getConflictStatusForMatter(tx, input.tenantId, matter.id, matter.stage);
  if (!isConflictCleared(conflict)) {
    await recordIntakeEvent(tx, {
      tenantId: input.tenantId,
      intakeSessionId: session?.id ?? null,
      matterId: matter.id,
      eventType: "assignment_blocked_conflict",
      ruleName: "assignment.requires_clear_conflict",
      payload: { conflictState: conflict.state, trigger: input.trigger },
    });
    return { status: "blocked_conflict", conflictState: conflict.state };
  }

  const am = assignmentMatterFrom(matter, session ?? null);
  const decision = decideAssignment(await gatherCandidates(tx, ctx, matter, am, now), am, ctx.settings.assignment);
  const version = settingsVersion(ctx.settings.assignment);
  const breakdown = { ...decision, matter: am, trigger: input.trigger } as unknown as Record<string, unknown>;

  await endCurrentAssignment(tx, input.tenantId, matter.id, now);
  if (!decision.winner) {
    await tx.insert(intakeMatterAssignments).values({
      tenantId: input.tenantId,
      matterId: matter.id,
      assigneeUserId: null,
      method: "unassigned",
      scoreBreakdown: breakdown,
      reason: decision.unassignedReason,
      settingsVersion: version,
    });
    const { owners } = await resolveEscalationContacts(tx, input.tenantId, ctx.settings);
    if (owners.length > 0) {
      await raiseFlag(
        tx,
        {
          tenantId: input.tenantId,
          type: "intake.unassigned_queue",
          severity: "warning",
          audience: "internal",
          title: "New matter could not be assigned automatically",
          summary:
            decision.unassignedReason === "all_over_capacity"
              ? "Every eligible lawyer is over capacity. Please assign it manually."
              : "No eligible lawyer was found. Please assign it manually.",
          details: { reason: decision.unassignedReason, excluded: decision.excluded },
          matterId: matter.id,
          recipients: { userIds: owners },
          dedupeKey: `intake.unassigned_queue:${matter.id}`,
          sourceCard: "c48",
          engine: INTAKE_ENGINE,
        },
        { now }
      );
    }
    await recordIntakeEvent(tx, {
      tenantId: input.tenantId,
      intakeSessionId: session?.id ?? null,
      matterId: matter.id,
      eventType: "assignment_unassigned",
      ruleName: `assignment.v${version}`,
      firmConfigVersionId: session?.firmConfigVersionId ?? null,
      payload: { reason: decision.unassignedReason, excludedCount: decision.excluded.length },
    });
    return { status: "unassigned", reason: decision.unassignedReason ?? "no_eligible", decision };
  }

  const winner = decision.winner;
  await tx.insert(intakeMatterAssignments).values({
    tenantId: input.tenantId,
    matterId: matter.id,
    assigneeUserId: winner.userId,
    method: "auto",
    scoreBreakdown: breakdown,
    settingsVersion: version,
  });
  await tx.update(matters).set({ assignedUserId: winner.userId }).where(and(eq(matters.tenantId, input.tenantId), eq(matters.id, matter.id)));
  await notifyStaff(
    tx,
    {
      tenantId: input.tenantId,
      userIds: [winner.userId],
      templateKey: "intake.matter_assigned",
      subject: "New matter assigned to you",
      body: "A new matter has been assigned to you. Open the staff console to see it. (Assignment is not a decision to represent the client.)",
      matterId: matter.id,
      dedupeBase: `intake.assigned:${matter.id}:${now.getTime()}`,
    },
    { now }
  );
  await recordIntakeEvent(tx, {
    tenantId: input.tenantId,
    intakeSessionId: session?.id ?? null,
    matterId: matter.id,
    eventType: "assignment_made",
    ruleName: `assignment.v${version}`,
    firmConfigVersionId: session?.firmConfigVersionId ?? null,
    payload: { assigneeUserId: winner.userId, total: winner.total, trigger: input.trigger },
  });
  return { status: "assigned", assigneeUserId: winner.userId, decision };
}

async function endCurrentAssignment(tx: TenantTx, tenantId: string, matterId: string, at: Date): Promise<(typeof intakeMatterAssignments.$inferSelect) | undefined> {
  const [current] = await tx
    .update(intakeMatterAssignments)
    .set({ endedAt: at })
    .where(and(eq(intakeMatterAssignments.tenantId, tenantId), eq(intakeMatterAssignments.matterId, matterId), isNull(intakeMatterAssignments.endedAt)))
    .returning();
  return current;
}

/**
 * Supervising attorney / admin override (c48 §4 Override). A reason is
 * required; the original breakdown is kept alongside; screened or restricted
 * users can never be chosen.
 */
export async function overrideAssignment(
  tx: TenantTx,
  input: { tenantId: string; matterId: string; byUserId: string; assigneeUserId: string; reason: string; now?: Date }
): Promise<{ assigneeUserId: string; warning: string | null }> {
  const reason = requireReason(input.reason, "Assignment override");
  await requireStaff(tx, input.tenantId, input.byUserId, SUPERVISOR_ROLES, "override an assignment");
  const now = input.now ?? new Date();
  const matter = await getMatter(tx, input.tenantId, input.matterId);
  const decision = await previewAssignment(tx, input.tenantId, input.matterId, now);
  const check = overrideCheck(decision, input.assigneeUserId);
  if (!check.allowed) throw new IntakeRuleError(check.reason ?? "That person cannot be assigned.");

  const previous = await endCurrentAssignment(tx, input.tenantId, matter.id, now);
  await tx.insert(intakeMatterAssignments).values({
    tenantId: input.tenantId,
    matterId: matter.id,
    assigneeUserId: input.assigneeUserId,
    method: "override",
    reason,
    assignedByUserId: input.byUserId,
    scoreBreakdown: {
      original: previous?.scoreBreakdown ?? null,
      originalAssigneeUserId: previous?.assigneeUserId ?? null,
      atOverride: decision as unknown as Record<string, unknown>,
      warning: check.warning,
    },
    settingsVersion: previous?.settingsVersion ?? null,
  });
  await tx.update(matters).set({ assignedUserId: input.assigneeUserId }).where(and(eq(matters.tenantId, input.tenantId), eq(matters.id, matter.id)));
  const notify = [input.assigneeUserId, ...(previous?.assigneeUserId && previous.assigneeUserId !== input.assigneeUserId ? [previous.assigneeUserId] : [])];
  await notifyStaff(
    tx,
    {
      tenantId: input.tenantId,
      userIds: notify,
      templateKey: "intake.assignment_changed",
      subject: "Matter assignment changed",
      body: "The lawyer assigned to a matter was changed by a supervisor. Open the staff console for details.",
      channels: ["in_app"],
      matterId: matter.id,
    },
    { now }
  );
  const session = await latestSessionForMatter(tx, input.tenantId, matter.id);
  await recordIntakeEvent(tx, {
    tenantId: input.tenantId,
    intakeSessionId: session?.id ?? null,
    matterId: matter.id,
    eventType: "assignment_overridden",
    ruleName: "assignment.override",
    actor: userActor(input.byUserId),
    reason,
    payload: { from: previous?.assigneeUserId ?? null, to: input.assigneeUserId, warning: check.warning },
  });
  return { assigneeUserId: input.assigneeUserId, warning: check.warning };
}

/** Internal only: the assignment history with score breakdowns (never for client routes, c48 rule 10). */
export async function getAssignmentHistory(tx: TenantTx, tenantId: string, matterId: string) {
  return tx
    .select()
    .from(intakeMatterAssignments)
    .where(and(eq(intakeMatterAssignments.tenantId, tenantId), eq(intakeMatterAssignments.matterId, matterId)))
    .orderBy(desc(intakeMatterAssignments.createdAt));
}

/** What a client may see: their lawyer's name once assigned, nothing about routing. */
export async function clientLawyerView(tx: TenantTx, tenantId: string, matterId: string): Promise<{ lawyerName: string | null }> {
  const matter = await getMatter(tx, tenantId, matterId);
  if (!matter.assignedUserId) return { lawyerName: null };
  const [u] = await tx
    .select({ name: users.displayName })
    .from(users)
    .where(and(eq(users.tenantId, tenantId), eq(users.id, matter.assignedUserId)))
    .limit(1);
  return { lawyerName: u?.name ?? null };
}

/** Upsert a lawyer's routing profile (admin only). */
export async function upsertLawyerProfile(
  tx: TenantTx,
  input: {
    tenantId: string;
    byUserId: string;
    userId: string;
    practiceAreas: string[];
    languages: string[];
    counties: string[];
    seniority: number;
    weeklyNewMatterCap?: number | null;
    acceptsNewMatters?: boolean;
  }
) {
  await requireStaff(tx, input.tenantId, input.byUserId, ["firm_admin"], "edit lawyer routing profiles");
  const clean = (xs: string[]) => [...new Set(xs.map((x) => x.trim().toLowerCase()).filter(Boolean))];
  const values = {
    practiceAreas: clean(input.practiceAreas),
    languages: clean(input.languages),
    counties: clean(input.counties),
    seniority: Math.min(5, Math.max(1, Math.round(input.seniority))),
    weeklyNewMatterCap: input.weeklyNewMatterCap ?? null,
    acceptsNewMatters: input.acceptsNewMatters ?? true,
    updatedAt: new Date(),
  };
  const [row] = await tx
    .insert(intakeLawyerProfiles)
    .values({ tenantId: input.tenantId, userId: input.userId, ...values })
    .onConflictDoUpdate({ target: [intakeLawyerProfiles.tenantId, intakeLawyerProfiles.userId], set: values })
    .returning();
  await recordIntakeEvent(tx, {
    tenantId: input.tenantId,
    eventType: "lawyer_profile_updated",
    actor: userActor(input.byUserId),
    entityType: "user",
    entityId: input.userId,
    payload: values,
  });
  return row;
}

/** Record an ethical screen / hard block mirrored from c60 (admin or attorney). */
export async function recordAssignmentBlock(
  tx: TenantTx,
  input: { tenantId: string; byUserId: string; userId: string; matterId?: string | null; partyId?: string | null; reason: "screened" | "restricted" | "other"; note?: string }
) {
  await requireStaff(tx, input.tenantId, input.byUserId, SUPERVISOR_ROLES, "record a screen");
  if (!input.matterId && !input.partyId) throw new IntakeRuleError("A screen needs a matter or a party.");
  const [row] = await tx
    .insert(intakeAssignmentBlocks)
    .values({
      tenantId: input.tenantId,
      userId: input.userId,
      matterId: input.matterId ?? null,
      partyId: input.partyId ?? null,
      reason: input.reason,
      note: input.note ?? null,
      createdByUserId: input.byUserId,
    })
    .returning();
  // c48 edge case: a screen against the current assignee returns the matter to the queue with a flag.
  if (input.matterId) {
    const matter = await getMatter(tx, input.tenantId, input.matterId);
    if (matter.assignedUserId === input.userId) {
      await tx.update(matters).set({ assignedUserId: null }).where(and(eq(matters.tenantId, input.tenantId), eq(matters.id, matter.id)));
      await endCurrentAssignment(tx, input.tenantId, matter.id, new Date());
      const ctx = await loadIntakeContext(tx, input.tenantId);
      const { owners } = await resolveEscalationContacts(tx, input.tenantId, ctx.settings);
      if (owners.length > 0) {
        await raiseFlag(tx, {
          tenantId: input.tenantId,
          type: "intake.assignee_screened",
          severity: "high",
          audience: "internal",
          title: "Assigned lawyer was screened from a matter",
          summary: "The matter has returned to the unassigned queue. Please reassign it.",
          matterId: matter.id,
          recipients: { userIds: owners },
          dedupeKey: `intake.assignee_screened:${matter.id}`,
          sourceCard: "c48",
          engine: INTAKE_ENGINE,
        });
      }
    }
  }
  await recordIntakeEvent(tx, {
    tenantId: input.tenantId,
    matterId: input.matterId ?? null,
    eventType: "assignment_block_recorded",
    actor: userActor(input.byUserId) as Actor,
    entityType: "user",
    entityId: input.userId,
    payload: { reason: input.reason, partyId: input.partyId ?? null },
  });
  return row;
}


