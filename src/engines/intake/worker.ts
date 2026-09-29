// Intake engine worker module (discovered automatically by src/worker/hooks.ts).
//
// Timers live in scheduled_tasks (ADR-0001 D6):
//   intake.emergency_escalation   real clock  (c66)
//   intake.speed_to_lead_check    business    (c69; due-soon / overdue / escalate)
//   intake.consult_reminder       real clock  (c67)
//   intake.consult_no_show_prompt real clock  (c67)
//   intake.consult_rebook_check   business    (c67)
//   intake.process_handoffs       real clock  (c68 retries)
//   intake.follow_up_step         business    (c70)
// Tick hooks do periodic per-firm scans. Every handler is idempotent.

import type { EngineWorkerModule, ScheduledTaskHandler } from "@/worker/hooks";
import { INTAKE_TASK_TYPES } from "./common/scheduling";
import { handleEmergencyEscalation, scanRotaGaps } from "./emergency/service";
import { handleSpeedToLeadCheck } from "./speedToLead/service";
import { expireSlotHolds, handleConsultNoShowPrompt, handleConsultRebookCheck, handleConsultReminder } from "./booking/service";
import { handleProcessHandoffs } from "./opening/service";
import { handleFollowUpStep, scanFollowUpTriggers } from "./followUp/service";

const handler =
  (fn: (tx: Parameters<ScheduledTaskHandler>[0]["tx"], tenantId: string, task: Parameters<ScheduledTaskHandler>[0]["task"], now: Date) => Promise<void>): ScheduledTaskHandler =>
  ({ tx, tenantId, task, now }) =>
    fn(tx, tenantId, task, now);

export const INTAKE_SCHEDULED_HANDLERS: Record<string, ScheduledTaskHandler> = {
  [INTAKE_TASK_TYPES.emergencyEscalation]: handler(handleEmergencyEscalation),
  [INTAKE_TASK_TYPES.speedToLeadCheck]: handler(handleSpeedToLeadCheck),
  [INTAKE_TASK_TYPES.consultReminder]: handler(handleConsultReminder),
  [INTAKE_TASK_TYPES.consultNoShowPrompt]: handler(handleConsultNoShowPrompt),
  [INTAKE_TASK_TYPES.consultRebookCheck]: handler(handleConsultRebookCheck),
  [INTAKE_TASK_TYPES.processHandoffs]: handler(handleProcessHandoffs),
  [INTAKE_TASK_TYPES.followUpStep]: handler(handleFollowUpStep),
};

export const worker: EngineWorkerModule = {
  tickHooks: [
    { name: "intake.expire_slot_holds", engine: "intake", run: async ({ tx, tenantId, now }) => expireSlotHolds(tx, tenantId, now) },
    { name: "intake.rota_gap_scan", engine: "intake", run: async ({ tx, tenantId, now }) => scanRotaGaps(tx, tenantId, now) },
    { name: "intake.follow_up_scan", engine: "intake", run: async ({ tx, tenantId, now }) => scanFollowUpTriggers(tx, tenantId, now) },
  ],
  scheduledTaskHandlers: INTAKE_SCHEDULED_HANDLERS,
};
