// c66 — emergencies go to a live person immediately (database operations).
//
// Real clock throughout (never business hours). Staff alerts carry minimal
// content: category, channel and a pointer — no case narrative (c66 rule 9).
// Nothing here is ever shown to the prospective client; client-facing
// replies (911 message, safe-contact question) are gated copy chosen by the
// channel pipeline.

import { and, desc, eq, isNull } from "drizzle-orm";
import { parties } from "@/db/schema";
import { intakeConsents, intakeEmergencyAlerts, intakeOnCallRota } from "@/db/tables/intake";
import type { TenantTx } from "@/tenancy/withTenant";
import { acknowledgeFlag, escalateFlag, raiseFlag, resolveFlag } from "@/core/flags";
import type { SafeContactPreferences } from "@/db/types";
import { listActiveUsersByRole, requireStaff, resolveEscalationContacts, STAFF_ROLES, userActor } from "../common/actors";
import { loadIntakeContext, type IntakeContext } from "../common/context";
import { IntakeNotFoundError, IntakeRuleError, IntakeValidationError, requireReason } from "../common/errors";
import { recordIntakeEvent } from "../common/events";
import { cancelScheduledTasks, INTAKE_TASK_TYPES, payloadString, scheduleTask } from "../common/scheduling";
import { getMatter, getSessionBundle, updateState } from "../common/sessions";
import { addMinutes, addHours } from "../common/time";
import type { ScheduledTaskRow } from "@/worker/hooks";
import { INTAKE_ENGINE } from "../settings";
import { bypassSpeedToLeadForEmergency } from "../speedToLead/service";
import { detectionsByTrack, type Detection, type EmergencyTrack } from "./detect";
import { escalationStep, findCoverageGaps, onCallAt, type RotaShift } from "./rota";

export type EmergencyAlertRow = typeof intakeEmergencyAlerts.$inferSelect;

async function loadRota(tx: TenantTx, tenantId: string): Promise<RotaShift[]> {
  const rows = await tx
    .select()
    .from(intakeOnCallRota)
    .where(and(eq(intakeOnCallRota.tenantId, tenantId), eq(intakeOnCallRota.active, true)));
  return rows.map((r) => ({ ...r, role: r.role as RotaShift["role"] }));
}

async function openAlertFor(tx: TenantTx, tenantId: string, sessionId: string, track: EmergencyTrack): Promise<EmergencyAlertRow | undefined> {
  const [row] = await tx
    .select()
    .from(intakeEmergencyAlerts)
    .where(
      and(
        eq(intakeEmergencyAlerts.tenantId, tenantId),
        eq(intakeEmergencyAlerts.intakeSessionId, sessionId),
        eq(intakeEmergencyAlerts.track, track),
        isNull(intakeEmergencyAlerts.acknowledgedAt),
        isNull(intakeEmergencyAlerts.downgradedAt)
      )
    )
    .orderBy(desc(intakeEmergencyAlerts.raisedAt))
    .limit(1);
  return row;
}

const TRACK_TITLES: Record<EmergencyTrack, string> = {
  safety: "SAFETY EMERGENCY — a prospective client may be in danger",
  urgent_legal: "URGENT — time-sensitive new inquiry needs a lawyer now",
  deadline_risk: "Possible deadline risk on a new inquiry (lawyer review)",
};

export interface RaisedEmergency {
  track: EmergencyTrack;
  alertId: string;
  created: boolean;
  pagedUserIds: string[];
}

/**
 * Handle detections for one inbound message. One open alert per session and
 * track: repeated messages do not re-page, they are logged. Safety and
 * urgent-legal alerts page on the real clock and schedule escalation;
 * deadline-risk goes to a lawyer only, with no client-facing statement.
 */
