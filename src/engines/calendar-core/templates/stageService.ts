// c95 — matter stages and closing per practice area (database).

import { and, count, desc, eq, gt, inArray, max, ne } from "drizzle-orm";
import { matters } from "@/db/schema";
import { calendarEvents, tasks } from "@/db/tables/foundation";
import {
  limitationDates,
  matterClosings,
  matterLifecycle,
  matterStageDefinitions,
  matterStageTransitions,
} from "@/db/tables/calendar-core";
import type { TenantTx } from "@/tenancy/withTenant";
import { audit, createTask, getTask, isPracticeAreaId, practiceAreaForClassifierLabel, SYSTEM_ACTOR, type PracticeAreaId } from "@/core";
import { actorOf, requireLawyer, requireTemplateManager, requireWriter, type Staff } from "../actors";
import { conflict, invalid, notFound } from "../errors";
import { getMatter } from "../matters";
import { ENGINE } from "../settings";
import { FAMILY_LAW_DRAFT_STAGES } from "./familyLawDrafts";
import { checkTransition, closingBlockers, firstStage, validateStageDefinition, type StageDef } from "./stages";
import { startRun } from "./taskListService";
import { OPEN_LIMITATION_STATUSES } from "../limitations/rules";

export const STAGE_CLIENT_UPDATE_KIND = "calendar-core.stage_client_update";
export const CLOSING_CHECKLIST_KIND = "calendar-core.closing_checklist";

type DefinitionRow = typeof matterStageDefinitions.$inferSelect;
type LifecycleRow = typeof matterLifecycle.$inferSelect;

export async function listDefinitions(tx: TenantTx, tenantId: string, practiceArea?: string) {
  const conds = [eq(matterStageDefinitions.tenantId, tenantId)];
  if (practiceArea) conds.push(eq(matterStageDefinitions.practiceArea, practiceArea));
  return tx.select().from(matterStageDefinitions).where(and(...conds)).orderBy(matterStageDefinitions.practiceArea, desc(matterStageDefinitions.version));
}

export async function saveDefinitionDraft(
  tx: TenantTx,
  input: { tenantId: string; staff: Staff | null; practiceArea: string; name: string; stages: StageDef[]; systemDraft?: boolean }
): Promise<DefinitionRow> {
  if (input.staff) requireTemplateManager(input.staff);
  if (!isPracticeAreaId(input.practiceArea)) throw invalid(`Unknown practice area '${input.practiceArea}'.`);
  if (!input.name?.trim()) throw invalid("The lifecycle needs a name.");
  const errors = validateStageDefinition(input.stages);
  if (errors.length > 0) throw invalid("The stages are not valid.", errors);
  const [latest] = await tx
    .select({ v: max(matterStageDefinitions.version) })
    .from(matterStageDefinitions)
    .where(and(eq(matterStageDefinitions.tenantId, input.tenantId), eq(matterStageDefinitions.practiceArea, input.practiceArea)));
  const [row] = await tx
    .insert(matterStageDefinitions)
    .values({
      tenantId: input.tenantId,
      practiceArea: input.practiceArea,
      version: (latest?.v ?? 0) + 1,
      name: input.name.trim(),
      stages: input.stages,
      status: "draft",
      systemDraft: input.systemDraft ?? false,
      createdByUserId: input.staff?.userId ?? null,
    })
    .returning();
  if (!row) throw new Error("saveDefinitionDraft: insert failed.");
  await audit(tx, {
    tenantId: input.tenantId,
    engine: ENGINE,
    action: "stages.draft_saved",
    entityType: "matter_stage_definition",
    entityId: row.id,
    actor: input.staff ? actorOf(input.staff) : SYSTEM_ACTOR,
    payload: { practiceArea: row.practiceArea, version: row.version },
  });
  return row;
}

