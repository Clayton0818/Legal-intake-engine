// Logging for every automated decision and staff action (c6). Session-level
// events go to `intake_events` (the intake session audit log, with the rule
// and firm config version that produced them); every event is ALSO written
// to the shared `audit_events` trail so matter-level views see it.

import { intakeEvents } from "@/db/schema";
import type { TenantTx } from "@/tenancy/withTenant";
import { audit, SYSTEM_ACTOR, type Actor } from "@/core/audit";
import { INTAKE_ENGINE } from "../settings";

export interface IntakeEventInput {
  tenantId: string;
  /** Session events land in intake_events; matter-only events only in audit_events. */
  intakeSessionId?: string | null;
  matterId?: string | null;
  /** snake_case, e.g. 'stage_changed', 'emergency_detected'. */
  eventType: string;
  /** The rule that produced an automated decision, e.g. 'assignment.v3f2a91c0'. */
  ruleName?: string | null;
  actor?: Actor;
  reason?: string | null;
  payload?: Record<string, unknown>;
  firmConfigVersionId?: string | null;
  entityType?: string;
  entityId?: string | null;
  occurredAt?: Date;
}

/** Map a core Actor onto intake_events.actor_type ('system' | 'user' | 'caller'). Pure. */
export function intakeActorType(actor: Actor): { actorType: "system" | "user" | "caller"; actorId: string | null } {
  switch (actor.type) {
    case "user":
      return { actorType: "user", actorId: actor.userId };
    case "client":
      return { actorType: "caller", actorId: actor.partyId };
    default:
      return { actorType: "system", actorId: null };
  }
}

export async function recordIntakeEvent(tx: TenantTx, input: IntakeEventInput): Promise<void> {
  const actor = input.actor ?? SYSTEM_ACTOR;
  const payload: Record<string, unknown> = { ...(input.payload ?? {}) };
  if (actor.type === "ai") payload.aiModel = actor.model ?? "unknown";
  if (input.reason) payload.reason = input.reason;
  if (input.intakeSessionId) {
    const { actorType, actorId } = intakeActorType(actor);
    await tx.insert(intakeEvents).values({
      tenantId: input.tenantId,
      intakeSessionId: input.intakeSessionId,
      matterId: input.matterId ?? null,
      eventType: input.eventType,
      ruleName: input.ruleName ?? null,
      actorType,
      actorId,
      payload,
      firmConfigVersionId: input.firmConfigVersionId ?? null,
      ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
    });
  }
  await audit(tx, {
    tenantId: input.tenantId,
    engine: INTAKE_ENGINE,
    action: `intake.${input.eventType}`,
    entityType: input.entityType ?? (input.intakeSessionId ? "intake_session" : "matter"),
    entityId: input.entityId ?? input.intakeSessionId ?? input.matterId ?? null,
    matterId: input.matterId ?? null,
    intakeSessionId: input.intakeSessionId ?? null,
    actor,
    reason: input.reason ?? null,
    payload: input.ruleName ? { ...payload, ruleName: input.ruleName } : payload,
    occurredAt: input.occurredAt,
  });
}
