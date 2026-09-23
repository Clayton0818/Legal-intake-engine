// Query helpers for the admin/staff console (board card c24).
//
// Every function here takes an already-opened `TenantTx` (the handle
// `withTenant()` hands back) plus the same `tenantId` used to open it, and
// applies an explicit `tenantId` filter on top of RLS — defense in depth,
// per ADR-0001 §D5. Callers (Server Components and the API routes under
// src/app/api/admin/) are responsible for opening that transaction; nothing
// here imports `rawDb` or any other database handle directly.

import { and, desc, eq } from "drizzle-orm";
import {
  matters,
  parties,
  users,
  intakeSessions,
  conflictCheckResults,
  matterStageEnum,
} from "@/db/schema";
import type { TenantTx } from "@/tenancy/withTenant";

export const MATTER_STAGE_VALUES = matterStageEnum.enumValues;
export type MatterStage = (typeof MATTER_STAGE_VALUES)[number];

export function isMatterStage(value: unknown): value is MatterStage {
  return (
    typeof value === "string" &&
    (MATTER_STAGE_VALUES as readonly string[]).includes(value)
  );
}

export interface MatterQueueRow {
  id: string;
  practiceArea: string | null;
  stage: MatterStage;
  openedAt: Date;
  partyName: string | null;
  assignedUserName: string | null;
}

export async function listMattersForTenant(
  tx: TenantTx,
  tenantId: string
): Promise<MatterQueueRow[]> {
  return tx
    .select({
      id: matters.id,
      practiceArea: matters.practiceArea,
      stage: matters.stage,
      openedAt: matters.openedAt,
      partyName: parties.fullName,
      assignedUserName: users.displayName,
    })
    .from(matters)
    .leftJoin(parties, eq(matters.primaryPartyId, parties.id))
    .leftJoin(users, eq(matters.assignedUserId, users.id))
    .where(eq(matters.tenantId, tenantId))
    .orderBy(desc(matters.openedAt));
}

export interface MatterDetail {
  matter: typeof matters.$inferSelect;
  party: typeof parties.$inferSelect | null;
  assignedUser: typeof users.$inferSelect | null;
  intakeSession: typeof intakeSessions.$inferSelect | null;
  conflictResults: (typeof conflictCheckResults.$inferSelect)[];
}

export async function getMatterDetail(
  tx: TenantTx,
  tenantId: string,
  matterId: string
): Promise<MatterDetail | null> {
  const [matter] = await tx
    .select()
    .from(matters)
    .where(and(eq(matters.tenantId, tenantId), eq(matters.id, matterId)))
    .limit(1);

  if (!matter) {
    return null;
  }

  const [party] = await tx
    .select()
    .from(parties)
    .where(and(eq(parties.tenantId, tenantId), eq(parties.id, matter.primaryPartyId)))
    .limit(1);

  let assignedUser: typeof users.$inferSelect | null = null;
  if (matter.assignedUserId) {
    const [row] = await tx
      .select()
      .from(users)
      .where(and(eq(users.tenantId, tenantId), eq(users.id, matter.assignedUserId)))
      .limit(1);
    assignedUser = row ?? null;
  }

  // A matter can outlive several intake sessions in principle (re-intake
  // after a prior one didn't convert); the most recently started one is
  // the relevant one to show here.
  const [intakeSession] = await tx
    .select()
    .from(intakeSessions)
    .where(and(eq(intakeSessions.tenantId, tenantId), eq(intakeSessions.matterId, matterId)))
    .orderBy(desc(intakeSessions.startedAt))
    .limit(1);

  let conflictResults: (typeof conflictCheckResults.$inferSelect)[] = [];
  if (intakeSession) {
    conflictResults = await tx
      .select()
      .from(conflictCheckResults)
      .where(
        and(
          eq(conflictCheckResults.tenantId, tenantId),
          eq(conflictCheckResults.intakeSessionId, intakeSession.id)
        )
      )
      .orderBy(desc(conflictCheckResults.createdAt));
  }

  return {
    matter,
    party: party ?? null,
    assignedUser,
    intakeSession: intakeSession ?? null,
    conflictResults,
  };
}

