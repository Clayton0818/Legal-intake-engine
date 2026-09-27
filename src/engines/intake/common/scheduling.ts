// Timers use the shared `scheduled_tasks` table (ADR-0001 D6). The worker
// dispatches each due row to the handler registered for its task_type in
// ../worker.ts. Handlers are idempotent: they re-read state and do nothing
// when the thing they were waiting for already happened.

import { and, eq, isNull, sql } from "drizzle-orm";
import { scheduledTasks } from "@/db/schema";
import type { TenantTx } from "@/tenancy/withTenant";

export const INTAKE_TASK_TYPES = {
  emergencyEscalation: "intake.emergency_escalation",
  speedToLeadCheck: "intake.speed_to_lead_check",
  consultReminder: "intake.consult_reminder",
  consultNoShowPrompt: "intake.consult_no_show_prompt",
  consultRebookCheck: "intake.consult_rebook_check",
  processHandoffs: "intake.process_handoffs",
  followUpStep: "intake.follow_up_step",
} as const;

export type IntakeTaskType = (typeof INTAKE_TASK_TYPES)[keyof typeof INTAKE_TASK_TYPES];

export async function scheduleTask(
  tx: TenantTx,
  input: {
    tenantId: string;
    taskType: IntakeTaskType;
    dueAt: Date;
    intakeSessionId?: string | null;
    matterId?: string | null;
    payload?: Record<string, unknown>;
  }
): Promise<string> {
  const [row] = await tx
    .insert(scheduledTasks)
    .values({
      tenantId: input.tenantId,
      taskType: input.taskType,
      dueAt: input.dueAt,
      intakeSessionId: input.intakeSessionId ?? null,
      matterId: input.matterId ?? null,
      payload: input.payload ?? {},
    })
    .returning({ id: scheduledTasks.id });
  if (!row) throw new Error("scheduleTask: insert failed.");
  return row.id;
}

/**
 * Cancel not-yet-run timers of a type, optionally only those whose payload
 * has `payloadKey = payloadValue` (e.g. every escalation for one alert).
 */
export async function cancelScheduledTasks(
  tx: TenantTx,
  input: {
    tenantId: string;
    taskType: IntakeTaskType;
    intakeSessionId?: string;
    matterId?: string;
    payloadKey?: string;
    payloadValue?: string;
    at?: Date;
  }
): Promise<number> {
  const conds = [
    eq(scheduledTasks.tenantId, input.tenantId),
    eq(scheduledTasks.taskType, input.taskType),
    isNull(scheduledTasks.claimedAt),
    isNull(scheduledTasks.cancelledAt),
    isNull(scheduledTasks.completedAt),
  ];
  if (input.intakeSessionId) conds.push(eq(scheduledTasks.intakeSessionId, input.intakeSessionId));
  if (input.matterId) conds.push(eq(scheduledTasks.matterId, input.matterId));
  if (input.payloadKey && input.payloadValue !== undefined) {
    conds.push(sql`${scheduledTasks.payload} ->> ${input.payloadKey} = ${input.payloadValue}`);
  }
  const rows = await tx
    .update(scheduledTasks)
    .set({ cancelledAt: input.at ?? new Date() })
    .where(and(...conds))
    .returning({ id: scheduledTasks.id });
  return rows.length;
}

/** Read a string field from a scheduled task payload. Pure. */
export function payloadString(payload: unknown, key: string): string | null {
  if (!payload || typeof payload !== "object") return null;
  const v = (payload as Record<string, unknown>)[key];
  return typeof v === "string" ? v : null;
}

/** Read a number field from a scheduled task payload. Pure. */
export function payloadNumber(payload: unknown, key: string): number | null {
  if (!payload || typeof payload !== "object") return null;
  const v = (payload as Record<string, unknown>)[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