export async function raiseEmergency(
  tx: TenantTx,
  input: { tenantId: string; intakeSessionId: string; detections: Detection[]; listApproved: boolean; now?: Date }
): Promise<RaisedEmergency[]> {
  const now = input.now ?? new Date();
  const ctx = await loadIntakeContext(tx, input.tenantId);
  const { session, state } = await getSessionBundle(tx, input.tenantId, input.intakeSessionId);
  const out: RaisedEmergency[] = [];

  for (const group of detectionsByTrack(input.detections)) {
    const primary = group.detections[0]!;
    const existing = await openAlertFor(tx, input.tenantId, session.id, group.track);
    if (existing) {
      await recordIntakeEvent(tx, {
        tenantId: input.tenantId,
        intakeSessionId: session.id,
        eventType: "emergency_detected_again",
        ruleName: "emergency_detection",
        payload: { alertId: existing.id, categories: group.detections.map((d) => d.category), listApproved: input.listApproved },
      });
      out.push({ track: group.track, alertId: existing.id, created: false, pagedUserIds: [] });
      continue;
    }

    const [alert] = await tx
      .insert(intakeEmergencyAlerts)
      .values({
        tenantId: input.tenantId,
        intakeSessionId: session.id,
        matterId: session.matterId,
        track: group.track,
        category: primary.category,
        detector: primary.detector,
        matchedPhrase: primary.matchedPhrase,
        raisedAt: now,
      })
      .returning();
    if (!alert) throw new Error("raiseEmergency: insert failed.");

    const paged = await pageFor(tx, ctx, alert, group.track, state.channel, now);
    out.push({ track: group.track, alertId: alert.id, created: true, pagedUserIds: paged });

    if (group.track === "safety") {
      await updateState(tx, input.tenantId, session.id, { safetyFlagged: true, status: "paused_emergency" });
    }
    if (group.track !== "deadline_risk") {
      // c69 rule / c66 rule 7: emergencies leave the speed-to-lead queue.
      await bypassSpeedToLeadForEmergency(tx, { tenantId: input.tenantId, intakeSessionId: session.id, now });
    }
    await recordIntakeEvent(tx, {
      tenantId: input.tenantId,
      intakeSessionId: session.id,
      matterId: session.matterId,
      eventType: "emergency_detected",
      ruleName: `emergency_detection.${input.listApproved ? "approved" : "draft_pending_review"}`,
      firmConfigVersionId: session.firmConfigVersionId,
      entityType: "emergency_alert",
      entityId: alert.id,
      payload: {
        track: group.track,
        categories: group.detections.map((d) => d.category),
        detectors: [...new Set(group.detections.map((d) => d.detector))],
        pagedUserIds: paged,
        listApproved: input.listApproved,
      },
    });
  }
  return out;
}

/** Initial page for a new alert. Returns who was paged. */
async function pageFor(
  tx: TenantTx,
  ctx: IntakeContext,
  alert: EmergencyAlertRow,
  track: EmergencyTrack,
  channel: string,
  now: Date
): Promise<string[]> {
  const { owners } = await resolveEscalationContacts(tx, ctx.tenantId, ctx.settings);
  const rota = await loadRota(tx, ctx.tenantId);
  const onCall = onCallAt(rota, now, ctx.calendar.timeZone);

  if (track === "deadline_risk") {
    // Lawyer only, business clock, no escalation chain (c66 deadline risk §1).
    let lawyers: string[] = [];
    if (alert.matterId) {
      const matter = await getMatter(tx, ctx.tenantId, alert.matterId);
      if (matter.assignedUserId) lawyers = [matter.assignedUserId];
    }
    if (lawyers.length === 0) lawyers = onCall.primary;
    if (lawyers.length === 0) lawyers = (await listActiveUsersByRole(tx, ctx.tenantId, ["attorney"])).map((u) => u.id);
    if (lawyers.length === 0) lawyers = owners;
    if (lawyers.length === 0) return [];
    const { flag } = await raiseFlag(
      tx,
      {
        tenantId: ctx.tenantId,
        type: "intake.deadline_risk",
        severity: "warning",
        audience: "internal",
        title: TRACK_TITLES.deadline_risk,
        summary: `Detected on ${channel}. The assistant has not told the person anything about deadlines; a lawyer should review.`,
        details: { alertId: alert.id, intakeSessionId: alert.intakeSessionId, category: alert.category },
        matterId: alert.matterId,
        recipients: { userIds: lawyers },
        dedupeKey: `intake.deadline_risk:${alert.intakeSessionId}`,
        sourceCard: "c66",
        engine: INTAKE_ENGINE,
      },
      { now }
    );
    await tx.update(intakeEmergencyAlerts).set({ flagId: flag.id, pagedUserIds: lawyers }).where(eq(intakeEmergencyAlerts.id, alert.id));
    return lawyers;
  }

  const step = escalationStep(0, onCall, owners, track);
  if (step.userIds.length === 0) {
    console.error(JSON.stringify({ level: "error", event: "intake.emergency_nobody_to_page", tenantId: ctx.tenantId, alertId: alert.id }));
    return [];
  }
  const { flag } = await raiseFlag(
    tx,
    {
      tenantId: ctx.tenantId,
      type: `intake.emergency_${track}`,
      severity: "critical",
      audience: "internal",
      title: TRACK_TITLES[track],
      summary: `Category: ${alert.category.replace(/_/g, " ")}. Channel: ${channel}. Open the intake console and acknowledge ("I've got this").`,
      details: { alertId: alert.id, intakeSessionId: alert.intakeSessionId, category: alert.category, detector: alert.detector },
      matterId: alert.matterId,
      recipients: { userIds: step.userIds },
      dedupeKey: `intake.emergency:${alert.id}`,
      urgent: true,
      sensitive: true,
      sourceCard: "c66",
      engine: INTAKE_ENGINE,
    },
    { now }
  );
  await tx
    .update(intakeEmergencyAlerts)
    .set({ flagId: flag.id, pagedUserIds: step.userIds, escalationStep: 0 })
    .where(eq(intakeEmergencyAlerts.id, alert.id));
  if (step.rotaGap) await flagRotaGap(tx, ctx, now, owners, "Nobody was on call when an emergency came in; the firm owner/admin was paged instead.");
  await scheduleTask(tx, {
    tenantId: ctx.tenantId,
    taskType: INTAKE_TASK_TYPES.emergencyEscalation,
    dueAt: addMinutes(now, ctx.settings.emergency.ackWindowMinutes),
    intakeSessionId: alert.intakeSessionId,
    matterId: alert.matterId,
    payload: { alertId: alert.id, step: 1 },
  });
  return step.userIds;
}

