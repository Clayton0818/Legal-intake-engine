// c42 / c46 — database side of the client chase ladder.
//
//   startClientReplyRequest()  an outbound message that expects a reply → a
//                              client-owned `client_reply_due` task (c42 §4.2)
//   onClientReply()            the client replied → those tasks complete,
//                              their ladders end (c42 §4.3)
//   startLadderForTask()       called by the overdue scan when ANY client-owned
//                              task lapses (one mechanism for c42 and c46)
//   processDueLadders()        worker hook: run due ladder steps
//   pause / resume / decide    the lawyer's controls (reasons logged)
//
// Client reminders use only the shared neutral template
// (notify.client.reminder) and carry ids only (c51 minimal content). Internal
// flags go only to firm users. Nothing here ever takes a legal step.

import { and, asc, eq, inArray, isNull, lte } from "drizzle-orm";
import { calendarEvents, flags, tasks } from "@/db/tables/foundation";
import { clientChaseLadders } from "@/db/tables/calendar-alerts";
import type { TenantTx } from "@/tenancy/withTenant";
import { NOTIFY_COPY_GATES } from "@/compliance/gates";
import { audit, type Actor } from "@/core/audit";
import { toBusinessCalendar } from "@/core/firmSettings";
import { addBusinessHours } from "@/core/businessHours";
import { cancelTask, changeTaskDue, completeTask, createTask, getTask, type TaskRow } from "@/core/tasks";
import { escalateFlag } from "@/core/flags";
import { AlertRuleError, getMatter, loadPeople, notifyClient, raiseAlert, responsibleLawyer, type EngineContext } from "../common";
import { FLAG_TYPES, TASK_KINDS } from "../kinds";
import { ENGINE, type LadderStep } from "../settings";
import { deadlineBeatsLadder, firstStepAt, planStep, type LadderDecision } from "./plan";

export type LadderRow = typeof clientChaseLadders.$inferSelect;

export async function startClientReplyRequest(
  tx: TenantTx,
  ctx: EngineContext,
  input: {
    tenantId: string;
    matterId: string;
    messageId: string;
    partyId: string;
    sentAt: Date;
    windowHours?: number | null;
    relatedCalendarEventId?: string | null;
    by: Actor;
  }
): Promise<TaskRow> {
  const hours = input.windowHours ?? ctx.firm.clientResponseWindowHours;
  if (!(hours > 0)) throw new AlertRuleError("The response window must be more than zero business hours.");
  return createTask(
    tx,
    {
      tenantId: input.tenantId,
      kind: TASK_KINDS.clientReplyDue,
      title: "Reply to your legal team's message",
      description: "Your legal team sent you a message and is waiting for your reply in the portal.",
      owner: { type: "client", partyId: input.partyId },
      visibility: "client",
      due: { hours, clock: "business", from: input.sentAt },
      matterId: input.matterId,
      sourceCard: "c42",
      sourceRef: `client_message:${input.messageId}`,
      relatedCalendarEventId: input.relatedCalendarEventId ?? null,
      metadata: { messageId: input.messageId, windowHours: hours },
      createdBy: input.by,
      engine: ENGINE,
    },
    { now: input.sentAt, calendar: toBusinessCalendar(ctx.firm) }
  );
}

/** The client replied: every open c42 request on the matter sent before the reply completes, and its ladder ends. */
export async function onClientReply(tx: TenantTx, input: { tenantId: string; matterId: string; partyId: string | null; at: Date }): Promise<number> {
  const open = await tx
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.tenantId, input.tenantId),
        eq(tasks.matterId, input.matterId),
        eq(tasks.kind, TASK_KINDS.clientReplyDue),
        eq(tasks.status, "open"),
        lte(tasks.createdAt, input.at)
      )
    );
  for (const t of open) {
    const by: Actor = t.ownerPartyId ? { type: "client", partyId: t.ownerPartyId } : { type: "system" };
    await completeTask(tx, { tenantId: input.tenantId, taskId: t.id, by, reason: "Client replied", engine: ENGINE, at: input.at });
    await endLadder(tx, input.tenantId, t.id, "completed", "Client replied", input.at);
  }
  return open.length;
}

async function endLadder(tx: TenantTx, tenantId: string, taskId: string, status: "completed" | "stopped", reason: string, at: Date): Promise<void> {
  await tx
    .update(clientChaseLadders)
    .set({ status, endedAt: at, endReason: reason, nextAt: null })
    .where(
      and(
        eq(clientChaseLadders.tenantId, tenantId),
        eq(clientChaseLadders.taskId, taskId),
        inArray(clientChaseLadders.status, ["active", "paused", "awaiting_lawyer"])
      )
    );
}

