// c94 — task-list templates and runs (database). Templates are versioned:
// editing an active template creates a new draft version; activating it
// retires the previous active version. Runs create real rows in the shared
// `tasks` table.

import { and, desc, eq, inArray, max } from "drizzle-orm";
import { tasks } from "@/db/tables/foundation";
import { taskListRunItems, taskListRuns, taskListTemplates } from "@/db/tables/calendar-core";
import type { TenantTx } from "@/tenancy/withTenant";
import { audit, cancelTask, createTask, SYSTEM_ACTOR, type Actor } from "@/core";
import { actorOf, requireTemplateManager, requireWriter, type Staff } from "../actors";
import { conflict, invalid, notFound } from "../errors";
import { getMatter } from "../matters";
import { ENGINE } from "../settings";
import { FAMILY_LAW_DRAFT_TASK_LISTS } from "./familyLawDrafts";
import { readyToRelease, resolveOwner, runComplete, taskKindFor, validateTaskListTemplate, type RunItemState, type TaskListTemplateInput } from "./taskLists";

export type TaskListTemplateRow = typeof taskListTemplates.$inferSelect;

export async function listTemplates(tx: TenantTx, tenantId: string, filter: { practiceArea?: string; includeRetired?: boolean } = {}) {
  const conds = [eq(taskListTemplates.tenantId, tenantId)];
  if (filter.practiceArea) conds.push(eq(taskListTemplates.practiceArea, filter.practiceArea));
  const rows = await tx.select().from(taskListTemplates).where(and(...conds)).orderBy(taskListTemplates.key, desc(taskListTemplates.version));
  return filter.includeRetired ? rows : rows.filter((r) => r.status !== "retired");
}

/** Save a template as a NEW draft version (an active version is never edited in place). */
export async function saveTemplateDraft(
  tx: TenantTx,
  input: { tenantId: string; staff: Staff | null; template: TaskListTemplateInput; systemDraft?: boolean; now?: Date }
): Promise<TaskListTemplateRow> {
  if (input.staff) requireTemplateManager(input.staff);
  const errors = validateTaskListTemplate(input.template);
  if (errors.length > 0) throw invalid("The task list is not valid.", errors);
  const [latest] = await tx
    .select({ v: max(taskListTemplates.version) })
    .from(taskListTemplates)
    .where(and(eq(taskListTemplates.tenantId, input.tenantId), eq(taskListTemplates.key, input.template.key)));
  const version = (latest?.v ?? 0) + 1;
  const [row] = await tx
    .insert(taskListTemplates)
    .values({
      tenantId: input.tenantId,
      key: input.template.key,
      version,
      practiceArea: input.template.practiceArea,
      name: input.template.name.trim(),
      triggerStageKey: input.template.triggerStageKey,
      items: input.template.items,
      status: "draft",
      systemDraft: input.systemDraft ?? false,
      createdByUserId: input.staff?.userId ?? null,
    })
    .returning();
  if (!row) throw new Error("saveTemplateDraft: insert failed.");
  await audit(tx, {
    tenantId: input.tenantId,
    engine: ENGINE,
    action: "task_list.draft_saved",
    entityType: "task_list_template",
    entityId: row.id,
    actor: input.staff ? actorOf(input.staff) : SYSTEM_ACTOR,
    payload: { key: row.key, version, systemDraft: row.systemDraft },
  });
  return row;
}

/** A lawyer or firm admin activates a draft version; the previous active version is retired. */
export async function activateTemplate(tx: TenantTx, input: { tenantId: string; staff: Staff; templateId: string; now?: Date }) {
  requireTemplateManager(input.staff);
  const now = input.now ?? new Date();
  const [row] = await tx.select().from(taskListTemplates).where(and(eq(taskListTemplates.tenantId, input.tenantId), eq(taskListTemplates.id, input.templateId))).limit(1);
  if (!row) throw notFound("Task list");
  if (row.status !== "draft") throw conflict(`This version is ${row.status}; only a draft can be activated.`);
  await tx
    .update(taskListTemplates)
    .set({ status: "retired", updatedAt: now })
    .where(and(eq(taskListTemplates.tenantId, input.tenantId), eq(taskListTemplates.key, row.key), eq(taskListTemplates.status, "active")));
  const [active] = await tx
    .update(taskListTemplates)
    .set({ status: "active", activatedByUserId: input.staff.userId, activatedAt: now, updatedAt: now })
    .where(eq(taskListTemplates.id, row.id))
    .returning();
  await audit(tx, {
    tenantId: input.tenantId,
    engine: ENGINE,
    action: "task_list.activated",
    entityType: "task_list_template",
    entityId: row.id,
    actor: actorOf(input.staff),
    payload: { key: row.key, version: row.version, wasSystemDraft: row.systemDraft },
  });
  return active;
}