async function flagRotaGap(tx: TenantTx, ctx: IntakeContext, now: Date, owners: string[], summary: string): Promise<void> {
  if (owners.length === 0) return;
  const day = now.toISOString().slice(0, 10);
  await raiseFlag(
    tx,
    {
      tenantId: ctx.tenantId,
      type: "intake.rota_gap",
      severity: "high",
      audience: "internal",
      title: "On-call rota has a gap",
      summary,
      recipients: { userIds: owners },
      dedupeKey: `intake.rota_gap:${day}`,
      sourceCard: "c66",
      engine: INTAKE_ENGINE,
    },
    { now }
  );
}

/** Scheduled escalation step (real clock). Idempotent: does nothing once acknowledged or downgraded. */
export async function handleEmergencyEscalation(tx: TenantTx, tenantId: string, task: ScheduledTaskRow, now: Date): Promise<void> {
  const alertId = payloadString(task.payload, "alertId");
  if (!alertId) return;
  const [alert] = await tx
    .select()
    .from(intakeEmergencyAlerts)
    .where(and(eq(intakeEmergencyAlerts.tenantId, tenantId), eq(intakeEmergencyAlerts.id, alertId)))
    .limit(1);
  if (!alert || alert.acknowledgedAt || alert.downgradedAt || alert.track === "deadline_risk") return;
  const ctx = await loadIntakeContext(tx, tenantId);
  const { owners } = await resolveEscalationContacts(tx, tenantId, ctx.settings);
  const rota = await loadRota(tx, tenantId);
  const next = alert.escalationStep + 1;
  const step = escalationStep(next, onCallAt(rota, now, ctx.calendar.timeZone), owners, alert.track as "safety" | "urgent_legal");
  if (alert.flagId && step.userIds.length > 0) {
    await escalateFlag(tx, {
      tenantId,
      flagId: alert.flagId,
      addUserIds: step.userIds,
      severity: "critical",
      note: `Not acknowledged within ${ctx.settings.emergency.ackWindowMinutes} minutes: paging ${step.label.replace("_", " ")}.`,
      engine: INTAKE_ENGINE,
      at: now,
    });
  }
  await tx
    .update(intakeEmergencyAlerts)
    .set({ escalationStep: next, pagedUserIds: [...new Set([...alert.pagedUserIds, ...step.userIds])] })
    .where(eq(intakeEmergencyAlerts.id, alert.id));
  if (next >= 2) {
    await updateState(tx, tenantId, alert.intakeSessionId, { emergencyUnacknowledged: true });
  }
  if (step.rotaGap) await flagRotaGap(tx, ctx, now, owners, "No backup was on call during an unacknowledged emergency.");
  await recordIntakeEvent(tx, {
    tenantId,
    intakeSessionId: alert.intakeSessionId,
    matterId: alert.matterId,
    eventType: "emergency_escalated",
    ruleName: "emergency_escalation.real_clock",
    entityType: "emergency_alert",
    entityId: alert.id,
    payload: { step: next, label: step.label, userIds: step.userIds },
  });
  // Keep escalating every ack window until someone acknowledges (c66 failure paths).
  await scheduleTask(tx, {
    tenantId,
    taskType: INTAKE_TASK_TYPES.emergencyEscalation,
    dueAt: addMinutes(now, ctx.settings.emergency.ackWindowMinutes),
    intakeSessionId: alert.intakeSessionId,
    matterId: alert.matterId,
    payload: { alertId: alert.id, step: next + 1 },
  });
}