/** A client-owned task has lapsed: start its ladder (idempotent per task) and run the first step if due. */
export async function startLadderForTask(tx: TenantTx, ctx: EngineContext, task: TaskRow, now: Date): Promise<LadderRow | null> {
  if (task.ownerType !== "client" || !task.ownerPartyId) return null;
  const steps = ctx.alerts.ladder;
  const cal = toBusinessCalendar(ctx.firm);
  const [row] = await tx
    .insert(clientChaseLadders)
    .values({
      tenantId: task.tenantId,
      matterId: task.matterId,
      subjectType: task.kind === TASK_KINDS.clientReplyDue ? "message" : "task",
      taskId: task.id,
      messageId: typeof task.metadata.messageId === "string" ? (task.metadata.messageId as string) : null,
      partyId: task.ownerPartyId,
      nextStep: 0,
      nextAt: firstStepAt(task.dueAt, steps, cal),
      ladderSnapshot: { steps },
      startedAt: now,
    })
    .onConflictDoNothing()
    .returning();
  if (!row) return null;
  await audit(tx, {
    tenantId: task.tenantId,
    engine: ENGINE,
    action: row.subjectType === "message" ? "client.non_response" : "client_task.lapsed",
    entityType: "task",
    entityId: task.id,
    matterId: task.matterId,
    payload: { dueAt: task.dueAt.toISOString(), ladderId: row.id },
  });
  if (row.nextAt && row.nextAt.getTime() <= now.getTime()) await runLadderStep(tx, ctx, row, now);
  return row;
}

/** Worker hook: run every due ladder step for the firm. */
export async function processDueLadders(tx: TenantTx, ctx: EngineContext, tenantId: string, now: Date): Promise<{ steps: number }> {
  const due = await tx
    .select()
    .from(clientChaseLadders)
    .where(and(eq(clientChaseLadders.tenantId, tenantId), eq(clientChaseLadders.status, "active"), lte(clientChaseLadders.nextAt, now)))
    .orderBy(asc(clientChaseLadders.nextAt))
    .limit(200)
    .for("update", { skipLocked: true });
  for (const l of due) await runLadderStep(tx, ctx, l, now);
  return { steps: due.length };
}

function snapshotSteps(l: LadderRow, fallback: LadderStep[]): LadderStep[] {
  const s = (l.ladderSnapshot as { steps?: LadderStep[] }).steps;
  return Array.isArray(s) && s.length > 0 ? s : fallback;
}