/** Retire a template (no more runs). Running runs continue. */
export async function retireTemplate(tx: TenantTx, input: { tenantId: string; staff: Staff; templateId: string; now?: Date }) {
  requireTemplateManager(input.staff);
  const [row] = await tx
    .update(taskListTemplates)
    .set({ status: "retired", updatedAt: input.now ?? new Date() })
    .where(and(eq(taskListTemplates.tenantId, input.tenantId), eq(taskListTemplates.id, input.templateId)))
    .returning();
  if (!row) throw notFound("Task list");
  await audit(tx, { tenantId: input.tenantId, engine: ENGINE, action: "task_list.retired", entityType: "task_list_template", entityId: row.id, actor: actorOf(input.staff) });
  return row;
}

/** Seed the DRAFT Family Law task lists for a firm (idempotent: skips keys the firm already has). */
export async function seedFamilyLawTaskListDrafts(tx: TenantTx, tenantId: string, staff: Staff | null): Promise<number> {
  const existing = new Set(
    (await tx.select({ key: taskListTemplates.key }).from(taskListTemplates).where(eq(taskListTemplates.tenantId, tenantId))).map((r) => r.key)
  );
  let n = 0;
  for (const t of FAMILY_LAW_DRAFT_TASK_LISTS) {
    if (existing.has(t.key)) continue;
    await saveTemplateDraft(tx, { tenantId, staff, template: { ...t, practiceArea: "family" }, systemDraft: true });
    n++;
  }
  return n;
}

async function releaseItem(
  tx: TenantTx,
  tenantId: string,
  run: typeof taskListRuns.$inferSelect,
  template: TaskListTemplateRow,
  itemKey: string,
  ctx: { responsibleUserId: string | null; clientPartyId: string | null },
  by: Actor,
  now: Date
): Promise<void> {
  const item = template.items.find((i) => i.key === itemKey);
  if (!item) return;
  const { owner, visibility } = resolveOwner(item.owner, ctx);
  const task = await createTask(
    tx,
    {
      tenantId,
      kind: taskKindFor(template.key, item.key),
      title: item.title,
      description: item.description ?? null,
      owner,
      due: { hours: item.dueHours, clock: item.deadlineCritical ? "real" : item.clock, from: now },
      matterId: run.matterId,
      supervisorUserId: owner.type !== "user" || owner.userId !== ctx.responsibleUserId ? ctx.responsibleUserId : null,
      deadlineCritical: item.deadlineCritical ?? false,
      visibility,
      sourceCard: "c94",
      sourceRef: `task_list_run:${run.id}:${item.key}`,
      metadata: { templateKey: template.key, templateVersion: template.version, itemKey: item.key },
      createdBy: by,
      engine: ENGINE,
    },
    { now }
  );
  await tx
    .update(taskListRunItems)
    .set({ status: "released", taskId: task.id, releasedAt: now })
    .where(and(eq(taskListRunItems.tenantId, tenantId), eq(taskListRunItems.runId, run.id), eq(taskListRunItems.itemKey, item.key)));
}

/** Run an ACTIVE template on a matter (by hand, or from a stage change). Items without prerequisites become tasks now. */
export async function startRun(
  tx: TenantTx,
  input: { tenantId: string; matterId: string; templateKey: string; staff: Staff | null; stageTransitionId?: string | null; now?: Date }
) {
  if (input.staff) requireWriter(input.staff);
  const now = input.now ?? new Date();
  const matter = await getMatter(tx, input.tenantId, input.matterId);
  const [template] = await tx
    .select()
    .from(taskListTemplates)
    .where(and(eq(taskListTemplates.tenantId, input.tenantId), eq(taskListTemplates.key, input.templateKey), eq(taskListTemplates.status, "active")))
    .limit(1);
  if (!template) throw notFound(`Active task list '${input.templateKey}'`);
  const by = input.staff ? actorOf(input.staff) : SYSTEM_ACTOR;
  const [run] = await tx
    .insert(taskListRuns)
    .values({
      tenantId: input.tenantId,
      matterId: matter.id,
      templateId: template.id,
      templateKey: template.key,
      templateVersion: template.version,
      stageTransitionId: input.stageTransitionId ?? null,
      startedByUserId: input.staff?.userId ?? null,
      startedAt: now,
    })
    .onConflictDoNothing()
    .returning();
  if (!run) return null; // this stage transition already ran this template
  for (const item of template.items) {
    await tx.insert(taskListRunItems).values({ tenantId: input.tenantId, runId: run.id, itemKey: item.key, dependsOn: item.dependsOn });
  }
  const ctx = { responsibleUserId: matter.assignedUserId, clientPartyId: matter.primaryPartyId };
  for (const item of template.items.filter((i) => i.dependsOn.length === 0)) {
    await releaseItem(tx, input.tenantId, run, template, item.key, ctx, by, now);
  }
  await audit(tx, {
    tenantId: input.tenantId,
    engine: ENGINE,
    action: "task_list.run_started",
    entityType: "task_list_run",
    entityId: run.id,
    matterId: matter.id,
    actor: by,
    payload: { templateKey: template.key, version: template.version, stageTransitionId: input.stageTransitionId ?? null },
  });
  return run;
}

