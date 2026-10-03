// c42 / c43 / c44 — the client correspondence log and the reply clocks
// (database side).
//
//   recordInboundMessage()   a client wrote: tag it (safety, deadline), start
//                            or join the thread's reply clock, alert at once
//                            if a safety net applies, acknowledge (held until
//                            the wording is approved), end c42 chases.
//   recordOutboundMessage()  the firm wrote: a HUMAN reply stops the clock
//                            (the auto-ack and AI messages never do); a
//                            message that expects a reply starts c42.
//   processReplyClocks()     worker: the 24h/12h flag and the 48h/24h promise
//                            checkpoints, plus the unacknowledged safety-net
//                            re-alert.
//   changeClockTier()        staff re-tag (c44 §4.9): replanned from the
//                            ORIGINAL start; logged with a reason.
//   closeClock()             "no reply needed", with a reason (c43 rule 9).
//
// The AI never answers the client. Flags here are INTERNAL ONLY.

import { and, asc, eq, inArray, isNull, lte, or } from "drizzle-orm";
import { matterParties } from "@/db/schema";
import { flags } from "@/db/tables/foundation";
import { clientMessages, replyClocks } from "@/db/tables/calendar-alerts";
import type { TenantTx } from "@/tenancy/withTenant";
import { NOTIFY_COPY_GATES } from "@/compliance/gates";
import { audit, SYSTEM_ACTOR, type Actor } from "@/core/audit";
import { toBusinessCalendar } from "@/core/firmSettings";
import { cancelTask, changeTaskDue, completeTask, createTask, getTask } from "@/core/tasks";
import { escalateFlag } from "@/core/flags";
import {
  AlertRuleError,
  backupFor,
  getMatter,
  loadPeople,
  notifyClient,
  raiseAlert,
  responsibleLawyer,
  type EngineContext,
  type MatterInfo,
} from "../common";
import { ALERT_COPY_GATES } from "../gates";
import { FLAG_TYPES, TASK_KINDS } from "../kinds";
import { ENGINE } from "../settings";
import { detectUrgentSafety, extractClientStatedDates } from "../deadline/classify";
import { loadDeadlineContext, type DeadlineContext } from "../deadline/context";
import { tagMessage, type CombinedTag } from "../deadline/model";
import { onClientReply, resumeHelpPausedLadders, startClientReplyRequest } from "../ladder/service";
import { composeAcknowledgement } from "./ack";
import {
  checkpointDue,
  formatReplyBy,
  immediateReasonText,
  planReplyClock,
  replyFlagRecipients,
  type ClockPlan,
  type ClockTier,
  type RelevantDeadline,
} from "./plan";

export type MessageRow = typeof clientMessages.$inferSelect;
export type ReplyClockRow = typeof replyClocks.$inferSelect;

export const MESSAGE_CHANNELS = ["portal", "email", "sms", "phone_log"] as const;
export type MessageChannel = (typeof MESSAGE_CHANNELS)[number];

const DEFAULT_THREAD = "main";

// ---------------------------------------------------------------------------
// Who may be written to / heard from
// ---------------------------------------------------------------------------

/** The party must be the firm's own client on this matter — never the opposing party (README gap 4). */
export async function assertClientOfMatter(tx: TenantTx, tenantId: string, matter: MatterInfo, partyId: string): Promise<void> {
  if (matter.primaryPartyId === partyId) return;
  const [row] = await tx
    .select({ id: matterParties.id })
    .from(matterParties)
    .where(
      and(
        eq(matterParties.tenantId, tenantId),
        eq(matterParties.matterId, matter.id),
        eq(matterParties.partyId, partyId),
        inArray(matterParties.role, ["client", "caller"]),
        isNull(matterParties.endedAt)
      )
    )
    .limit(1);
  if (!row) throw new AlertRuleError("That person is not a client on this matter.", 422);
}

// ---------------------------------------------------------------------------
// Inbound
// ---------------------------------------------------------------------------

export interface InboundInput {
  tenantId: string;
  matterId: string;
  partyId: string;
  channel: MessageChannel;
  body: string;
  occurredAt: Date;
  threadKey?: string;
  /** Out-of-office / auto-submitted mail: logged, never a reply and never starts a clock. */
  autoSubmitted?: boolean;
  /** The triage classifier's safety flag (c35/c66), OR-ed with the conservative rules here. */
  classifierSafety?: boolean;
  /** A reply to a client update (c54 → c43). */
  inReplyToUpdateId?: string | null;
  /** Staff logging a phone call record who logged it. */
  loggedBy?: Actor;
}