async function getAlert(tx: TenantTx, tenantId: string, alertId: string): Promise<EmergencyAlertRow> {
  const [row] = await tx
    .select()
    .from(intakeEmergencyAlerts)
    .where(and(eq(intakeEmergencyAlerts.tenantId, tenantId), eq(intakeEmergencyAlerts.id, alertId)))
    .limit(1);
  if (!row) throw new IntakeNotFoundError("Emergency alert");
  return row;
}

/**
 * "I've got this" (c66 urgent track §5). Stops escalation; does NOT count as
 * the c69 human contact by itself.
 */
export async function acknowledgeEmergency(tx: TenantTx, input: { tenantId: string; alertId: string; userId: string; now?: Date }) {
  await requireStaff(tx, input.tenantId, input.userId, STAFF_ROLES, "acknowledge an emergency");
  const now = input.now ?? new Date();
  const alert = await getAlert(tx, input.tenantId, input.alertId);
  if (alert.acknowledgedAt) return alert;
  const [row] = await tx
    .update(intakeEmergencyAlerts)
    .set({ acknowledgedAt: now, acknowledgedByUserId: input.userId })
    .where(eq(intakeEmergencyAlerts.id, alert.id))
    .returning();
  if (alert.flagId) await acknowledgeFlag(tx, { tenantId: input.tenantId, flagId: alert.flagId, userId: input.userId, engine: INTAKE_ENGINE, at: now });
  await cancelScheduledTasks(tx, { tenantId: input.tenantId, taskType: INTAKE_TASK_TYPES.emergencyEscalation, payloadKey: "alertId", payloadValue: alert.id, at: now });
  await updateState(tx, input.tenantId, alert.intakeSessionId, { emergencyUnacknowledged: false });
  await recordIntakeEvent(tx, {
    tenantId: input.tenantId,
    intakeSessionId: alert.intakeSessionId,
    matterId: alert.matterId,
    eventType: "emergency_acknowledged",
    actor: userActor(input.userId),
    entityType: "emergency_alert",
    entityId: alert.id,
    payload: { secondsToAck: Math.round((now.getTime() - alert.raisedAt.getTime()) / 1000), step: alert.escalationStep },
  });
  return row!;
}

/** Staff downgrade a false positive. A reason is required and logged (c66 acceptance 6). */
export async function downgradeEmergency(tx: TenantTx, input: { tenantId: string; alertId: string; userId: string; reason: string; now?: Date }) {
  const reason = requireReason(input.reason, "Downgrading an emergency alert");
  await requireStaff(tx, input.tenantId, input.userId, STAFF_ROLES, "downgrade an emergency alert");
  const now = input.now ?? new Date();
  const alert = await getAlert(tx, input.tenantId, input.alertId);
  if (alert.downgradedAt) throw new IntakeRuleError("This alert was already downgraded.");
  const [row] = await tx
    .update(intakeEmergencyAlerts)
    .set({ downgradedAt: now, downgradedByUserId: input.userId, downgradeReason: reason })
    .where(eq(intakeEmergencyAlerts.id, alert.id))
    .returning();
  if (alert.flagId) {
    try {
      await resolveFlag(tx, { tenantId: input.tenantId, flagId: alert.flagId, by: userActor(input.userId), reason: `Downgraded: ${reason}`, engine: INTAKE_ENGINE, at: now });
    } catch {
      // Already resolved elsewhere: the downgrade itself is still recorded.
    }
  }
  await cancelScheduledTasks(tx, { tenantId: input.tenantId, taskType: INTAKE_TASK_TYPES.emergencyEscalation, payloadKey: "alertId", payloadValue: alert.id, at: now });
  const stillOpen = await tx
    .select({ id: intakeEmergencyAlerts.id })
    .from(intakeEmergencyAlerts)
    .where(
      and(
        eq(intakeEmergencyAlerts.tenantId, input.tenantId),
        eq(intakeEmergencyAlerts.intakeSessionId, alert.intakeSessionId),
        eq(intakeEmergencyAlerts.track, "safety"),
        isNull(intakeEmergencyAlerts.downgradedAt)
      )
    );
  if (alert.track === "safety" && stillOpen.length === 0) {
    // Safety pause lifts; the safe-contact requirement stays until confirmed (DV-safe default).
    await updateState(tx, input.tenantId, alert.intakeSessionId, { status: "active", emergencyUnacknowledged: false });
  }
  await recordIntakeEvent(tx, {
    tenantId: input.tenantId,
    intakeSessionId: alert.intakeSessionId,
    matterId: alert.matterId,
    eventType: "emergency_downgraded",
    actor: userActor(input.userId),
    reason,
    entityType: "emergency_alert",
    entityId: alert.id,
    payload: { track: alert.track, category: alert.category },
  });
  return row!;
}