export async function activateDefinition(tx: TenantTx, input: { tenantId: string; staff: Staff; definitionId: string; now?: Date }) {
  requireTemplateManager(input.staff);
  const now = input.now ?? new Date();
  const [row] = await tx.select().from(matterStageDefinitions).where(and(eq(matterStageDefinitions.tenantId, input.tenantId), eq(matterStageDefinitions.id, input.definitionId))).limit(1);
  if (!row) throw notFound("Stage definition");
  if (row.status !== "draft") throw conflict(`This version is ${row.status}; only a draft can be activated.`);
  await tx
    .update(matterStageDefinitions)
    .set({ status: "retired" })
    .where(and(eq(matterStageDefinitions.tenantId, input.tenantId), eq(matterStageDefinitions.practiceArea, row.practiceArea), eq(matterStageDefinitions.status, "active")));
  const [active] = await tx
    .update(matterStageDefinitions)
    .set({ status: "active", activatedByUserId: input.staff.userId, activatedAt: now })
    .where(eq(matterStageDefinitions.id, row.id))
    .returning();
  await audit(tx, {
    tenantId: input.tenantId,
    engine: ENGINE,
    action: "stages.activated",
    entityType: "matter_stage_definition",
    entityId: row.id,
    actor: actorOf(input.staff),
    payload: { practiceArea: row.practiceArea, version: row.version, wasSystemDraft: row.systemDraft },
  });
  return active;
}

/** Seed the DRAFT Family Law lifecycle (idempotent). Matters already on a lifecycle keep their definition. */
export async function seedFamilyLawStageDraft(tx: TenantTx, tenantId: string, staff: Staff | null): Promise<boolean> {
  const existing = await listDefinitions(tx, tenantId, "family");
  if (existing.length > 0) return false;
  await saveDefinitionDraft(tx, { tenantId, staff, practiceArea: "family", name: "Family law (DRAFT default)", stages: FAMILY_LAW_DRAFT_STAGES, systemDraft: true });
  return true;
}

export async function getLifecycle(tx: TenantTx, tenantId: string, matterId: string) {
  const [lifecycle] = await tx.select().from(matterLifecycle).where(and(eq(matterLifecycle.tenantId, tenantId), eq(matterLifecycle.matterId, matterId))).limit(1);
  if (!lifecycle) return null;
  const [definition] = await tx.select().from(matterStageDefinitions).where(eq(matterStageDefinitions.id, lifecycle.definitionId)).limit(1);
  const history = await tx
    .select()
    .from(matterStageTransitions)
    .where(and(eq(matterStageTransitions.tenantId, tenantId), eq(matterStageTransitions.matterId, matterId)))
    .orderBy(desc(matterStageTransitions.at));
  const [closing] = await tx
    .select()
    .from(matterClosings)
    .where(and(eq(matterClosings.tenantId, tenantId), eq(matterClosings.matterId, matterId)))
    .orderBy(desc(matterClosings.startedAt))
    .limit(1);
  return { lifecycle, definition: definition ?? null, history, closing: closing ?? null };
}

async function activeDefinition(tx: TenantTx, tenantId: string, practiceArea: string): Promise<DefinitionRow> {
  const [def] = await tx
    .select()
    .from(matterStageDefinitions)
    .where(and(eq(matterStageDefinitions.tenantId, tenantId), eq(matterStageDefinitions.practiceArea, practiceArea), eq(matterStageDefinitions.status, "active")))
    .limit(1);
  if (!def) throw conflict(`No active stage lifecycle for '${practiceArea}'. Review and activate one first.`);
  return def;
}