export interface InboundResult {
  message: MessageRow;
  clock: ReplyClockRow | null;
  clockStarted: boolean;
  tag: CombinedTag | null;
  immediateFlagId: string | null;
  ack: { messageId: string; delivered: boolean; heldBecause: string[] } | null;
}

export async function recordInboundMessage(tx: TenantTx, ctx: EngineContext, input: InboundInput): Promise<InboundResult> {
  const body = input.body?.trim();
  if (!body) throw new AlertRuleError("The message is empty.");
  const matter = await getMatter(tx, input.tenantId, input.matterId);
  await assertClientOfMatter(tx, input.tenantId, matter, input.partyId);
  const threadKey = input.threadKey?.trim() || DEFAULT_THREAD;
  const now = input.occurredAt;

  if (input.autoSubmitted) {
    const [message] = await tx
      .insert(clientMessages)
      .values({
        tenantId: input.tenantId,
        matterId: matter.id,
        threadKey,
        direction: "inbound",
        senderType: "client",
        senderPartyId: input.partyId,
        clientPartyId: input.partyId,
        channel: input.channel,
        body,
        autoSubmitted: true,
        occurredAt: now,
      })
      .returning();
    await audit(tx, { tenantId: input.tenantId, engine: ENGINE, action: "client_message.auto_submitted", entityType: "client_message", entityId: message!.id, matterId: matter.id });
    return { message: message!, clock: null, clockStarted: false, tag: null, immediateFlagId: null, ack: null };
  }

  // 1. Tag: safety (conservative rules OR the classifier) and deadline (rules, gated AI, calendar proximity).
  const safety = detectUrgentSafety(body);
  const safetyUrgent = safety.urgent || Boolean(input.classifierSafety);
  const deadlines = await loadDeadlineContext(tx, input.tenantId, matter.id, now, ctx.alerts.deadlineLookaheadDays);
  const tagged = await tagMessage(body, {
    tenantId: input.tenantId,
    aiMinConfidence: ctx.alerts.aiDeadlineMinConfidence,
    calendarProximity: deadlines.relevant.length > 0,
  });
  const stated = extractClientStatedDates(body, now, ctx.firm.timeZone);
  const tier: ClockTier = tagged.combined.deadlineRelated ? "deadline" : "standard";

  const [message] = await tx
    .insert(clientMessages)
    .values({
      tenantId: input.tenantId,
      matterId: matter.id,
      threadKey,
      direction: "inbound",
      senderType: "client",
      senderPartyId: input.partyId,
      clientPartyId: input.partyId,
      channel: input.channel,
      body,
      deadlineRelated: tagged.combined.deadlineRelated,
      deadlineTagSource: tagged.combined.source,
      deadlineTagDetail: { ...tagged.combined.detail, ai: tagged.ai.status, appliedBecauseUnsure: tagged.combined.appliedBecauseUnsure, safetyMatches: safety.matched },
      clientStatedEventAt: stated[0]?.at ?? null,
      urgent: safetyUrgent,
      inReplyToUpdateId: input.inReplyToUpdateId ?? null,
      occurredAt: now,
    })
    .returning();
  const msg = message!;
  await audit(tx, {
    tenantId: input.tenantId,
    engine: ENGINE,
    action: "client_message.received",
    entityType: "client_message",
    entityId: msg.id,
    matterId: matter.id,
    actor: input.loggedBy ?? { type: "client", partyId: input.partyId },
    payload: { channel: input.channel, tier, tagSource: tagged.combined.source, urgent: safetyUrgent, aiTag: tagged.ai.status },
  });

  // 2. The client replied: any c42 chase on the matter ends.
  await onClientReply(tx, { tenantId: input.tenantId, matterId: matter.id, partyId: input.partyId, at: now });

  // 3. Start or join the thread's clock (one open clock per thread, from the earliest unanswered message).
  const relevant: RelevantDeadline[] = [
    ...deadlines.relevant,
    ...stated.map((d) => ({ at: d.at, source: "client_stated" as const, title: `Date mentioned by the client: "${d.snippet}" (not verified)` })),
  ];
  const existing = await openClock(tx, input.tenantId, matter.id, threadKey);
  let clock: ReplyClockRow;
  let started = false;
  let plan: ClockPlan;
  if (existing) {
    const upgrade = existing.tier === "standard" && tier === "deadline";
    plan = planReplyClock({
      startedAt: existing.startedAt,
      tier: upgrade ? "deadline" : (existing.tier as ClockTier),
      settings: { ...ctx.firm, ...snapshotHours(existing, upgrade ? null : existing.tier as ClockTier) },
      calendar: toBusinessCalendar(ctx.firm),
      deadlines: relevant,
      safetyUrgent,
      now,
    });
    const [row] = await tx
      .update(replyClocks)
      .set({
        messageCount: existing.messageCount + 1,
        updatedAt: now,
        ...(upgrade
          ? { tier: "deadline", flagHours: plan.flagHours, promiseHours: plan.promiseHours, flagAt: plan.flagAt, promiseAt: plan.promiseAt }
          : {}),
        ...earliestDeadlineColumns(existing, plan.earliestDeadline),
      })
      .where(and(eq(replyClocks.tenantId, input.tenantId), eq(replyClocks.id, existing.id)))
      .returning();
    clock = row!;
    if (upgrade) {
      if (clock.taskId) {
        const t = await getTask(tx, input.tenantId, clock.taskId);
        if (t?.status === "open") {
          await changeTaskDue(tx, { tenantId: input.tenantId, taskId: t.id, dueAt: plan.flagAt, by: SYSTEM_ACTOR, reason: "A follow-up message is about a deadline: the stricter c44 clock applies from the first message", engine: ENGINE });
        }
      }
      await audit(tx, { tenantId: input.tenantId, engine: ENGINE, action: "reply_clock.tier_changed", entityType: "reply_clock", entityId: clock.id, matterId: matter.id, reason: "Follow-up message tagged as a deadline question", payload: { from: "standard", to: "deadline", messageId: msg.id } });
    }
  } else {
    plan = planReplyClock({ startedAt: now, tier, settings: ctx.firm, calendar: toBusinessCalendar(ctx.firm), deadlines: relevant, safetyUrgent, now });
    const lawyer = await responsibleLawyer(tx, input.tenantId, matter);
    const task = await createTask(
      tx,
      {
        tenantId: input.tenantId,
        kind: TASK_KINDS.firmReplyDue,
        title: tier === "deadline" ? "Reply to the client's question about a deadline" : "Reply to the client's message",
        description: tier === "deadline" ? "The client asked about a date or deadline. Only a lawyer answers this; the automatic acknowledgement does not." : null,
        owner: lawyer ? { type: "user", userId: lawyer } : { type: "firm" },
        due: { at: plan.flagAt, clock: "business" },
        matterId: matter.id,
        sourceCard: tier === "deadline" ? "c44" : "c43",
        sourceRef: `client_message:${msg.id}`,
        metadata: { messageId: msg.id, promiseAt: plan.promiseAt.toISOString(), tier },
        engine: ENGINE,
      },
      { now, calendar: toBusinessCalendar(ctx.firm) }
    );
    const [row] = await tx
      .insert(replyClocks)
      .values({
        tenantId: input.tenantId,
        matterId: matter.id,
        threadKey,
        firstMessageId: msg.id,
        taskId: task.id,
        tier,
        startedAt: now,
        flagHours: plan.flagHours,
        promiseHours: plan.promiseHours,
        flagAt: plan.flagAt,
        promiseAt: plan.promiseAt,
        earliestDeadlineAt: plan.earliestDeadline?.at ?? null,
        earliestDeadlineSource: plan.earliestDeadline?.source ?? null,
      })
      .returning();
    clock = row!;
    started = true;
    await audit(tx, {
      tenantId: input.tenantId,
      engine: ENGINE,
      action: "reply_clock.started",
      entityType: "reply_clock",
      entityId: clock.id,
      matterId: matter.id,
      payload: { tier, flagAt: plan.flagAt.toISOString(), promiseAt: plan.promiseAt.toISOString(), taskId: task.id },
    });
  }

  // 4. Safety nets on the REAL clock (c43 rule 8, c44 §4.4): alert the lawyer now.
  let immediateFlagId: string | null = null;
  if (plan.immediate && !clock.immediateAlertAt) {
    immediateFlagId = await raiseImmediate(tx, ctx, { clock, matter, plan, deadlines, messageId: msg.id, now });
  }

  // 5. Acknowledge a NEW clock (c43 rule 6). Held until the wording is approved.
  let ack: InboundResult["ack"] = null;
  if (started) {
    const imminentAt = stated[0]?.at;
    const plannedAck = composeAcknowledgement({
      tier: clock.tier as ClockTier,
      promiseAt: clock.promiseAt,
      timeZone: ctx.firm.timeZone,
      imminent: Boolean(imminentAt && imminentAt.getTime() - now.getTime() <= ctx.alerts.imminentEventRealHours * 3_600_000),
      firmPhone: ctx.alerts.firmPhone,
    });
    const [ackRow] = await tx
      .insert(clientMessages)
      .values({
        tenantId: input.tenantId,
        matterId: matter.id,
        threadKey,
        direction: "outbound",
        senderType: "system",
        clientPartyId: input.partyId,
        channel: "portal",
        body: plannedAck.text,
        isAutoAck: true,
        inReplyToMessageId: msg.id,
        deliveryState: plannedAck.deliverable ? "delivered" : "held",
        occurredAt: now,
      })
      .returning();
    if (plannedAck.deliverable) {
      await notifyClient(tx, ctx, {
        tenantId: input.tenantId,
        partyId: input.partyId,
        matterId: matter.id,
        templateKey: ALERT_COPY_GATES.ackNotice.key,
        payload: {},
        dedupeKey: `calendar-alerts.ack:${ackRow!.id}`,
        now,
      });
    }
    await audit(tx, {
      tenantId: input.tenantId,
      engine: ENGINE,
      action: plannedAck.deliverable ? "client_message.ack_sent" : "client_message.ack_held",
      entityType: "client_message",
      entityId: ackRow!.id,
      matterId: matter.id,
      payload: { replyBy: plannedAck.replyBy, heldBecause: plannedAck.heldBecause },
    });
    ack = { messageId: ackRow!.id, delivered: plannedAck.deliverable, heldBecause: plannedAck.heldBecause };
  }

  return { message: msg, clock, clockStarted: started, tag: tagged.combined, immediateFlagId, ack };
}