async function runLadderStep(tx: TenantTx, ctx: EngineContext, l: LadderRow, now: Date): Promise<void> {
  const task = await getTask(tx, l.tenantId, l.taskId);
  if (!task || task.status !== "open") {
    await endLadder(tx, l.tenantId, l.taskId, "completed", task ? `Task ${task.status}` : "Task missing", now);
    return;
  }
  const cal = toBusinessCalendar(ctx.firm);
  const plan = planStep(snapshotSteps(l, ctx.alerts.ladder), l.nextStep, l.remindersSent, now, cal);
  if (!plan) {
    await endLadder(tx, l.tenantId, l.taskId, "completed", "Ladder finished", now);
    return;
  }
  const people = await loadPeople(tx, l.tenantId, ctx.alerts);
  const matter = task.matterId ? await getMatter(tx, l.tenantId, task.matterId) : null;
  const lawyer = matter ? await responsibleLawyer(tx, l.tenantId, matter) : null;
  const firmRecipients = [...new Set([lawyer, ...people.admins].filter((x): x is string => Boolean(x)))];
  const isMessage = l.subjectType === "message";
  let flagId = l.internalFlagId;
  let decisionTaskId = l.decisionTaskId;
  let status: LadderRow["status"] = "active";
  let remindersSent = l.remindersSent;

  if (plan.step.action === "reminder") {
    const notice = await notifyClient(tx, ctx, {
      tenantId: l.tenantId,
      partyId: l.partyId,
      matterId: task.matterId,
      templateKey: NOTIFY_COPY_GATES.reminder.key,
      payload: { taskId: task.id },
      dedupeKey: `calendar-alerts.ladder:${l.id}:${plan.index}`,
      now,
      admins: people.admins,
    });
    remindersSent += 1;
    await audit(tx, {
      tenantId: l.tenantId,
      engine: ENGINE,
      action: "client.reminder_sent",
      entityType: "task",
      entityId: task.id,
      matterId: task.matterId,
      payload: { reminder: plan.reminderNumber, inAppId: notice.inApp.id, emailId: notice.email?.id ?? null, emailSkipped: notice.emailSkippedReason },
    });
    const noteParts = [
      isMessage ? "The client has not replied to the firm's message within the response window." : `The client has not completed: ${task.title}.`,
      `Reminder ${plan.reminderNumber} sent to the client (portal${notice.email ? " + email" : ""}).`,
    ];
    if (notice.email?.status === "suppressed") noteParts.push(`Email not sent: ${notice.email.lastError ?? "suppressed"}.`);
    if (notice.emailSkippedReason) noteParts.push(notice.emailSkippedReason);
    const raiseFirmFlag = async (): Promise<string | null> => {
      if (firmRecipients.length === 0) return null;
      const type = isMessage ? FLAG_TYPES.clientNonResponse : FLAG_TYPES.clientTaskOverdue;
      const res = await raiseAlert(
        tx,
        ctx,
        {
          tenantId: l.tenantId,
          type,
          severity: plan.flagLevel === 1 ? "warning" : "high",
          audience: "internal",
          title: isMessage ? "Client has not replied" : "Client task past due",
          summary: noteParts.join(" ") + (lawyer ? "" : " No responsible lawyer is assigned."),
          details: { taskId: task.id, ladderId: l.id, step: plan.index },
          matterId: task.matterId,
          taskId: task.id,
          recipients: { userIds: firmRecipients },
          dedupeKey: `${type}:${task.id}`,
          sourceCard: isMessage ? "c42" : "c46",
        },
        now
      );
      return res.flag.id;
    };
    if (plan.flagLevel === 1 || !flagId) {
      flagId = (await raiseFirmFlag()) ?? flagId;
    } else {
      const open = await isFlagOpen(tx, l.tenantId, flagId);
      if (open) {
        await escalateFlag(tx, {
          tenantId: l.tenantId,
          flagId,
          addUserIds: people.managing,
          severity: "high",
          note: noteParts.join(" "),
          engine: ENGINE,
          at: now,
        });
      } else {
        // The earlier flag was resolved meanwhile (e.g. the task was re-dated): raise a fresh one rather than lose the step.
        flagId = (await raiseFirmFlag()) ?? flagId;
      }
    }
  } else {
    const decision = await createTask(
      tx,
      {
        tenantId: l.tenantId,
        kind: TASK_KINDS.lawyerDecides,
        title: isMessage ? "Client has not replied — decide the next step" : `Client task still open — decide the next step: ${task.title}`,
        description:
          "Automatic reminders have finished. Options: send a personal message, log a phone call, extend the window, mark no reply needed, or close with a note. Nothing further is sent automatically.",
        owner: lawyer ? { type: "user", userId: lawyer } : { type: "firm" },
        due: { hours: ctx.alerts.decisionDueBusinessHours, clock: "business", from: now },
        matterId: task.matterId,
        sourceCard: isMessage ? "c42" : "c46",
        sourceRef: `client_chase_ladder:${l.id}`,
        metadata: { ladderId: l.id, clientTaskId: task.id },
        engine: ENGINE,
      },
      { now, calendar: cal }
    );
    decisionTaskId = decision.id;
    status = "awaiting_lawyer";
    await audit(tx, {
      tenantId: l.tenantId,
      engine: ENGINE,
      action: "client.ladder_lawyer_decides",
      entityType: "task",
      entityId: task.id,
      matterId: task.matterId,
      payload: { decisionTaskId: decision.id },
    });
  }

  // Real-clock safety net for deadline-linked items (c42 §8, c46 §4.6).
  if (task.relatedCalendarEventId) {
    const [ev] = await tx
      .select()
      .from(calendarEvents)
      .where(and(eq(calendarEvents.tenantId, l.tenantId), eq(calendarEvents.id, task.relatedCalendarEventId), isNull(calendarEvents.cancelledAt)))
      .limit(1);
    if (ev && ev.status === "confirmed" && (plan.index === 0 || deadlineBeatsLadder(ev.startsAt, plan.nextAt, now))) {
      const recipients = firmRecipients.length > 0 ? firmRecipients : people.admins;
      if (recipients.length > 0) {
        await raiseAlert(
          tx,
          ctx,
          {
            tenantId: l.tenantId,
            type: FLAG_TYPES.clientTaskDeadline,
            severity: "critical",
            urgent: true,
            audience: "internal",
            title: "Client item tied to a court deadline is outstanding",
            summary: `"${task.title}" is linked to the confirmed entry "${ev.title}" (${ev.startsAt.toISOString()}). The client has not completed it.`,
            details: { taskId: task.id, calendarEventId: ev.id },
            matterId: task.matterId,
            taskId: task.id,
            recipients: { userIds: recipients },
            dedupeKey: `${FLAG_TYPES.clientTaskDeadline}:${task.id}`,
            sourceCard: isMessage ? "c42" : "c46",
          },
          now
        );
      }
    }
  }

  await tx
    .update(clientChaseLadders)
    .set({
      nextStep: plan.index + 1,
      nextAt: status === "active" ? plan.nextAt : null,
      remindersSent,
      status: status === "active" && plan.nextAt === null ? "completed" : status,
      lastStepAt: now,
      internalFlagId: flagId,
      decisionTaskId,
    })
    .where(and(eq(clientChaseLadders.tenantId, l.tenantId), eq(clientChaseLadders.id, l.id)));
}

