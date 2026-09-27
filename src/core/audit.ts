// One-line audit logging for every engine (c6).
//
//   await audit(tx, { tenantId, engine: "conflict-check", action: "check.run", matterId, payload: { outcome } });
//
// Writes to `audit_events` (append-only: the app role gets INSERT/SELECT
// only). Intake-session state transitions keep using `intake_events`
// (schema.ts), which requires an intake session id; everything else — matter
// work, tasks, flags, approvals — lands here.

import { and, desc, eq } from "drizzle-orm";
import { auditEvents } from "@/db/tables/foundation";
import type { ActorType } from "@/db/types";
import type { TenantTx } from "@/tenancy/withTenant";
import type { PendingApprovalError } from "@/compliance/approvals";

export type Actor =
  | { type: "system" }
  | { type: "user"; userId: string }
  | { type: "client"; partyId: string }
  | { type: "ai"; model?: string };

export const SYSTEM_ACTOR: Actor = Object.freeze({ type: "system" });

export interface AuditInput {
  tenantId: string;
  /** Engine slug ('intake', 'conflict-check', 'document', 'calendar-alerts', 'calendar-core', 'billing-trust', 'all-engines') or 'core'. */
  engine: string;
  /** Dotted action, e.g. 'task.completed'. */
  action: string;
  entityType?: string;
  entityId?: string | null;
  matterId?: string | null;
  intakeSessionId?: string | null;
  actor?: Actor;
  reason?: string | null;
  payload?: Record<string, unknown>;
  occurredAt?: Date;
}

export type AuditRow = typeof auditEvents.$inferSelect;
export type AuditInsert = typeof auditEvents.$inferInsert;

/** Pure: validate and shape an audit row. */
export function buildAuditRow(input: AuditInput): AuditInsert {
  if (!input.tenantId) throw new Error("audit: tenantId is required.");
  if (!input.engine?.trim()) throw new Error("audit: engine is required.");
  if (!/^[a-z0-9_-]+(\.[a-z0-9_-]+)*$/.test(input.action)) {
    throw new Error(`audit: action '${input.action}' must be lowercase dotted words, e.g. 'task.completed'.`);
  }
  const actor = input.actor ?? SYSTEM_ACTOR;
  const payload: Record<string, unknown> = { ...(input.payload ?? {}) };
  if (actor.type === "ai" && actor.model) payload.aiModel = actor.model;
  return {
    tenantId: input.tenantId,
    engine: input.engine,
    action: input.action,
    entityType: input.entityType ?? null,
    entityId: input.entityId ?? null,
    matterId: input.matterId ?? null,
    intakeSessionId: input.intakeSessionId ?? null,
    actorType: actor.type satisfies ActorType,
    actorUserId: actor.type === "user" ? actor.userId : null,
    actorPartyId: actor.type === "client" ? actor.partyId : null,
    reason: input.reason ?? null,
    payload,
    ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
  };
}

/** Append one audit event. */
export async function audit(tx: TenantTx, input: AuditInput): Promise<void> {
  await tx.insert(auditEvents).values(buildAuditRow(input));
}

/** Record that a gated action was blocked by a pending approval (fail-safe trail). */
export async function auditBlocked(
  tx: TenantTx,
  err: PendingApprovalError,
  ctx: Omit<AuditInput, "action" | "payload"> & { payload?: Record<string, unknown> }
): Promise<void> {
  await audit(tx, {
    ...ctx,
    action: "approval.blocked",
    payload: {
      ...(ctx.payload ?? {}),
      gateKey: err.gateKey,
      pendingReviewers: err.pendingReviewers,
      attemptedAction: err.action,
    },
  });
}

/** A matter's (or entity's) audit trail, newest first. */
export async function listAuditTrail(
  tx: TenantTx,
  tenantId: string,
  filter: { matterId?: string; entityType?: string; entityId?: string; limit?: number } = {}
): Promise<AuditRow[]> {
  const conds = [eq(auditEvents.tenantId, tenantId)];
  if (filter.matterId) conds.push(eq(auditEvents.matterId, filter.matterId));
  if (filter.entityType) conds.push(eq(auditEvents.entityType, filter.entityType));
  if (filter.entityId) conds.push(eq(auditEvents.entityId, filter.entityId));
  return tx
    .select()
    .from(auditEvents)
    .where(and(...conds))
    .orderBy(desc(auditEvents.occurredAt))
    .limit(filter.limit ?? 200);
}