function snapshotHours(clock: ReplyClockRow, tier: ClockTier | null) {
  // Open clocks keep their original numbers (c43 §4 edge case): reuse the snapshot for the clock's own tier.
  if (tier === "standard") return { firmReplyHours: clock.flagHours, clientPromiseHours: clock.promiseHours };
  if (tier === "deadline") return { deadlineQuestionFlagHours: clock.flagHours, deadlineQuestionReplyHours: clock.promiseHours };
  return {};
}

function earliestDeadlineColumns(clock: ReplyClockRow, d: RelevantDeadline | null) {
  if (!d) return {};
  if (clock.earliestDeadlineAt && clock.earliestDeadlineAt.getTime() <= d.at.getTime()) return {};
  return { earliestDeadlineAt: d.at, earliestDeadlineSource: d.source };
}

async function openClock(tx: TenantTx, tenantId: string, matterId: string, threadKey: string): Promise<ReplyClockRow | undefined> {
  const [row] = await tx
    .select()
    .from(replyClocks)
    .where(and(eq(replyClocks.tenantId, tenantId), eq(replyClocks.matterId, matterId), eq(replyClocks.threadKey, threadKey), eq(replyClocks.status, "open")))
    .limit(1)
    .for("update");
  return row;
}

async function raiseImmediate(
  tx: TenantTx,
  ctx: EngineContext,
  input: { clock: ReplyClockRow; matter: MatterInfo; plan: ClockPlan; deadlines: DeadlineContext; messageId: string; now: Date }
): Promise<string | null> {
  const { clock, matter, plan, now } = input;
  const immediate = plan.immediate!;
  const people = await loadPeople(tx, clock.tenantId, ctx.alerts);
  const lawyer = await responsibleLawyer(tx, clock.tenantId, matter);
  const backup = await backupFor(tx, clock.tenantId, ctx.alerts, lawyer);
  const recipients = replyFlagRecipients({ tier: clock.tier as ClockTier, step: "immediate", lawyerId: lawyer, backupId: backup, adminIds: people.admins, managingIds: people.managing });
  if (recipients.length === 0) return null; // no active firm user at all: nothing to address (logged below)
  const res = await raiseAlert(
    tx,
    ctx,
    {
      tenantId: clock.tenantId,
      type: FLAG_TYPES.replyUrgent,
      severity: "critical",
      urgent: true,
      audience: "internal",
      title: immediate.reason === "safety" ? "Client message may involve a safety concern" : "Client question about a deadline needs an answer now",
      summary: `${immediateReasonText(immediate.reason, immediate.deadline, ctx.firm.timeZone)} Reply promised by ${formatReplyBy(clock.promiseAt, ctx.firm.timeZone)}. Do not rely on the automatic acknowledgement; it does not answer the client.`,
      // c44 §4.6: the matter's relevant calendar entries travel with the alert (internal only).
      details: {
        reason: immediate.reason,
        clockId: clock.id,
        messageId: input.messageId,
        confirmed: input.deadlines.confirmed.map((e) => ({ id: e.id, title: e.title, eventType: e.eventType, startsAt: e.startsAt.toISOString() })),
        unconfirmed: input.deadlines.unconfirmed.map((e) => ({ id: e.id, title: e.title, startsAt: e.startsAt.toISOString(), label: "unconfirmed" })),
      },
      matterId: matter.id,
      taskId: clock.taskId,
      recipients: { userIds: recipients },
      dedupeKey: `${FLAG_TYPES.replyUrgent}:${clock.id}`,
      sourceCard: clock.tier === "deadline" ? "c44" : "c43",
    },
    now
  );
  await tx
    .update(replyClocks)
    .set({ immediateAlertAt: now, immediateAlertReason: immediate.reason, immediateFlagId: res.flag.id, updatedAt: now })
    .where(and(eq(replyClocks.tenantId, clock.tenantId), eq(replyClocks.id, clock.id)));
  return res.flag.id;
}