async function isFlagOpen(tx: TenantTx, tenantId: string, flagId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: flags.id })
    .from(flags)
    .where(and(eq(flags.tenantId, tenantId), eq(flags.id, flagId), isNull(flags.resolvedAt)))
    .limit(1);
  return Boolean(row);
}

async function getLadder(tx: TenantTx, tenantId: string, ladderId: string): Promise<LadderRow> {
  const [l] = await tx
    .select()
    .from(clientChaseLadders)
    .where(and(eq(clientChaseLadders.tenantId, tenantId), eq(clientChaseLadders.id, ladderId)))
    .limit(1);
  if (!l) throw new AlertRuleError("Ladder not found.", 404);
  return l;
}

export async function pauseLadder(tx: TenantTx, input: { tenantId: string; ladderId: string; userId: string; reason: string; now: Date }): Promise<LadderRow> {
  const reason = input.reason?.trim();
  if (!reason) throw new AlertRuleError("A reason is required to pause reminders.");
  const l = await getLadder(tx, input.tenantId, input.ladderId);
  if (l.status !== "active") throw new AlertRuleError(`Ladder is ${l.status}.`, 409);
  const [row] = await tx
    .update(clientChaseLadders)
    .set({ status: "paused", pausedBy: "lawyer", pausedReason: reason })
    .where(and(eq(clientChaseLadders.tenantId, input.tenantId), eq(clientChaseLadders.id, l.id)))
    .returning();
  await audit(tx, { tenantId: input.tenantId, engine: ENGINE, action: "client.ladder_paused", entityType: "task", entityId: l.taskId, matterId: l.matterId, actor: { type: "user", userId: input.userId }, reason });
  return row!;
}

/** Resume a paused ladder; the next step is due one step-gap from now. */
export async function resumeLadder(tx: TenantTx, ctx: EngineContext, input: { tenantId: string; ladderId: string; by: Actor; reason: string; now: Date }): Promise<LadderRow> {
  if (!input.reason?.trim()) throw new AlertRuleError("A reason is required to resume reminders.");
  const l = await getLadder(tx, input.tenantId, input.ladderId);
  if (l.status !== "paused") throw new AlertRuleError(`Ladder is ${l.status}.`, 409);
  const steps = snapshotSteps(l, ctx.alerts.ladder);
  const next = steps[l.nextStep];
  const nextAt = next ? addBusinessHours(input.now, next.afterBusinessHours, toBusinessCalendar(ctx.firm)) : null;
  const [row] = await tx
    .update(clientChaseLadders)
    .set({ status: next ? "active" : "completed", pausedBy: null, pausedReason: null, nextAt })
    .where(and(eq(clientChaseLadders.tenantId, input.tenantId), eq(clientChaseLadders.id, l.id)))
    .returning();
  await audit(tx, { tenantId: input.tenantId, engine: ENGINE, action: "client.ladder_resumed", entityType: "task", entityId: l.taskId, matterId: l.matterId, actor: input.by, reason: input.reason });
  return row!;
}

/** c46 §4.7: the client asked for help — reminders on that task pause until a firm user replies. */
export async function pauseForHelpRequest(tx: TenantTx, input: { tenantId: string; taskId: string; partyId: string; now: Date }): Promise<void> {
  await tx
    .update(clientChaseLadders)
    .set({ status: "paused", pausedBy: "help_request", pausedReason: "Client asked for help" })
    .where(and(eq(clientChaseLadders.tenantId, input.tenantId), eq(clientChaseLadders.taskId, input.taskId), eq(clientChaseLadders.status, "active")));
  await audit(tx, {
    tenantId: input.tenantId,
    engine: ENGINE,
    action: "client_task.help_requested",
    entityType: "task",
    entityId: input.taskId,
    actor: { type: "client", partyId: input.partyId },
  });
}