/** Worker: release items whose prerequisites are finished; mark finished runs complete. */
export async function releaseReadyItems(tx: TenantTx, tenantId: string, now: Date): Promise<{ released: number; completedRuns: number }> {
  const runs = await tx.select().from(taskListRuns).where(and(eq(taskListRuns.tenantId, tenantId), eq(taskListRuns.status, "running"))).limit(500);
  const out = { released: 0, completedRuns: 0 };
  for (const run of runs) {
    const items = await tx.select().from(taskListRunItems).where(and(eq(taskListRunItems.tenantId, tenantId), eq(taskListRunItems.runId, run.id)));
    const taskIds = items.map((i) => i.taskId).filter((id): id is string => !!id);
    const closed = new Set(
      taskIds.length
        ? (await tx.select({ id: tasks.id, status: tasks.status }).from(tasks).where(and(eq(tasks.tenantId, tenantId), inArray(tasks.id, taskIds))))
            .filter((t) => t.status !== "open")
            .map((t) => t.id)
        : []
    );
    const states: RunItemState[] = items.map((i) => ({
      itemKey: i.itemKey,
      dependsOn: i.dependsOn,
      status: i.status as RunItemState["status"],
      taskClosed: i.taskId ? closed.has(i.taskId) : false,
    }));
    const ready = readyToRelease(states);
    if (ready.length > 0) {
      const [template] = await tx.select().from(taskListTemplates).where(eq(taskListTemplates.id, run.templateId)).limit(1);
      const matter = await getMatter(tx, tenantId, run.matterId);
      if (template) {
        for (const key of ready) {
          await releaseItem(tx, tenantId, run, template, key, { responsibleUserId: matter.assignedUserId, clientPartyId: matter.primaryPartyId }, SYSTEM_ACTOR, now);
          out.released++;
        }
      }
      continue;
    }
    if (runComplete(states)) {
      await tx.update(taskListRuns).set({ status: "completed", finishedAt: now }).where(eq(taskListRuns.id, run.id));
      out.completedRuns++;
    }
  }
  return out;
}

/** Cancel a run: waiting items are skipped and open tasks cancelled, with the reason logged. */
export async function cancelRun(tx: TenantTx, input: { tenantId: string; staff: Staff; runId: string; reason: string; now?: Date }) {
  requireWriter(input.staff);
  const reason = input.reason?.trim();
  if (!reason) throw invalid("A reason is required to cancel a task list; it is logged.");
  const now = input.now ?? new Date();
  const [run] = await tx.select().from(taskListRuns).where(and(eq(taskListRuns.tenantId, input.tenantId), eq(taskListRuns.id, input.runId))).limit(1);
  if (!run) throw notFound("Task list run");
  if (run.status !== "running") throw conflict(`This run is already ${run.status}.`);
  const items = await tx.select().from(taskListRunItems).where(and(eq(taskListRunItems.tenantId, input.tenantId), eq(taskListRunItems.runId, run.id)));
  for (const i of items) {
    if (i.status === "waiting") {
      await tx.update(taskListRunItems).set({ status: "skipped", skipReason: reason }).where(eq(taskListRunItems.id, i.id));
    } else if (i.taskId) {
      const [t] = await tx.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, i.taskId)).limit(1);
      if (t?.status === "open") await cancelTask(tx, { tenantId: input.tenantId, taskId: i.taskId, by: actorOf(input.staff), reason: `Task list cancelled: ${reason}`, engine: ENGINE });
    }
  }
  await tx.update(taskListRuns).set({ status: "cancelled", finishedAt: now }).where(eq(taskListRuns.id, run.id));
  await audit(tx, { tenantId: input.tenantId, engine: ENGINE, action: "task_list.run_cancelled", entityType: "task_list_run", entityId: run.id, matterId: run.matterId, actor: actorOf(input.staff), reason });
  return { ok: true };
}

export async function listRunsForMatter(tx: TenantTx, tenantId: string, matterId: string) {
  const runs = await tx.select().from(taskListRuns).where(and(eq(taskListRuns.tenantId, tenantId), eq(taskListRuns.matterId, matterId))).orderBy(desc(taskListRuns.startedAt));
  const ids = runs.map((r) => r.id);
  const items = ids.length ? await tx.select().from(taskListRunItems).where(and(eq(taskListRunItems.tenantId, tenantId), inArray(taskListRunItems.runId, ids))) : [];
  return runs.map((r) => ({ ...r, items: items.filter((i) => i.runId === r.id) }));
}