// ---------------------------------------------------------------------------
// Outbound
// ---------------------------------------------------------------------------

export interface OutboundInput {
  tenantId: string;
  matterId: string;
  partyId: string;
  channel: MessageChannel;
  body: string;
  occurredAt: Date;
  threadKey?: string;
  /** A human user (stops the clock) or the AI/system (never stops it). */
  sender: { type: "user"; userId: string } | { type: "ai" } | { type: "system" };
  /** c42: the firm expects a reply; per-message window override in business hours. */
  expectsReply?: boolean;
  replyWindowHours?: number | null;
  relatedCalendarEventId?: string | null;
}

export interface OutboundResult {
  message: MessageRow;
  clockStopped: ReplyClockRow | null;
  replyRequestTaskId: string | null;
}

export async function recordOutboundMessage(tx: TenantTx, ctx: EngineContext, input: OutboundInput): Promise<OutboundResult> {
  const body = input.body?.trim();
  if (!body) throw new AlertRuleError("The message is empty.");
  if (input.replyWindowHours !== undefined && input.replyWindowHours !== null && !(Number.isInteger(input.replyWindowHours) && input.replyWindowHours > 0)) {
    throw new AlertRuleError("The response window must be a whole number of business hours above zero.");
  }
  const matter = await getMatter(tx, input.tenantId, input.matterId);
  await assertClientOfMatter(tx, input.tenantId, matter, input.partyId);
  const threadKey = input.threadKey?.trim() || DEFAULT_THREAD;
  const now = input.occurredAt;
  const human = input.sender.type === "user";

  const [message] = await tx
    .insert(clientMessages)
    .values({
      tenantId: input.tenantId,
      matterId: matter.id,
      threadKey,
      direction: "outbound",
      senderType: input.sender.type,
      senderUserId: input.sender.type === "user" ? input.sender.userId : null,
      clientPartyId: input.partyId,
      channel: input.channel,
      body,
      expectsReply: Boolean(input.expectsReply),
      replyWindowHours: input.replyWindowHours ?? null,
      relatedCalendarEventId: input.relatedCalendarEventId ?? null,
      deliveryState: input.channel === "phone_log" ? "logged" : "delivered",
      occurredAt: now,
    })
    .returning();
  const msg = message!;
  const actor: Actor = input.sender.type === "user" ? { type: "user", userId: input.sender.userId } : input.sender.type === "ai" ? { type: "ai" } : SYSTEM_ACTOR;
  await audit(tx, { tenantId: input.tenantId, engine: ENGINE, action: "client_message.sent", entityType: "client_message", entityId: msg.id, matterId: matter.id, actor, payload: { channel: input.channel, expectsReply: msg.expectsReply, human } });

  // Only a real reply from a person stops the clock (c43 rule 5).
  let stopped: ReplyClockRow | null = null;
  if (human) {
    stopped = await stopClock(tx, { tenantId: input.tenantId, matterId: matter.id, threadKey, by: actor, status: "replied", reason: "Replied to the client", now });
    await resumeHelpPausedLadders(tx, ctx, { tenantId: input.tenantId, matterId: matter.id, now });
  }

  // The client is told there is a new message in the portal (minimal content, c51).
  if (input.channel === "portal") {
    await notifyClient(tx, ctx, {
      tenantId: input.tenantId,
      partyId: input.partyId,
      matterId: matter.id,
      templateKey: NOTIFY_COPY_GATES.genericUpdate.key,
      payload: {},
      dedupeKey: `calendar-alerts.message:${msg.id}`,
      now,
    });
  }

  let replyRequestTaskId: string | null = null;
  if (msg.expectsReply) {
    const task = await startClientReplyRequest(tx, ctx, {
      tenantId: input.tenantId,
      matterId: matter.id,
      messageId: msg.id,
      partyId: input.partyId,
      sentAt: now,
      windowHours: input.replyWindowHours,
      relatedCalendarEventId: input.relatedCalendarEventId,
      by: actor,
    });
    replyRequestTaskId = task.id;
  }
  return { message: msg, clockStopped: stopped, replyRequestTaskId };
}