/** A firm user replied on the matter: ladders paused by a help request resume. */
export async function resumeHelpPausedLadders(tx: TenantTx, ctx: EngineContext, input: { tenantId: string; matterId: string; now: Date }): Promise<number> {
  const paused = await tx
    .select()
    .from(clientChaseLadders)
    .where(
      and(
        eq(clientChaseLadders.tenantId, input.tenantId),
        eq(clientChaseLadders.matterId, input.matterId),
        eq(clientChaseLadders.status, "paused"),
        eq(clientChaseLadders.pausedBy, "help_request")
      )
    );
  for (const l of paused) {
    await resumeLadder(tx, ctx, { tenantId: input.tenantId, ladderId: l.id, by: { type: "system" }, reason: "Firm replied to the client's help request", now: input.now });
  }
  return paused.length;
}

/** The lawyer's decision at the end of the ladder (c42 §4.6). Never a legal step. */
export async function recordLawyerDecision(
  tx: TenantTx,
  ctx: EngineContext,
  input: { tenantId: string; ladderId: string; userId: string; decision: LadderDecision; note: string; extendBusinessHours?: number; now: Date }
): Promise<LadderRow> {
  const note = input.note?.trim();
  if (!note) throw new AlertRuleError("A note is required for the decision.");
  const l = await getLadder(tx, input.tenantId, input.ladderId);
  if (!["active", "paused", "awaiting_lawyer"].includes(l.status)) throw new AlertRuleError(`Ladder is ${l.status}.`, 409);
  const by: Actor = { type: "user", userId: input.userId };
  const task = await getTask(tx, input.tenantId, l.taskId);
  let set: Partial<typeof clientChaseLadders.$inferInsert>;

  if (input.decision === "extend_window") {
    const hours = input.extendBusinessHours ?? ctx.firm.clientResponseWindowHours;
    if (!(hours > 0)) throw new AlertRuleError("Extend by more than zero business hours.");
    if (!task || task.status !== "open") throw new AlertRuleError("The client item is no longer open.", 409);
    const dueAt = addBusinessHours(input.now, hours, toBusinessCalendar(ctx.firm));
    await changeTaskDue(tx, { tenantId: input.tenantId, taskId: task.id, dueAt, by, reason: `Window extended by lawyer: ${note}`, engine: ENGINE });
    set = { status: "active", nextStep: 0, remindersSent: 0, nextAt: firstStepAt(dueAt, snapshotSteps(l, ctx.alerts.ladder), toBusinessCalendar(ctx.firm)), pausedBy: null, pausedReason: null, internalFlagId: null };
  } else if (input.decision === "no_reply_needed" || input.decision === "close_with_note") {
    if (task && task.status === "open") {
      await cancelTask(tx, { tenantId: input.tenantId, taskId: task.id, by, reason: `${input.decision === "no_reply_needed" ? "No reply needed" : "Closed by lawyer"}: ${note}`, engine: ENGINE });
    }
    set = { status: "completed", nextAt: null, endedAt: input.now, endReason: input.decision };
  } else {
    // Personal message / phone call: automation stops; the client item stays open until done.
    set = { status: "stopped", nextAt: null, endedAt: input.now, endReason: input.decision };
  }
  if (l.decisionTaskId) {
    const d = await getTask(tx, input.tenantId, l.decisionTaskId);
    if (d?.status === "open") await completeTask(tx, { tenantId: input.tenantId, taskId: d.id, by, reason: `Decided: ${input.decision} — ${note}`, engine: ENGINE });
  }
  const [row] = await tx
    .update(clientChaseLadders)
    .set(set)
    .where(and(eq(clientChaseLadders.tenantId, input.tenantId), eq(clientChaseLadders.id, l.id)))
    .returning();
  await audit(tx, {
    tenantId: input.tenantId,
    engine: ENGINE,
    action: "client.ladder_decision",
    entityType: "task",
    entityId: l.taskId,
    matterId: l.matterId,
    actor: by,
    reason: note,
    payload: { decision: input.decision },
  });
  return row!;
}

/** Ladders for a matter (staff view). */
export async function listLadders(tx: TenantTx, tenantId: string, filter: { matterId?: string; openOnly?: boolean } = {}): Promise<LadderRow[]> {
  const conds = [eq(clientChaseLadders.tenantId, tenantId)];
  if (filter.matterId) conds.push(eq(clientChaseLadders.matterId, filter.matterId));
  if (filter.openOnly ?? true) conds.push(inArray(clientChaseLadders.status, ["active", "paused", "awaiting_lawyer"]));
  return tx.select().from(clientChaseLadders).where(and(...conds)).orderBy(asc(clientChaseLadders.nextAt)).limit(200);
}