export async function updateMatterStage(
  tx: TenantTx,
  tenantId: string,
  matterId: string,
  stage: MatterStage
): Promise<typeof matters.$inferSelect | null> {
  const [updated] = await tx
    .update(matters)
    .set({ stage })
    .where(and(eq(matters.tenantId, tenantId), eq(matters.id, matterId)))
    .returning();
  return updated ?? null;
}

export const CONFLICT_OUTCOME_VALUES = ["clear", "possible", "definite"] as const;
export type ConflictOutcome = (typeof CONFLICT_OUTCOME_VALUES)[number];

export interface InsightsData {
  totalMatters: number;
  byStage: { stage: MatterStage; count: number }[];
  byPracticeArea: { practiceArea: string; count: number }[];
  byConflictOutcome: { outcome: ConflictOutcome; count: number }[];
  unassignedCount: number;
  retainedCount: number;
  retainedRate: number;
  declinedConflictCount: number;
}

// Board card c33 — the firm-facing "so what" this console has been missing:
// every number here already exists in matters/conflict_check_results (the
// c19 data model and the c6 audit trail were built for exactly this), it
// just had no view. Aggregation happens in application code rather than a
// SQL GROUP BY: dataset sizes here (a firm's own matters) are small enough
// that this is simpler to read and to keep tenant-scoped than hand-rolling
// grouped queries per stat, and it keeps every stat derived from the same
// single fetch, so the numbers can never drift from each other.
export async function getInsightsForTenant(
  tx: TenantTx,
  tenantId: string
): Promise<InsightsData> {
  const matterRows = await tx
    .select({
      stage: matters.stage,
      practiceArea: matters.practiceArea,
      assignedUserId: matters.assignedUserId,
    })
    .from(matters)
    .where(eq(matters.tenantId, tenantId));

  const conflictRows = await tx
    .select({ outcome: conflictCheckResults.outcome })
    .from(conflictCheckResults)
    .where(eq(conflictCheckResults.tenantId, tenantId));

  const stageCounts = new Map<string, number>();
  const practiceAreaCounts = new Map<string, number>();
  let unassignedCount = 0;

  for (const m of matterRows) {
    stageCounts.set(m.stage, (stageCounts.get(m.stage) ?? 0) + 1);
    const practiceArea = m.practiceArea ?? "unspecified";
    practiceAreaCounts.set(practiceArea, (practiceAreaCounts.get(practiceArea) ?? 0) + 1);
    if (!m.assignedUserId) unassignedCount += 1;
  }

  const conflictCounts = new Map<string, number>();
  for (const c of conflictRows) {
    conflictCounts.set(c.outcome, (conflictCounts.get(c.outcome) ?? 0) + 1);
  }

  const totalMatters = matterRows.length;
  const retainedCount = stageCounts.get("retained") ?? 0;
  const declinedConflictCount = stageCounts.get("declined_conflict") ?? 0;

  return {
    totalMatters,
    // Every stage is included even at zero, so the breakdown's shape is
    // stable across firms/tenants rather than only listing whatever
    // happens to have a row today.
    byStage: MATTER_STAGE_VALUES.map((stage) => ({
      stage,
      count: stageCounts.get(stage) ?? 0,
    })),
    byPracticeArea: Array.from(practiceAreaCounts.entries())
      .map(([practiceArea, count]) => ({ practiceArea, count }))
      .sort((a, b) => b.count - a.count),
    byConflictOutcome: CONFLICT_OUTCOME_VALUES.map((outcome) => ({
      outcome,
      count: conflictCounts.get(outcome) ?? 0,
    })),
    unassignedCount,
    retainedCount,
    retainedRate: totalMatters === 0 ? 0 : retainedCount / totalMatters,
    declinedConflictCount,
  };
}