/** Firm admins' ops queue: open emergency alerts (internal only). */
export async function listOpenEmergencies(tx: TenantTx, tenantId: string) {
  return tx
    .select()
    .from(intakeEmergencyAlerts)
    .where(and(eq(intakeEmergencyAlerts.tenantId, tenantId), isNull(intakeEmergencyAlerts.acknowledgedAt), isNull(intakeEmergencyAlerts.downgradedAt)))
    .orderBy(desc(intakeEmergencyAlerts.raisedAt))
    .limit(200);
}

/**
 * The person answered the DV-safe question (c66 safety §2). Stores safe
 * channels on the contact's preferences (the only place delivery reads
 * them), switches off channels they said are unsafe, and records consent.
 */
export async function confirmSafeContact(
  tx: TenantTx,
  input: {
    tenantId: string;
    intakeSessionId: string;
    safeEmail?: string | null;
    safePhone?: string | null;
    emailUnsafe?: boolean;
    smsUnsafe?: boolean;
    voicemailAllowed?: boolean;
    recordedByUserId?: string | null;
    now?: Date;
  }
): Promise<void> {
  const now = input.now ?? new Date();
  const { state } = await getSessionBundle(tx, input.tenantId, input.intakeSessionId);
  if (!state.partyId) throw new IntakeRuleError("No contact is linked to this inquiry yet.");
  if (!input.safeEmail && !input.safePhone && !input.emailUnsafe && !input.smsUnsafe) {
    throw new IntakeValidationError("Record at least one safe channel or mark a channel as unsafe.");
  }
  const [party] = await tx.select().from(parties).where(and(eq(parties.tenantId, input.tenantId), eq(parties.id, state.partyId))).limit(1);
  if (!party) throw new IntakeNotFoundError("Contact");
  const prefs: SafeContactPreferences = { ...(party.safeContact ?? {}) };
  if (input.safeEmail) prefs.safeEmail = input.safeEmail.trim();
  if (input.safePhone) prefs.safePhone = input.safePhone.trim();
  if (input.emailUnsafe) prefs.emailAllowed = false;
  if (input.smsUnsafe) prefs.smsAllowed = false;
  if (input.voicemailAllowed !== undefined) prefs.voicemailAllowed = input.voicemailAllowed;
  await tx
    .update(parties)
    .set({ safeContact: prefs, dvSensitive: party.dvSensitive || state.safetyFlagged, updatedAt: now })
    .where(eq(parties.id, party.id));
  await updateState(tx, input.tenantId, input.intakeSessionId, { safeContactConfirmedAt: now });
  await tx.insert(intakeConsents).values({
    tenantId: input.tenantId,
    intakeSessionId: input.intakeSessionId,
    partyId: party.id,
    consentType: "safe_contact",
    channel: state.channel,
    given: true,
    recordedByUserId: input.recordedByUserId ?? null,
    givenAt: now,
  });
  await recordIntakeEvent(tx, {
    tenantId: input.tenantId,
    intakeSessionId: input.intakeSessionId,
    eventType: "safe_contact_confirmed",
    actor: input.recordedByUserId ? userActor(input.recordedByUserId) : { type: "client", partyId: party.id },
    payload: { safeEmail: Boolean(input.safeEmail), safePhone: Boolean(input.safePhone), emailUnsafe: Boolean(input.emailUnsafe), smsUnsafe: Boolean(input.smsUnsafe) },
  });
}