async function runOnEnter(
  tx: TenantTx,
  tenantId: string,
  matter: typeof matters.$inferSelect,
  stage: StageDef,
  transitionId: string,
  staff: Staff | null,
  now: Date
): Promise<{ runs: number; warnings: string[] }> {
  const warnings: string[] = [];
  let runs = 0;
  for (const key of stage.onEnter.taskLists) {
    try {
      const run = await startRun(tx, { tenantId, matterId: matter.id, templateKey: key, staff: null, stageTransitionId: transitionId, now });
      if (run) runs++;
    } catch (err) {
      // A missing/inactive template must not block the stage change; it is reported.
      warnings.push(`Task list '${key}' was not run: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (stage.onEnter.clientUpdateTask) {
    await createTask(
      tx,
      {
        tenantId,
        kind: STAGE_CLIENT_UPDATE_KIND,
        title: `Send the client an update: matter is now '${stage.label}'`,
        description: "Write the update through client updates (c54). AI drafts need lawyer approval; never state legal consequences.",
        owner: matter.assignedUserId ? { type: "user", userId: matter.assignedUserId } : { type: "firm" },
        due: { hours: 8, clock: "business", from: now },
        matterId: matter.id,
        sourceCard: "c95",
        sourceRef: `stage_transition:${transitionId}`,
        createdBy: staff ? actorOf(staff) : SYSTEM_ACTOR,
        engine: ENGINE,
      },
      { now }
    );
  }
  if (stage.onEnter.billingEvent) {
    await audit(tx, {
      tenantId,
      engine: ENGINE,
      action: "stage.billing_event",
      entityType: "matter",
      entityId: matter.id,
      matterId: matter.id,
      actor: staff ? actorOf(staff) : SYSTEM_ACTOR,
      payload: { billingEvent: stage.onEnter.billingEvent, stageKey: stage.key, transitionId },
    });
  }
  return { runs, warnings };
}

/** Put a matter on its practice area's active lifecycle, at the first stage. */
export async function startLifecycle(tx: TenantTx, input: { tenantId: string; staff: Staff; matterId: string; practiceArea?: PracticeAreaId; now?: Date }) {
  requireWriter(input.staff);
  const now = input.now ?? new Date();
  const matter = await getMatter(tx, input.tenantId, input.matterId);
  const area = input.practiceArea ?? practiceAreaForClassifierLabel(matter.practiceArea);
  if (!area) throw invalid("The matter has no known practice area; choose one.");
  const [existing] = await tx.select({ id: matterLifecycle.id }).from(matterLifecycle).where(and(eq(matterLifecycle.tenantId, input.tenantId), eq(matterLifecycle.matterId, matter.id))).limit(1);
  if (existing) throw conflict("This matter already has a lifecycle.");
  const def = await activeDefinition(tx, input.tenantId, area);
  const first = firstStage(def.stages);
  await tx.insert(matterLifecycle).values({ tenantId: input.tenantId, matterId: matter.id, practiceArea: area, definitionId: def.id, stageKey: first.key, enteredStageAt: now });
  const [transition] = await tx
    .insert(matterStageTransitions)
    .values({ tenantId: input.tenantId, matterId: matter.id, definitionId: def.id, fromStageKey: null, toStageKey: first.key, billingEvent: first.onEnter.billingEvent, byUserId: input.staff.userId, at: now })
    .returning();
  await audit(tx, { tenantId: input.tenantId, engine: ENGINE, action: "stage.lifecycle_started", entityType: "matter", entityId: matter.id, matterId: matter.id, actor: actorOf(input.staff), payload: { practiceArea: area, stage: first.key } });
  const effects = await runOnEnter(tx, input.tenantId, matter, first, transition!.id, input.staff, now);
  return { stageKey: first.key, ...effects };
}

/** Move a matter to another (non-closing) stage. Backwards moves need a reason. */
export async function moveStage(tx: TenantTx, input: { tenantId: string; staff: Staff; matterId: string; toStageKey: string; reason?: string | null; now?: Date }) {
  requireWriter(input.staff);
  const now = input.now ?? new Date();
  const matter = await getMatter(tx, input.tenantId, input.matterId);
  const state = await getLifecycle(tx, input.tenantId, matter.id);
  if (!state?.definition) throw conflict("Start the matter's lifecycle first.");
  const lc: LifecycleRow = state.lifecycle;
  const check = checkTransition(state.definition.stages, lc.stageKey, input.toStageKey, lc.status as "open" | "closing" | "closed", input.reason ?? null);
  if (!check.ok) throw conflict(check.reason);
  if (lc.status === "closing") throw conflict("The matter is being closed; abandon the closing first to move it.");
  await tx.update(matterLifecycle).set({ stageKey: check.to.key, enteredStageAt: now, updatedAt: now }).where(eq(matterLifecycle.id, lc.id));
  const [transition] = await tx
    .insert(matterStageTransitions)
    .values({
      tenantId: input.tenantId,
      matterId: matter.id,
      definitionId: lc.definitionId,
      fromStageKey: lc.stageKey,
      toStageKey: check.to.key,
      reason: input.reason?.trim() || null,
      billingEvent: check.to.onEnter.billingEvent,
      byUserId: input.staff.userId,
      at: now,
    })
    .returning();
  await audit(tx, {
    tenantId: input.tenantId,
    engine: ENGINE,
    action: "stage.moved",
    entityType: "matter",
    entityId: matter.id,
    matterId: matter.id,
    actor: actorOf(input.staff),
    reason: input.reason?.trim() || null,
    payload: { from: lc.stageKey, to: check.to.key, backwards: check.backwards },
  });
  // Moving backwards never re-runs task lists automatically (the lawyer can start one by hand).
  const effects = check.backwards ? { runs: 0, warnings: [] as string[] } : await runOnEnter(tx, input.tenantId, matter, check.to, transition!.id, input.staff, now);
  return { stageKey: check.to.key, transitionId: transition!.id, ...effects };
}

async function openClosing(tx: TenantTx, tenantId: string, matterId: string) {
  const [row] = await tx
    .select()
    .from(matterClosings)
    .where(and(eq(matterClosings.tenantId, tenantId), eq(matterClosings.matterId, matterId), eq(matterClosings.status, "in_progress")))
    .limit(1);
  return row;
}

/** A lawyer starts closing: the closing-checklist task is created for the Document engine's checklist (c90). */
export async function startClosing(tx: TenantTx, input: { tenantId: string; staff: Staff; matterId: string; now?: Date }) {
  requireLawyer(input.staff, "close a matter");
  const now = input.now ?? new Date();
  const matter = await getMatter(tx, input.tenantId, input.matterId);
  const state = await getLifecycle(tx, input.tenantId, matter.id);
  if (!state) throw conflict("Start the matter's lifecycle first.");
  if (state.lifecycle.status !== "open") throw conflict(`The matter is already ${state.lifecycle.status}.`);
  const task = await createTask(
    tx,
    {
      tenantId: input.tenantId,
      kind: CLOSING_CHECKLIST_KIND,
      title: "Complete the closing checklist",
      description: "Final invoice, trust at zero, closing letter, originals returned, retention clock (Document engine, c90).",
      owner: { type: "user", userId: matter.assignedUserId ?? input.staff.userId },
      due: { hours: 40, clock: "business", from: now },
      matterId: matter.id,
      sourceCard: "c95",
      sourceRef: `matter_closing:${matter.id}`,
      createdBy: actorOf(input.staff),
      engine: ENGINE,
    },
    { now }
  );
  const [closing] = await tx
    .insert(matterClosings)
    .values({ tenantId: input.tenantId, matterId: matter.id, startedByUserId: input.staff.userId, startedAt: now, checklistTaskId: task.id })
    .returning();
  await tx.update(matterLifecycle).set({ status: "closing", updatedAt: now }).where(eq(matterLifecycle.id, state.lifecycle.id));
  await audit(tx, { tenantId: input.tenantId, engine: ENGINE, action: "matter.closing_started", entityType: "matter", entityId: matter.id, matterId: matter.id, actor: actorOf(input.staff), payload: { closingId: closing?.id, checklistTaskId: task.id } });
  return closing;
}

/**
 * A lawyer confirms the client's trust balance is zero (checked against the
 * trust ledger). Until the Billing & trust engine exposes a shared balance
 * read, this attestation is the record (see Foundation requests).
 */
export async function confirmTrustZero(tx: TenantTx, input: { tenantId: string; staff: Staff; matterId: string; attestation: string; now?: Date }) {
  requireLawyer(input.staff, "confirm trust at zero");
  const attestation = input.attestation?.trim();
  if (!attestation || attestation.length < 10) throw invalid("Describe how trust at zero was checked (e.g. ledger and date); it is logged.");
  const now = input.now ?? new Date();
  const closing = await openClosing(tx, input.tenantId, input.matterId);
  if (!closing) throw conflict("Start closing the matter first.");
  const [row] = await tx
    .update(matterClosings)
    .set({ trustZeroConfirmedByUserId: input.staff.userId, trustZeroConfirmedAt: now, trustZeroSource: "lawyer_attestation" })
    .where(eq(matterClosings.id, closing.id))
    .returning();
  await audit(tx, { tenantId: input.tenantId, engine: ENGINE, action: "matter.trust_zero_confirmed", entityType: "matter", entityId: input.matterId, matterId: input.matterId, actor: actorOf(input.staff), reason: attestation, payload: { source: "lawyer_attestation" } });
  return row;
}

/** What still blocks closing (for the closing screen). */
export async function closingStatus(tx: TenantTx, tenantId: string, matterId: string, now: Date = new Date()) {
  const closing = await openClosing(tx, tenantId, matterId);
  if (!closing) return { closing: null, blockers: ["Closing has not been started."] };
  const checklist = closing.checklistTaskId ? await getTask(tx, tenantId, closing.checklistTaskId) : undefined;
  const [deadlineTasks] = await tx
    .select({ n: count() })
    .from(tasks)
    .where(and(eq(tasks.tenantId, tenantId), eq(tasks.matterId, matterId), eq(tasks.status, "open"), eq(tasks.deadlineCritical, true)));
  const [future] = await tx
    .select({ n: count() })
    .from(calendarEvents)
    .where(and(eq(calendarEvents.tenantId, tenantId), eq(calendarEvents.matterId, matterId), ne(calendarEvents.status, "cancelled"), gt(calendarEvents.startsAt, now)));
  const [lims] = await tx
    .select({ n: count() })
    .from(limitationDates)
    .where(and(eq(limitationDates.tenantId, tenantId), eq(limitationDates.matterId, matterId), inArray(limitationDates.status, [...OPEN_LIMITATION_STATUSES])));
  const blockers = closingBlockers({
    checklistDone: checklist?.status === "done",
    trustZeroConfirmed: closing.trustZeroConfirmedAt !== null,
    openDeadlineTasks: Number(deadlineTasks?.n ?? 0),
    futureEvents: Number(future?.n ?? 0),
    openLimitations: Number(lims?.n ?? 0),
  });
  return { closing, blockers };
}

/** A lawyer completes the closing once nothing blocks it. The matter's stage becomes 'closed'. */
export async function completeClosing(tx: TenantTx, input: { tenantId: string; staff: Staff; matterId: string; now?: Date }) {
  requireLawyer(input.staff, "close a matter");
  const now = input.now ?? new Date();
  const { closing, blockers } = await closingStatus(tx, input.tenantId, input.matterId, now);
  if (!closing || blockers.length > 0) throw conflict("The matter cannot be closed yet.", blockers);
  const state = await getLifecycle(tx, input.tenantId, input.matterId);
  if (!state?.definition) throw conflict("Start the matter's lifecycle first.");
  const closingStage = state.definition.stages.find((s) => s.closing)!;
  await tx.update(matterClosings).set({ status: "closed", closedByUserId: input.staff.userId, closedAt: now }).where(eq(matterClosings.id, closing.id));
  await tx.update(matterLifecycle).set({ status: "closed", stageKey: closingStage.key, enteredStageAt: now, updatedAt: now }).where(eq(matterLifecycle.id, state.lifecycle.id));
  await tx.insert(matterStageTransitions).values({
    tenantId: input.tenantId,
    matterId: input.matterId,
    definitionId: state.lifecycle.definitionId,
    fromStageKey: state.lifecycle.stageKey,
    toStageKey: closingStage.key,
    reason: "Closing completed",
    billingEvent: closingStage.onEnter.billingEvent,
    byUserId: input.staff.userId,
    at: now,
  });
  await tx.update(matters).set({ stage: "closed", closedAt: now }).where(and(eq(matters.tenantId, input.tenantId), eq(matters.id, input.matterId)));
  await audit(tx, { tenantId: input.tenantId, engine: ENGINE, action: "matter.closed", entityType: "matter", entityId: input.matterId, matterId: input.matterId, actor: actorOf(input.staff), payload: { closingId: closing.id } });
  return { closed: true, closedAt: now };
}

/** Stop a closing (reason logged); the matter goes back to open at its current stage. */
export async function abandonClosing(tx: TenantTx, input: { tenantId: string; staff: Staff; matterId: string; reason: string; now?: Date }) {
  requireLawyer(input.staff, "stop closing a matter");
  const reason = input.reason?.trim();
  if (!reason) throw invalid("A reason is required; it is logged.");
  const closing = await openClosing(tx, input.tenantId, input.matterId);
  if (!closing) throw conflict("No closing is in progress.");
  await tx.update(matterClosings).set({ status: "abandoned", abandonReason: reason }).where(eq(matterClosings.id, closing.id));
  await tx.update(matterLifecycle).set({ status: "open", updatedAt: input.now ?? new Date() }).where(and(eq(matterLifecycle.tenantId, input.tenantId), eq(matterLifecycle.matterId, input.matterId)));
  await audit(tx, { tenantId: input.tenantId, engine: ENGINE, action: "matter.closing_abandoned", entityType: "matter", entityId: input.matterId, matterId: input.matterId, actor: actorOf(input.staff), reason });
  return { ok: true };
}