async function stopClock(
  tx: TenantTx,
  input: { tenantId: string; matterId: string; threadKey: string; by: Actor; status: "replied" | "closed"; reason: string; now: Date; clockId?: string }
): Promise<ReplyClockRow | null> {
  const clock = input.clockId
    ? (await tx.select().from(replyClocks).where(and(eq(replyClocks.tenantId, input.tenantId), eq(replyClocks.id, input.clockId))).limit(1))[0]
    : await openClock(tx, input.tenantId, input.matterId, input.threadKey);
  if (!clock || clock.status !== "open") return null;
  const [row] = await tx
    .update(replyClocks)
    .set({
      status: input.status,
      closedAt: input.now,
      closedByUserId: input.by.type === "user" ? input.by.userId : null,
      closeReason: input.reason,
      updatedAt: input.now,
    })
    .where(and(eq(replyClocks.tenantId, input.tenantId), eq(replyClocks.id, clock.id)))
    .returning();
  if (clock.taskId) {
    const task = await getTask(tx, input.tenantId, clock.taskId);
    if (task?.status === "open") {
      if (input.status === "replied") await completeTask(tx, { tenantId: input.tenantId, taskId: task.id, by: input.by, reason: input.reason, engine: ENGINE, at: input.now });
      else await cancelTask(tx, { tenantId: input.tenantId, taskId: task.id, by: input.by, reason: input.reason, engine: ENGINE });
    }
  }
  await audit(tx, {
    tenantId: input.tenantId,
    engine: ENGINE,
    action: input.status === "replied" ? "reply_clock.replied" : "reply_clock.closed",
    entityType: "reply_clock",
    entityId: clock.id,
    matterId: clock.matterId,
    actor: input.by,
    reason: input.reason,
    payload: { promiseMissed: clock.promiseMissedAt !== null, flagged: clock.flaggedAt !== null },
  });
  return row ?? null;
}

