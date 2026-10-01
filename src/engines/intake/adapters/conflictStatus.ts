// LOCAL ADAPTER: conflict-check status as the intake engine needs it.
//
// The Conflict-check engine (c3, c58, c59) owns running checks and deciding
// possible conflicts. Engines may not import each other, so intake reads the
// shared `conflict_check_results` table and asks for a check by creating a
// shared `tasks` row (kind 'intake.conflict_check_requested'). The intake
// engine NEVER decides or clears a conflict — it only reads the outcome.
//
// Gap (shared request in the PR): conflict_check_results records that a
// possible conflict was resolved (resolved_by/resolved_at) but not WHICH
// WAY. Until a decision column exists, a resolved 'possible' counts as
// cleared only when the linked matter did not move to 'declined_conflict'.

import { and, desc, eq, gt, inArray } from "drizzle-orm";
import { conflictCheckResults, intakeSessions, matterParties } from "@/db/schema";
import { tasks } from "@/db/tables/foundation";
import type { TenantTx } from "@/tenancy/withTenant";
import { createTask } from "@/core/tasks";
import { INTAKE_ENGINE } from "../settings";

export type ConflictState =
  /** No check has run yet. */
  | "none"
  | "clear"
  /** A lawyer resolved a possible conflict and the matter was not declined. */
  | "attorney_cleared"
  /** Possible conflict, no decision yet: goes to the conflicts attorney, never into routing. */
  | "possible_pending"
  /** Possible conflict decided against proceeding, or a definite conflict. */
  | "declined"
  | "definite";

export interface ConflictStatus {
  state: ConflictState;
  resultId: string | null;
  checkedAt: Date | null;
}

export interface ConflictResultLike {
  id: string;
  outcome: "clear" | "possible" | "definite";
  resolvedAt: Date | null;
  resolvedByUserId: string | null;
  createdAt: Date;
}

/** Pure: derive the intake view of the latest conflict result. */
export function deriveConflictStatus(latest: ConflictResultLike | null | undefined, matterStage?: string | null): ConflictStatus {
  if (!latest) return { state: "none", resultId: null, checkedAt: null };
  const base = { resultId: latest.id, checkedAt: latest.createdAt };
  if (matterStage === "declined_conflict") return { state: "declined", ...base };
  if (latest.outcome === "clear") return { state: "clear", ...base };
  if (latest.outcome === "definite") return { state: "definite", ...base };
  if (latest.resolvedAt && latest.resolvedByUserId) return { state: "attorney_cleared", ...base };
  return { state: "possible_pending", ...base };
}

/** Pure: may intake proceed past the conflict step (assignment, booking, opening)? */
export function isConflictCleared(status: Pick<ConflictStatus, "state">): boolean {
  return status.state === "clear" || status.state === "attorney_cleared";
}

async function latestResult(tx: TenantTx, tenantId: string, sessionIds: string[]): Promise<ConflictResultLike | undefined> {
  if (sessionIds.length === 0) return undefined;
  const [row] = await tx
    .select({
      id: conflictCheckResults.id,
      outcome: conflictCheckResults.outcome,
      resolvedAt: conflictCheckResults.resolvedAt,
      resolvedByUserId: conflictCheckResults.resolvedByUserId,
      createdAt: conflictCheckResults.createdAt,
    })
    .from(conflictCheckResults)
    .where(and(eq(conflictCheckResults.tenantId, tenantId), inArray(conflictCheckResults.intakeSessionId, sessionIds)))
    .orderBy(desc(conflictCheckResults.createdAt))
    .limit(1);
  return row;
}

export async function getConflictStatusForSession(
  tx: TenantTx,
  tenantId: string,
  sessionId: string,
  matterStage?: string | null
): Promise<ConflictStatus> {
  return deriveConflictStatus(await latestResult(tx, tenantId, [sessionId]), matterStage);
}

export async function getConflictStatusForMatter(
  tx: TenantTx,
  tenantId: string,
  matterId: string,
  matterStage?: string | null
): Promise<ConflictStatus> {
  const sessions = await tx
    .select({ id: intakeSessions.id })
    .from(intakeSessions)
    .where(and(eq(intakeSessions.tenantId, tenantId), eq(intakeSessions.matterId, matterId)));
  return deriveConflictStatus(await latestResult(tx, tenantId, sessions.map((s) => s.id)), matterStage);
}

/** True when a party was added to the matter after the last conflict result (c68 rule 4, c67). */
export async function partiesChangedSince(tx: TenantTx, tenantId: string, matterId: string, since: Date | null): Promise<boolean> {
  if (!since) return true;
  const [row] = await tx
    .select({ id: matterParties.id })
    .from(matterParties)
    .where(and(eq(matterParties.tenantId, tenantId), eq(matterParties.matterId, matterId), gt(matterParties.addedAt, since)))
    .limit(1);
  return Boolean(row);
}

/**
 * Ask for a (re-)check. Creates a firm task the conflict-check engine (or a
 * staff member) picks up; idempotent per session while the request is open.
 */
export async function requestConflictCheck(
  tx: TenantTx,
  input: { tenantId: string; intakeSessionId: string; matterId?: string | null; reason: string; now?: Date }
): Promise<void> {
  const now = input.now ?? new Date();
  const [open] = await tx
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.tenantId, input.tenantId),
        eq(tasks.kind, "intake.conflict_check_requested"),
        eq(tasks.intakeSessionId, input.intakeSessionId),
        eq(tasks.status, "open")
      )
    )
    .limit(1);
  if (open) return;
  await createTask(
    tx,
    {
      tenantId: input.tenantId,
      kind: "intake.conflict_check_requested",
      title: "Run conflict check for new inquiry",
      description: input.reason,
      owner: { type: "firm" },
      // Real clock: the check gates everything after it; the conflict engine owns its own SLA.
      due: { hours: 1, clock: "real" },
      intakeSessionId: input.intakeSessionId,
      matterId: input.matterId ?? null,
      sourceCard: "c65",
      sourceRef: `intake_session:${input.intakeSessionId}`,
      engine: INTAKE_ENGINE,
    },
    { now }
  );
}
