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