/** "No reply needed" (e.g. the client wrote "thanks!"). Reason required and logged (c43 rule 9). */
export async function closeClock(tx: TenantTx, input: { tenantId: string; clockId: string; userId: string; reason: string; now: Date }): Promise<ReplyClockRow> {
  const reason = input.reason?.trim();
  if (!reason) throw new AlertRuleError("A reason is required to close a reply clock without replying.");
  const row = await stopClock(tx, { tenantId: input.tenantId, matterId: "", threadKey: "", clockId: input.clockId, by: { type: "user", userId: input.userId }, status: "closed", reason: `No reply needed: ${reason}`, now: input.now });
  if (!row) throw new AlertRuleError("Open reply clock not found.", 404);
  return row;
}

/** Staff re-tag (c44 §4.9): replanned from the ORIGINAL start time; logged. */
export async function changeClockTier(
  tx: TenantTx,
  ctx: EngineContext,
  input: { tenantId: string; clockId: string; tier: ClockTier; userId: string; reason: string; now: Date }
): Promise<ReplyClockRow> {
  const reason = input.reason?.trim();
  if (!reason) throw new AlertRuleError("A reason is required to re-tag a message.");
  const [clock] = await tx
    .select()
    .from(replyClocks)
    .where(and(eq(replyClocks.tenantId, input.tenantId), eq(replyClocks.id, input.clockId), eq(replyClocks.status, "open")))
    .limit(1)
    .for("update");
  if (!clock) throw new AlertRuleError("Open reply clock not found.", 404);
  if (clock.tier === input.tier) return clock;
  const plan = planReplyClock({ startedAt: clock.startedAt, tier: input.tier, settings: ctx.firm, calendar: toBusinessCalendar(ctx.firm), deadlines: [], safetyUrgent: false, now: input.now });
  const [row] = await tx
    .update(replyClocks)
    .set({
      tier: input.tier,
      flagHours: plan.flagHours,
      promiseHours: plan.promiseHours,
      flagAt: plan.flagAt,
      promiseAt: plan.promiseAt,
      // A checkpoint that has not fired yet is recomputed; one that already fired stays recorded.
      updatedAt: input.now,
    })
    .where(and(eq(replyClocks.tenantId, input.tenantId), eq(replyClocks.id, clock.id)))
    .returning();
  const by: Actor = { type: "user", userId: input.userId };
  if (clock.taskId) {
    const t = await getTask(tx, input.tenantId, clock.taskId);
    if (t?.status === "open") await changeTaskDue(tx, { tenantId: input.tenantId, taskId: t.id, dueAt: plan.flagAt, by, reason: `Re-tagged ${clock.tier} → ${input.tier}: ${reason}`, engine: ENGINE });
  }
  await audit(tx, { tenantId: input.tenantId, engine: ENGINE, action: "reply_clock.tier_changed", entityType: "reply_clock", entityId: clock.id, matterId: clock.matterId, actor: by, reason, payload: { from: clock.tier, to: input.tier, source: "staff" } });
  return row!;
}