/** Pure: may anything be sent to this person? (c66 rule 5 — shared with c67, c69, c70.) */
export function safetySuppressed(state: { safetyFlagged: boolean; safeContactConfirmedAt: Date | null }): boolean {
  return state.safetyFlagged && !state.safeContactConfirmedAt;
}

// ---------------------------------------------------------------------------
// Rota
// ---------------------------------------------------------------------------

export async function listRota(tx: TenantTx, tenantId: string) {
  return tx.select().from(intakeOnCallRota).where(eq(intakeOnCallRota.tenantId, tenantId));
}

export async function addRotaShift(
  tx: TenantTx,
  input: {
    tenantId: string;
    byUserId: string;
    userId: string;
    role: "primary" | "backup" | "staff";
    startsAt?: Date | null;
    endsAt?: Date | null;
    weekday?: string | null;
    startTime?: string | null;
    endTime?: string | null;
  }
) {
  await requireStaff(tx, input.tenantId, input.byUserId, ["firm_admin", "attorney"], "edit the on-call rota");
  const target = await requireStaff(tx, input.tenantId, input.userId, STAFF_ROLES, "be on call");
  if ((input.role === "primary" || input.role === "backup") && target.role !== "attorney") {
    throw new IntakeRuleError("Primary and backup on-call must be lawyers; add staff with the 'staff' role.");
  }
  const oneOff = Boolean(input.startsAt && input.endsAt);
  const weekly = Boolean(input.weekday && input.startTime && input.endTime);
  if (oneOff === weekly) throw new IntakeValidationError("Give either startsAt/endsAt or weekday/startTime/endTime.");
  if (oneOff && input.endsAt!.getTime() <= input.startsAt!.getTime()) throw new IntakeValidationError("A shift must end after it starts.");
  if (weekly && (!/^([01]\d|2[0-3]):[0-5]\d$/.test(input.startTime!) || !/^([01]\d|2[0-4]):[0-5]\d$/.test(input.endTime!))) {
    throw new IntakeValidationError("Shift times must be HH:MM.");
  }
  const [row] = await tx
    .insert(intakeOnCallRota)
    .values({
      tenantId: input.tenantId,
      userId: input.userId,
      role: input.role,
      startsAt: oneOff ? input.startsAt! : null,
      endsAt: oneOff ? input.endsAt! : null,
      weekday: weekly ? input.weekday! : null,
      startTime: weekly ? input.startTime! : null,
      endTime: weekly ? input.endTime! : null,
    })
    .returning();
  await recordIntakeEvent(tx, { tenantId: input.tenantId, eventType: "rota_shift_added", actor: userActor(input.byUserId), entityType: "rota_shift", entityId: row?.id ?? null, payload: { userId: input.userId, role: input.role } });
  return row;
}

export async function deactivateRotaShift(tx: TenantTx, input: { tenantId: string; byUserId: string; shiftId: string }) {
  await requireStaff(tx, input.tenantId, input.byUserId, ["firm_admin", "attorney"], "edit the on-call rota");
  await tx
    .update(intakeOnCallRota)
    .set({ active: false })
    .where(and(eq(intakeOnCallRota.tenantId, input.tenantId), eq(intakeOnCallRota.id, input.shiftId)));
  await recordIntakeEvent(tx, { tenantId: input.tenantId, eventType: "rota_shift_removed", actor: userActor(input.byUserId), entityType: "rota_shift", entityId: input.shiftId });
}

/** Tick hook: warn owners/admins about rota gaps in the next N hours (c66 failure paths, acceptance 5). */
export async function scanRotaGaps(tx: TenantTx, tenantId: string, now: Date): Promise<{ gaps: number }> {
  const ctx = await loadIntakeContext(tx, tenantId);
  const rota = await loadRota(tx, tenantId);
  const gaps = findCoverageGaps(rota, now, addHours(now, ctx.settings.emergency.rotaGapWarningHours), ctx.calendar.timeZone);
  if (gaps.length === 0) return { gaps: 0 };
  const { owners } = await resolveEscalationContacts(tx, tenantId, ctx.settings);
  const first = gaps[0]!;
  await flagRotaGap(
    tx,
    ctx,
    now,
    owners,
    `No primary lawyer is on call from ${first.start.toISOString()} (${gaps.length} gap${gaps.length === 1 ? "" : "s"} in the next ${ctx.settings.emergency.rotaGapWarningHours} hours).`
  );
  return { gaps: gaps.length };
}