// ---------------------------------------------------------------------------
// Worker: checkpoints
// ---------------------------------------------------------------------------

export async function processReplyClocks(tx: TenantTx, ctx: EngineContext, tenantId: string, now: Date): Promise<{ flagged: number; promisesMissed: number; reAlerted: number }> {
  const due = await tx
    .select()
    .from(replyClocks)
    .where(
      and(
        eq(replyClocks.tenantId, tenantId),
        eq(replyClocks.status, "open"),
        or(and(isNull(replyClocks.flaggedAt), lte(replyClocks.flagAt, now)), and(isNull(replyClocks.promiseMissedAt), lte(replyClocks.promiseAt, now)))
      )
    )
    .orderBy(asc(replyClocks.flagAt))
    .limit(200)
    .for("update", { skipLocked: true });
  let flagged = 0;
  let promisesMissed = 0;
  for (const clock of due) {
    const matter = await getMatter(tx, tenantId, clock.matterId);
    const people = await loadPeople(tx, tenantId, ctx.alerts);
    const lawyer = await responsibleLawyer(tx, tenantId, matter);
    const tier = clock.tier as ClockTier;
    const tz = ctx.firm.timeZone;
    let flagId: string | null = null;
    if (checkpointDue(clock, "flag", now)) {
      const recipients = replyFlagRecipients({ tier, step: "flag", lawyerId: lawyer, adminIds: people.admins, managingIds: people.managing });
      if (recipients.length > 0) {
        const res = await raiseAlert(
          tx,
          ctx,
          {
            tenantId,
            type: FLAG_TYPES.replyOverdue,
            severity: tier === "deadline" ? "high" : "warning",
            urgent: tier === "deadline",
            audience: "internal",
            title: tier === "deadline" ? "Client's deadline question has not been answered" : "Client message has not been answered",
            summary:
              `The internal reply target (${clock.flagHours} business hours) has passed. The client was promised a reply by ${formatReplyBy(clock.promiseAt, tz)}.` +
              (lawyer ? "" : " No responsible lawyer is assigned."),
            details: { clockId: clock.id, step: "flag", firstMessageId: clock.firstMessageId },
            matterId: clock.matterId,
            taskId: clock.taskId,
            recipients: { userIds: recipients },
            dedupeKey: `${FLAG_TYPES.replyOverdue}:${clock.id}`,
            sourceCard: tier === "deadline" ? "c44" : "c43",
          },
          now
        );
        flagId = res.flag.id;
      }
      await tx.update(replyClocks).set({ flaggedAt: now, updatedAt: now }).where(and(eq(replyClocks.tenantId, tenantId), eq(replyClocks.id, clock.id)));
      await audit(tx, { tenantId, engine: ENGINE, action: "reply_clock.flagged", entityType: "reply_clock", entityId: clock.id, matterId: clock.matterId, payload: { tier, recipients: recipients.length } });
      flagged++;
    }
    if (checkpointDue(clock, "promise", now)) {
      const recipients = replyFlagRecipients({ tier, step: "promise", lawyerId: lawyer, adminIds: people.admins, managingIds: people.managing });
      const summary = `The reply promised to the client by ${formatReplyBy(clock.promiseAt, tz)} has been missed. The client is not told; please reply now.`;
      const open = flagId ?? (await openFlagId(tx, tenantId, `${FLAG_TYPES.replyOverdue}:${clock.id}`));
      if (open) {
        await escalateFlag(tx, { tenantId, flagId: open, addUserIds: recipients, severity: tier === "deadline" ? "critical" : "high", note: summary, engine: ENGINE, at: now });
      } else if (recipients.length > 0) {
        await raiseAlert(
          tx,
          ctx,
          {
            tenantId,
            type: FLAG_TYPES.replyOverdue,
            severity: tier === "deadline" ? "critical" : "high",
            urgent: tier === "deadline",
            audience: "internal",
            title: "Reply promised to the client was missed",
            summary,
            details: { clockId: clock.id, step: "promise" },
            matterId: clock.matterId,
            taskId: clock.taskId,
            recipients: { userIds: recipients },
            dedupeKey: `${FLAG_TYPES.replyOverdue}:${clock.id}`,
            sourceCard: tier === "deadline" ? "c44" : "c43",
          },
          now
        );
      }
      await tx.update(replyClocks).set({ promiseMissedAt: now, updatedAt: now }).where(and(eq(replyClocks.tenantId, tenantId), eq(replyClocks.id, clock.id)));
      await audit(tx, { tenantId, engine: ENGINE, action: "reply_clock.promise_missed", entityType: "reply_clock", entityId: clock.id, matterId: clock.matterId, payload: { tier } });
      promisesMissed++;
    }
  }
  const reAlerted = await reAlertUnacknowledged(tx, ctx, tenantId, now);
  return { flagged, promisesMissed, reAlerted };
}

async function openFlagId(tx: TenantTx, tenantId: string, dedupeKey: string): Promise<string | null> {
  const [row] = await tx
    .select({ id: flags.id })
    .from(flags)
    .where(and(eq(flags.tenantId, tenantId), eq(flags.dedupeKey, dedupeKey), isNull(flags.resolvedAt)))
    .limit(1);
  return row?.id ?? null;
}

/** c44 safety net: an immediate alert nobody acknowledged is re-sent to the firm admin (real clock). */
async function reAlertUnacknowledged(tx: TenantTx, ctx: EngineContext, tenantId: string, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - ctx.alerts.safetyNetReAlertMinutes * 60_000);
  const rows = await tx
    .select({ flag: flags })
    .from(replyClocks)
    .innerJoin(flags, eq(flags.id, replyClocks.immediateFlagId))
    .where(
      and(
        eq(replyClocks.tenantId, tenantId),
        eq(replyClocks.status, "open"),
        isNull(flags.resolvedAt),
        isNull(flags.acknowledgedAt),
        eq(flags.escalationLevel, 0),
        lte(flags.createdAt, cutoff)
      )
    )
    .limit(100);
  if (rows.length === 0) return 0;
  const people = await loadPeople(tx, tenantId, ctx.alerts);
  for (const { flag } of rows) {
    await escalateFlag(tx, {
      tenantId,
      flagId: flag.id,
      addUserIds: [...people.admins, ...people.managing],
      severity: "critical",
      note: `Not acknowledged within ${ctx.alerts.safetyNetReAlertMinutes} minutes.`,
      engine: ENGINE,
      at: now,
    });
  }
  return rows.length;
}

// ---------------------------------------------------------------------------
// Reads (staff only)
// ---------------------------------------------------------------------------

export async function listOpenClocks(tx: TenantTx, tenantId: string, filter: { matterId?: string } = {}): Promise<ReplyClockRow[]> {
  const conds = [eq(replyClocks.tenantId, tenantId), eq(replyClocks.status, "open")];
  if (filter.matterId) conds.push(eq(replyClocks.matterId, filter.matterId));
  return tx.select().from(replyClocks).where(and(...conds)).orderBy(asc(replyClocks.promiseAt)).limit(500);
}

/** The matter's message thread for staff (internal tags included). Oldest first. */
export async function listMatterMessages(tx: TenantTx, tenantId: string, matterId: string, limit = 200): Promise<MessageRow[]> {
  return tx
    .select()
    .from(clientMessages)
    .where(and(eq(clientMessages.tenantId, tenantId), eq(clientMessages.matterId, matterId)))
    .orderBy(asc(clientMessages.occurredAt))
    .limit(limit);
}

/** What the client may see of the thread: no held auto-acks, no internal tags. */
export interface ClientMessageView {
  id: string;
  direction: string;
  fromFirm: boolean;
  body: string;
  occurredAt: Date;
}

export function toClientThread(rows: readonly MessageRow[], partyId: string): ClientMessageView[] {
  return rows
    .filter((m) => m.clientPartyId === partyId && m.deliveryState !== "held" && m.channel !== "phone_log")
    .map((m) => ({ id: m.id, direction: m.direction, fromFirm: m.direction === "outbound", body: m.body, occurredAt: m.occurredAt }));
}

