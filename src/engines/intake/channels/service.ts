// c65 — intake from every channel lands in one intake record (database operations).
//
// receiveInbound() is the single entry point for every channel adapter
// (web chat, web form, phone, intake inbox, SMS, staff-entered walk-ins and
// calls). It creates or resumes the intake_sessions row, stores the message,
// runs STOP handling (c70) and emergency detection (c66) on every message,
// gives the channel's gated replies, and starts the speed-to-lead clock (c69).

import { and, asc, desc, eq, like, or, sql } from "drizzle-orm";
import { intakeSessions, parties } from "@/db/schema";
import { intakeConsents, intakeMessages, intakeReferrals, intakeSessionState } from "@/db/tables/intake";
import type { TenantTx } from "@/tenancy/withTenant";
import { gateStatus, legalCopyStatus, requireApproval } from "@/compliance/approvals";
import { normalizeName } from "@/core/contacts";
import type { Actor } from "@/core/audit";
import {
  CHANNEL_COPY,
  CHANNEL_RULE_GATES,
  copyKeyFor,
  EMERGENCY_COPY,
  SPEED_TO_LEAD_COPY,
} from "../gates";
import { requireStaff, STAFF_ROLES, userActor } from "../common/actors";
import { loadIntakeContext, type IntakeContext } from "../common/context";
import { IntakeRuleError, IntakeValidationError } from "../common/errors";
import { recordIntakeEvent } from "../common/events";
import { notifyParty } from "../common/notify";
import { currentFirmConfigVersionId, getSessionBundle, updateState, type SessionBundle } from "../common/sessions";
import { getConflictStatusForSession, isConflictCleared, requestConflictCheck } from "../adapters/conflictStatus";
import { decideReply, getConversationProvider } from "../adapters/conversation";
import { activePhraseList, detectEmergencies, type ClassifierSignal } from "../emergency/detect";
import { raiseEmergency, safetySuppressed, type RaisedEmergency } from "../emergency/service";
import { detectStop } from "../followUp/sequence";
import { stopFollowUps } from "../followUp/service";
import { startResponseClock } from "../speedToLead/service";
import {
  caseDetailsLock,
  hasUsableContact,
  normalizeEmail,
  normalizePhone,
  planReplies,
  STAFF_ENTERED_CHANNELS,
  suggestDuplicates,
  type IntakeChannel,
  type LockReason,
  type ReplyKind,
} from "./records";

export interface InboundInput {
  tenantId: string;
  channel: IntakeChannel;
  /** Vendor thread / call / email-thread id, to resume the same session. */
  externalThreadId?: string | null;
  intakeSessionId?: string | null;
  from?: { name?: string | null; email?: string | null; phone?: string | null };
  text?: string | null;
  language?: "en" | "es" | null;
  /** Classifier signals when a (DPA-approved) classifier ran on this message. */
  classifier?: ClassifierSignal | null;
  /** Required for staff-entered channels (walk_in, phone_manual, phone_staff). */
  staffUserId?: string | null;
  now?: Date;
}

export interface ReplyOutcome {
  kind: ReplyKind;
  gateKey: string;
  /** What the person sees on in-page channels (a visible placeholder until approved). */
  text: string;
  status: "shown" | "held" | "sent" | "failed" | "suppressed";
  detail: string | null;
}

export interface InboundResult {
  intakeSessionId: string;
  isNewSession: boolean;
  replies: ReplyOutcome[];
  emergencies: RaisedEmergency[];
  stop: boolean;
  caseDetails: { locked: boolean; reasons: LockReason[] };
}

const REPLY_COPY: Record<ReplyKind, { en: { key: string }; es: { key: string } }> = {
  safety_911: EMERGENCY_COPY.safety911,
  safe_contact_question: EMERGENCY_COPY.safeContactQuestion,
  urgent_acknowledgement: EMERGENCY_COPY.urgentAcknowledgement,
  person_alerted: EMERGENCY_COPY.personAlerted,
  recording_prompt: CHANNEL_COPY.recordingPrompt,
  sms_first_reply: CHANNEL_COPY.smsFirstReply,
  email_auto_reply: CHANNEL_COPY.emailAutoReply,
  channel_disclosure: CHANNEL_COPY.disclosure,
  ai_acknowledgement: SPEED_TO_LEAD_COPY.aiAcknowledgement,
};

function firmVars(ctx: IntakeContext): Record<string, string> {
  return { firmName: ctx.firm.emailFromName ?? "our firm", portalUrl: ctx.firm.clientPortalUrl ?? "the link we sent you" };
}

async function findSessionByThread(tx: TenantTx, tenantId: string, channel: IntakeChannel, threadId: string): Promise<string | null> {
  const [row] = await tx
    .select({ id: intakeSessionState.intakeSessionId })
    .from(intakeSessionState)
    .where(and(eq(intakeSessionState.tenantId, tenantId), eq(intakeSessionState.channel, channel), eq(intakeSessionState.externalThreadId, threadId)))
    .orderBy(desc(intakeSessionState.createdAt))
    .limit(1);
  return row?.id ?? null;
}

/** A referral waiting for this person to get in touch (matched on email/phone, c65 referral §2). */
async function findWaitingReferral(tx: TenantTx, tenantId: string, email: string | null, phone: string | null): Promise<string | null> {
  if (!email && !phone) return null;
  const conds = [];
  if (email) conds.push(eq(parties.email, email));
  if (phone) conds.push(eq(parties.phone, phone));
  const [row] = await tx
    .select({ id: intakeSessionState.intakeSessionId })
    .from(intakeSessionState)
    .innerJoin(parties, and(eq(parties.id, intakeSessionState.partyId), eq(parties.tenantId, intakeSessionState.tenantId)))
    .where(and(eq(intakeSessionState.tenantId, tenantId), eq(intakeSessionState.status, "referral_awaiting_contact"), or(...conds)))
    .limit(1);
  return row?.id ?? null;
}

async function createSession(
  tx: TenantTx,
  input: { tenantId: string; channel: IntakeChannel; language: string; name: string | null; email: string | null; phone: string | null; threadId: string | null; status?: "active" | "referral_awaiting_contact"; now: Date }
): Promise<SessionBundle> {
  const configId = await currentFirmConfigVersionId(tx, input.tenantId);
  const fullName = input.name?.trim() || "Unknown contact";
  const [party] = await tx
    .insert(parties)
    .values({ tenantId: input.tenantId, fullName, normalizedName: normalizeName(fullName), email: input.email, phone: input.phone })
    .returning();
  const [session] = await tx
    .insert(intakeSessions)
    .values({ tenantId: input.tenantId, channel: input.channel, language: input.language, firmConfigVersionId: configId, startedAt: input.now })
    .returning();
  if (!party || !session) throw new Error("createSession: insert failed.");
  const [state] = await tx
    .insert(intakeSessionState)
    .values({
      tenantId: input.tenantId,
      intakeSessionId: session.id,
      partyId: party.id,
      channel: input.channel,
      externalThreadId: input.threadId,
      status: input.status ?? "active",
      recordingState: input.channel === "phone_ai" || input.channel === "phone_staff" ? "pending" : "not_applicable",
    })
    .returning();
  if (!state) throw new Error("createSession: state insert failed.");
  await recordIntakeEvent(tx, {
    tenantId: input.tenantId,
    intakeSessionId: session.id,
    eventType: "contact_received",
    firmConfigVersionId: configId,
    payload: { channel: input.channel, language: input.language, hasEmail: Boolean(input.email), hasPhone: Boolean(input.phone) },
  });
  return { session, state };
}

async function storeMessage(
  tx: TenantTx,
  m: {
    tenantId: string;
    intakeSessionId: string;
    direction: "inbound" | "outbound";
    channel: IntakeChannel;
    authorType: "caller" | "ai" | "staff" | "system";
    authorUserId?: string | null;
    body: string;
    copyGateKey?: string | null;
    deliveryStatus: "received" | "shown" | "held" | "sent" | "failed" | "suppressed";
    deliveryDetail?: string | null;
    vendorMessageId?: string | null;
    now: Date;
  }
): Promise<void> {
  await tx.insert(intakeMessages).values({
    tenantId: m.tenantId,
    intakeSessionId: m.intakeSessionId,
    direction: m.direction,
    channel: m.channel,
    authorType: m.authorType,
    authorUserId: m.authorUserId ?? null,
    body: m.body,
    copyGateKey: m.copyGateKey ?? null,
    deliveryStatus: m.deliveryStatus,
    deliveryDetail: m.deliveryDetail ?? null,
    vendorMessageId: m.vendorMessageId ?? null,
    createdAt: m.now,
  });
}

async function hasAskedSafeContact(tx: TenantTx, tenantId: string, sessionId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: intakeMessages.id })
    .from(intakeMessages)
    .where(and(eq(intakeMessages.tenantId, tenantId), eq(intakeMessages.intakeSessionId, sessionId), like(intakeMessages.copyGateKey, "copy.intake.safe_contact_question%")))
    .limit(1);
  return Boolean(row);
}

async function smsOptedIn(tx: TenantTx, tenantId: string, partyId: string | null): Promise<boolean> {
  if (!partyId) return false;
  const [p] = await tx.select({ safeContact: parties.safeContact }).from(parties).where(and(eq(parties.tenantId, tenantId), eq(parties.id, partyId))).limit(1);
  return Boolean(p?.safeContact?.smsConsentAt) && p?.safeContact?.smsAllowed !== false;
}

async function deliverReplies(
  tx: TenantTx,
  ctx: IntakeContext,
  bundle: SessionBundle,
  kinds: ReplyKind[],
  now: Date
): Promise<ReplyOutcome[]> {
  const out: ReplyOutcome[] = [];
  const { session, state } = bundle;
  const channel = state.channel as IntakeChannel;
  const vars = firmVars(ctx);
  const optIn = await smsOptedIn(tx, ctx.tenantId, state.partyId);
  for (const kind of kinds) {
    const gateKey = copyKeyFor(REPLY_COPY[kind] as never, session.language);
    const copy = legalCopyStatus(gateKey, vars);
    let status: ReplyOutcome["status"];
    let detail: string | null = null;
    let vendorMessageId: string | null = null;

    if (channel === "email") {
      // Intake inbox: only the auto-reply goes out, through the shared (vendor-gated) outbox.
      if (kind === "email_auto_reply" && state.partyId) {
        const [r] = await notifyParty(tx, { tenantId: ctx.tenantId, partyId: state.partyId, templateKey: gateKey, channels: ["email"], dedupeBase: `intake.email_auto_reply:${session.id}` }, { now });
        status = r?.status === "suppressed" ? "suppressed" : "held";
        detail = r?.status === "suppressed" ? r.reason : "Queued in the notification outbox (sent once vendor.email and the wording are approved).";
      } else {
        status = "held";
        detail = "Email channel: staff respond personally.";
      }
    } else {
      const decision = decideReply({
        channel,
        copyApproved: copy.approved,
        smsOptIn: optIn,
        safetySuppressed: safetySuppressed(state),
        isSafetyReply: kind === "safety_911" || kind === "safe_contact_question",
      });
      if (decision.mode === "show") status = "shown";
      else if (decision.mode === "hold") {
        status = "held";
        detail = decision.reason;
      } else {
        const to = channel === "sms" ? await partyPhone(tx, ctx.tenantId, state.partyId) : null;
        const result = await getConversationProvider().send({ tenantId: ctx.tenantId, intakeSessionId: session.id, channel, to, text: copy.text });
        status = result.outcome === "sent" ? "sent" : result.outcome === "failed" ? "failed" : "held";
        detail = result.detail ?? null;
        vendorMessageId = result.providerMessageId ?? null;
      }
    }
    await storeMessage(tx, {
      tenantId: ctx.tenantId,
      intakeSessionId: session.id,
      direction: "outbound",
      channel,
      authorType: "ai",
      body: copy.text,
      copyGateKey: gateKey,
      deliveryStatus: status,
      deliveryDetail: detail,
      vendorMessageId,
      now,
    });
    out.push({ kind, gateKey, text: copy.text, status, detail });
  }
  return out;
}

async function partyPhone(tx: TenantTx, tenantId: string, partyId: string | null): Promise<string | null> {
  if (!partyId) return null;
  const [p] = await tx.select({ phone: parties.phone, safeContact: parties.safeContact }).from(parties).where(and(eq(parties.tenantId, tenantId), eq(parties.id, partyId))).limit(1);
  return p?.safeContact?.safePhone ?? p?.phone ?? null;
}

/** Single entry point for every channel. */
export async function receiveInbound(tx: TenantTx, input: InboundInput): Promise<InboundResult> {
  const now = input.now ?? new Date();
  const ctx = await loadIntakeContext(tx, input.tenantId);
  const email = normalizeEmail(input.from?.email);
  const phone = normalizePhone(input.from?.phone);
  const staffEntered = STAFF_ENTERED_CHANNELS.includes(input.channel);
  let staffActor: Actor | null = null;
  if (staffEntered) {
    if (!input.staffUserId) throw new IntakeValidationError("Staff-entered intakes need the staff member's user id.");
    await requireStaff(tx, input.tenantId, input.staffUserId, STAFF_ROLES, "enter an intake");
    staffActor = userActor(input.staffUserId);
  }
  if (input.channel === "referral") throw new IntakeValidationError("Use recordReferral() for referrals; nothing is sent to a referred person.");

  let sessionId = input.intakeSessionId ?? null;
  if (!sessionId && input.externalThreadId) sessionId = await findSessionByThread(tx, input.tenantId, input.channel, input.externalThreadId);
  let isNewSession = false;
  let bundle: SessionBundle;
  const referralId = !sessionId ? await findWaitingReferral(tx, input.tenantId, email, phone) : null;
  if (sessionId) {
    bundle = await getSessionBundle(tx, input.tenantId, sessionId);
  } else if (referralId) {
    // The referred person contacted the firm: the referral session activates on this channel.
    bundle = await getSessionBundle(tx, input.tenantId, referralId);
    const state = await updateState(tx, input.tenantId, referralId, { status: "active", channel: input.channel, externalThreadId: input.externalThreadId ?? null });
    await tx.update(intakeReferrals).set({ activatedAt: now, activationReason: "person_contacted_firm" }).where(and(eq(intakeReferrals.tenantId, input.tenantId), eq(intakeReferrals.intakeSessionId, referralId)));
    bundle = { ...bundle, state };
    isNewSession = true;
    await recordIntakeEvent(tx, { tenantId: input.tenantId, intakeSessionId: referralId, eventType: "referral_activated", payload: { channel: input.channel } });
  } else {
    bundle = await createSession(tx, {
      tenantId: input.tenantId,
      channel: input.channel,
      language: input.language ?? "en",
      name: input.from?.name ?? null,
      email,
      phone,
      threadId: input.externalThreadId ?? null,
      now,
    });
    isNewSession = true;
  }
  const { session } = bundle;
  if (input.language && input.language !== session.language) {
    await tx.update(intakeSessions).set({ language: input.language }).where(and(eq(intakeSessions.tenantId, input.tenantId), eq(intakeSessions.id, session.id)));
    bundle = { ...bundle, session: { ...session, language: input.language } };
  }

  // Store the inbound message (every message is kept against the session, c65 rule 11).
  const text = input.text?.trim() ?? "";
  if (text) {
    await storeMessage(tx, {
      tenantId: input.tenantId,
      intakeSessionId: session.id,
      direction: "inbound",
      channel: input.channel,
      authorType: staffEntered ? "staff" : "caller",
      authorUserId: staffEntered ? input.staffUserId : null,
      body: text,
      deliveryStatus: "received",
      now,
    });
  }
  if (input.channel === "email" && text && !bundle.state.disclosuresAcknowledgedAt) {
    // c65 email §2: details may arrive before disclosures/conflict check. Kept for staff, not triaged.
    bundle = { ...bundle, state: await updateState(tx, input.tenantId, session.id, { unsolicitedDetailsReceived: true }) };
  }

  // STOP on any channel ends follow-ups everywhere (c70); no other reply.
  const stop = text && !staffEntered ? detectStop(text, ctx.settings.followUp.extraStopWords) : { stop: false, kind: null };
  if (stop.stop && stop.kind) {
    await stopFollowUps(tx, { tenantId: input.tenantId, intakeSessionId: session.id, channel: input.channel, kind: stop.kind, now });
  }

  // Emergency detection on every message, before anything else (c66 rule 1).
  let emergencies: RaisedEmergency[] = [];
  if (text || input.classifier) {
    const { lists, approved } = activePhraseList(ctx.settings.emergency.extraPhrases);
    const detections = detectEmergencies(text, lists, input.classifier);
    if (detections.length > 0) {
      emergencies = await raiseEmergency(tx, { tenantId: input.tenantId, intakeSessionId: session.id, detections, listApproved: approved, now });
      bundle = await getSessionBundle(tx, input.tenantId, session.id);
    }
  }
  const safetyNow = emergencies.some((e) => e.track === "safety");
  const urgentNow = emergencies.some((e) => e.track === "urgent_legal");

  // Replies (never for staff-entered channels: staff read the scripts themselves).
  let replies: ReplyOutcome[] = [];
  if (!staffEntered) {
    const kinds = planReplies({
      channel: input.channel,
      isNewSession,
      safetyDetected: safetyNow,
      urgentDetected: urgentNow,
      pausedForEmergency: bundle.state.status === "paused_emergency",
      safeContactAsked: await hasAskedSafeContact(tx, input.tenantId, session.id),
      isStop: stop.stop,
    });
    replies = await deliverReplies(tx, ctx, bundle, kinds, now);
  }

  // Speed-to-lead clock: first inbound with usable contact details, unless an emergency bypassed it.
  if (!safetyNow && !urgentNow && !stop.stop && (hasUsableContact({ email, phone }) || staffEntered)) {
    await startResponseClock(tx, { tenantId: input.tenantId, intakeSessionId: session.id, now });
  }

  if (staffActor && isNewSession) {
    await recordIntakeEvent(tx, { tenantId: input.tenantId, intakeSessionId: session.id, eventType: "staff_entered_intake", actor: staffActor, payload: { channel: input.channel } });
  }
  const conflict = await getConflictStatusForSession(tx, input.tenantId, session.id);
  const finalState = (await getSessionBundle(tx, input.tenantId, session.id)).state;
  return {
    intakeSessionId: session.id,
    isNewSession,
    replies,
    emergencies,
    stop: stop.stop,
    caseDetails: caseDetailsLock({
      disclosuresAcknowledgedAt: finalState.disclosuresAcknowledgedAt,
      conflictMinimum: finalState.conflictMinimum,
      conflictState: conflict.state,
      status: finalState.status,
    }),
  };
}

/**
 * The person (or staff reading the script aloud, for walk-ins and manual
 * calls) acknowledged the disclosures. Stores channel, time and the exact
 * text version (gate key + draft hash) (c65 rule 3).
 */
export async function acknowledgeDisclosures(
  tx: TenantTx,
  input: { tenantId: string; intakeSessionId: string; staffUserId?: string | null; now?: Date }
): Promise<void> {
  const now = input.now ?? new Date();
  const { session, state } = await getSessionBundle(tx, input.tenantId, input.intakeSessionId);
  const staffEntered = STAFF_ENTERED_CHANNELS.includes(state.channel as IntakeChannel);
  if (staffEntered) {
    if (!input.staffUserId) throw new IntakeValidationError("For walk-ins and manual calls, the staff member who read the disclosures must tick them.");
    await requireStaff(tx, input.tenantId, input.staffUserId, STAFF_ROLES, "record disclosures");
  }
  const gateKey = copyKeyFor(CHANNEL_COPY.disclosure, session.language);
  const status = gateStatus(gateKey);
  await tx.insert(intakeConsents).values({
    tenantId: input.tenantId,
    intakeSessionId: session.id,
    partyId: state.partyId,
    consentType: "disclosures",
    channel: state.channel,
    textGateKey: gateKey,
    textVersion: status.approved ? status.gate.draftHash ?? "approved" : "pending_review",
    given: true,
    recordedByUserId: input.staffUserId ?? null,
    givenAt: now,
  });
  await updateState(tx, input.tenantId, session.id, { disclosuresAcknowledgedAt: now });
  await recordIntakeEvent(tx, {
    tenantId: input.tenantId,
    intakeSessionId: session.id,
    eventType: "disclosures_acknowledged",
    actor: input.staffUserId ? userActor(input.staffUserId) : state.partyId ? { type: "client", partyId: state.partyId } : undefined,
    payload: { channel: state.channel, textGateKey: gateKey, wordingApproved: status.approved },
  });
}

/** SMS opt-in or recording consent (given or refused). Refused recording is never recorded retroactively. */
export async function recordConsent(
  tx: TenantTx,
  input: { tenantId: string; intakeSessionId: string; consentType: "sms" | "recording"; given: boolean; staffUserId?: string | null; now?: Date }
): Promise<void> {
  const now = input.now ?? new Date();
  const { session, state } = await getSessionBundle(tx, input.tenantId, input.intakeSessionId);
  const gateKey = input.consentType === "sms" ? copyKeyFor(CHANNEL_COPY.smsFirstReply, session.language) : copyKeyFor(CHANNEL_COPY.recordingPrompt, session.language);
  await tx.insert(intakeConsents).values({
    tenantId: input.tenantId,
    intakeSessionId: session.id,
    partyId: state.partyId,
    consentType: input.consentType,
    channel: state.channel,
    textGateKey: gateKey,
    textVersion: gateStatus(gateKey).approved ? gateStatus(gateKey).gate.draftHash ?? "approved" : "pending_review",
    given: input.given,
    recordedByUserId: input.staffUserId ?? null,
    givenAt: now,
  });
  if (input.consentType === "recording") {
    await updateState(tx, input.tenantId, session.id, { recordingState: input.given ? "consented" : "declined" });
  } else if (state.partyId) {
    const [p] = await tx.select({ safeContact: parties.safeContact }).from(parties).where(and(eq(parties.tenantId, input.tenantId), eq(parties.id, state.partyId))).limit(1);
    const prefs = { ...(p?.safeContact ?? {}) };
    if (input.given) {
      prefs.smsConsentAt = now.toISOString();
      if (prefs.smsAllowed === false && !state.followUpStoppedAt) delete prefs.smsAllowed;
    } else {
      prefs.smsAllowed = false;
    }
    await tx.update(parties).set({ safeContact: prefs, updatedAt: now }).where(and(eq(parties.tenantId, input.tenantId), eq(parties.id, state.partyId)));
  }
  await recordIntakeEvent(tx, {
    tenantId: input.tenantId,
    intakeSessionId: session.id,
    eventType: input.consentType === "recording" ? (input.given ? "recording_consented" : "recording_declined") : input.given ? "sms_opt_in" : "sms_opt_in_refused",
    actor: input.staffUserId ? userActor(input.staffUserId) : state.partyId ? { type: "client", partyId: state.partyId } : undefined,
    payload: { channel: state.channel },
  });
}

/**
 * Conflict-minimum data (the person's name and the other party's name) is
 * collected before case details, and the conflict check is requested (c65 rule 4).
 */
export async function recordConflictMinimum(
  tx: TenantTx,
  input: { tenantId: string; intakeSessionId: string; fullName: string; otherPartyNames: string[]; email?: string | null; phone?: string | null; staffUserId?: string | null; now?: Date }
): Promise<void> {
  const now = input.now ?? new Date();
  const fullName = input.fullName.trim();
  if (!fullName) throw new IntakeValidationError("The person's name is required for the conflict check.");
  const others = input.otherPartyNames.map((n) => n.trim()).filter(Boolean);
  const { session, state } = await getSessionBundle(tx, input.tenantId, input.intakeSessionId);
  if (!state.disclosuresAcknowledgedAt) throw new IntakeRuleError("Disclosures must be acknowledged first.");
  await updateState(tx, input.tenantId, session.id, { conflictMinimum: { fullName, otherPartyNames: others }, conflictCheckRequestedAt: now });
  if (state.partyId) {
    const patch: Partial<typeof parties.$inferInsert> = { fullName, normalizedName: normalizeName(fullName), updatedAt: now };
    const email = normalizeEmail(input.email);
    const phone = normalizePhone(input.phone);
    if (email) patch.email = email;
    if (phone) patch.phone = phone;
    await tx.update(parties).set(patch).where(and(eq(parties.tenantId, input.tenantId), eq(parties.id, state.partyId)));
  }
  await requestConflictCheck(tx, { tenantId: input.tenantId, intakeSessionId: session.id, matterId: session.matterId, reason: `New inquiry via ${state.channel}: run the minimal conflict check before any case details.`, now });
  await recordIntakeEvent(tx, {
    tenantId: input.tenantId,
    intakeSessionId: session.id,
    eventType: "conflict_minimum_collected",
    actor: input.staffUserId ? userActor(input.staffUserId) : undefined,
    payload: { otherPartyCount: others.length },
  });
}

/** Case details: refused (fields locked) until disclosures + a clear conflict check (c65 acceptance 5). */
export async function recordCaseDetails(
  tx: TenantTx,
  input: { tenantId: string; intakeSessionId: string; answers: Record<string, unknown>; staffUserId?: string | null; now?: Date }
): Promise<{ collectedAnswers: Record<string, unknown> }> {
  const { session, state } = await getSessionBundle(tx, input.tenantId, input.intakeSessionId);
  if (input.staffUserId) await requireStaff(tx, input.tenantId, input.staffUserId, STAFF_ROLES, "enter case details");
  const conflict = await getConflictStatusForSession(tx, input.tenantId, session.id);
  const lock = caseDetailsLock({ disclosuresAcknowledgedAt: state.disclosuresAcknowledgedAt, conflictMinimum: state.conflictMinimum, conflictState: conflict.state, status: state.status });
  if (lock.locked) throw new IntakeRuleError("Case details are locked until disclosures are acknowledged and the conflict check is clear.", { reasons: lock.reasons });
  const merged = { ...((session.collectedAnswers ?? {}) as Record<string, unknown>), ...input.answers };
  await tx.update(intakeSessions).set({ collectedAnswers: merged }).where(and(eq(intakeSessions.tenantId, input.tenantId), eq(intakeSessions.id, session.id)));
  await recordIntakeEvent(tx, {
    tenantId: input.tenantId,
    intakeSessionId: session.id,
    eventType: "case_details_recorded",
    actor: input.staffUserId ? userActor(input.staffUserId) : state.partyId ? { type: "client", partyId: state.partyId } : undefined,
    payload: { fields: Object.keys(input.answers) },
  });
  return { collectedAnswers: merged };
}

/**
 * Release case details that arrived unsolicited (email/forms) for triage.
 * Only after a clear conflict check AND the attorney's Rule 1.18 review of
 * this handling ('rules.intake.unsolicited_details_triage').
 */
export async function releaseUnsolicitedDetails(tx: TenantTx, input: { tenantId: string; intakeSessionId: string; userId: string }): Promise<void> {
  await requireStaff(tx, input.tenantId, input.userId, STAFF_ROLES, "release details for triage");
  requireApproval(CHANNEL_RULE_GATES.unsolicitedDetailsTriage.key, { action: "intake.unsolicited_details.release", tenantId: input.tenantId });
  const conflict = await getConflictStatusForSession(tx, input.tenantId, input.intakeSessionId);
  if (!isConflictCleared(conflict)) throw new IntakeRuleError("Unsolicited details can only be triaged after the conflict check is clear.");
  await updateState(tx, input.tenantId, input.intakeSessionId, { unsolicitedDetailsReceived: false });
  await recordIntakeEvent(tx, { tenantId: input.tenantId, intakeSessionId: input.intakeSessionId, eventType: "unsolicited_details_released", actor: userActor(input.userId) });
}

/**
 * Staff record a referral (c65 referral). The session waits for the referred
 * person; by default NOTHING is sent to them (c65 rule 9).
 */
export async function recordReferral(
  tx: TenantTx,
  input: {
    tenantId: string;
    staffUserId: string;
    referredName: string;
    referredEmail?: string | null;
    referredPhone?: string | null;
    referrerType: "lawyer" | "client" | "other";
    referrerUserId?: string | null;
    referrerPartyId?: string | null;
    referrerName?: string | null;
    notes?: string | null;
    now?: Date;
  }
): Promise<{ intakeSessionId: string }> {
  const now = input.now ?? new Date();
  await requireStaff(tx, input.tenantId, input.staffUserId, STAFF_ROLES, "record a referral");
  if (!input.referredName.trim()) throw new IntakeValidationError("The referred person's name is required.");
  const bundle = await createSession(tx, {
    tenantId: input.tenantId,
    channel: "referral",
    language: "en",
    name: input.referredName,
    email: normalizeEmail(input.referredEmail),
    phone: normalizePhone(input.referredPhone),
    threadId: null,
    status: "referral_awaiting_contact",
    now,
  });
  const source = input.referrerType === "lawyer" ? "lawyer_referral" : input.referrerType === "client" ? "client_referral" : "other_referral";
  await updateState(tx, input.tenantId, bundle.session.id, { referralSource: source });
  await tx.insert(intakeReferrals).values({
    tenantId: input.tenantId,
    intakeSessionId: bundle.session.id,
    referrerType: input.referrerType,
    referrerUserId: input.referrerUserId ?? null,
    referrerPartyId: input.referrerPartyId ?? null,
    referrerName: input.referrerName ?? null,
    notes: input.notes ?? null,
    recordedByUserId: input.staffUserId,
  });
  await recordIntakeEvent(tx, { tenantId: input.tenantId, intakeSessionId: bundle.session.id, eventType: "referral_recorded", actor: userActor(input.staffUserId), payload: { referrerType: input.referrerType } });
  return { intakeSessionId: bundle.session.id };
}

/**
 * Activate a waiting referral. 'person_requested_contact' (staff record that
 * the person asked to be contacted) is always allowed; the firm reaching out
 * first ('firm_outreach') is gated on attorney review (solicitation).
 */
export async function activateReferral(
  tx: TenantTx,
  input: { tenantId: string; intakeSessionId: string; staffUserId: string; reason: "person_requested_contact" | "firm_outreach"; now?: Date }
): Promise<void> {
  const now = input.now ?? new Date();
  await requireStaff(tx, input.tenantId, input.staffUserId, STAFF_ROLES, "activate a referral");
  if (input.reason === "firm_outreach") {
    requireApproval(CHANNEL_RULE_GATES.referralOutreach.key, { action: "intake.referral.firm_outreach", tenantId: input.tenantId });
  }
  const { state } = await getSessionBundle(tx, input.tenantId, input.intakeSessionId);
  if (state.status !== "referral_awaiting_contact") throw new IntakeRuleError("This referral is not waiting for activation.");
  await updateState(tx, input.tenantId, input.intakeSessionId, { status: "active" });
  await tx.update(intakeReferrals).set({ activatedAt: now, activationReason: input.reason }).where(and(eq(intakeReferrals.tenantId, input.tenantId), eq(intakeReferrals.intakeSessionId, input.intakeSessionId)));
  await startResponseClock(tx, { tenantId: input.tenantId, intakeSessionId: input.intakeSessionId, now });
  await recordIntakeEvent(tx, { tenantId: input.tenantId, intakeSessionId: input.intakeSessionId, eventType: "referral_activated", actor: userActor(input.staffUserId), payload: { reason: input.reason } });
}

/** A call dropped mid-intake: the session stays open, marked interrupted (c65 phone §5). */
export async function markInterrupted(tx: TenantTx, input: { tenantId: string; intakeSessionId: string }): Promise<void> {
  const { state } = await getSessionBundle(tx, input.tenantId, input.intakeSessionId);
  if (state.status !== "active") return;
  await updateState(tx, input.tenantId, input.intakeSessionId, { status: "interrupted" });
  await recordIntakeEvent(tx, { tenantId: input.tenantId, intakeSessionId: input.intakeSessionId, eventType: "session_interrupted" });
}

/** One queue for every channel (staff view; internal). */
export async function listIntakeQueue(tx: TenantTx, tenantId: string, opts: { limit?: number } = {}) {
  return tx
    .select({
      intakeSessionId: intakeSessionState.intakeSessionId,
      channel: intakeSessionState.channel,
      status: intakeSessionState.status,
      partyId: intakeSessionState.partyId,
      fullName: parties.fullName,
      safetyFlagged: intakeSessionState.safetyFlagged,
      emergencyUnacknowledged: intakeSessionState.emergencyUnacknowledged,
      unsolicitedDetailsReceived: intakeSessionState.unsolicitedDetailsReceived,
      responseTargetAt: intakeSessionState.responseTargetAt,
      responseOutcome: intakeSessionState.responseOutcome,
      fitOutcome: intakeSessionState.fitOutcome,
      startedAt: intakeSessions.startedAt,
    })
    .from(intakeSessionState)
    .innerJoin(intakeSessions, and(eq(intakeSessions.id, intakeSessionState.intakeSessionId), eq(intakeSessions.tenantId, intakeSessionState.tenantId)))
    .leftJoin(parties, and(eq(parties.id, intakeSessionState.partyId), eq(parties.tenantId, intakeSessionState.tenantId)))
    .where(and(eq(intakeSessionState.tenantId, tenantId), sql`${intakeSessions.terminalState} is null`))
    .orderBy(desc(intakeSessionState.emergencyUnacknowledged), desc(intakeSessionState.safetyFlagged), asc(intakeSessionState.responseTargetAt))
    .limit(opts.limit ?? 200);
}

/** Messages on one session (staff view; transcripts are firm-only, c65 §7). */
export async function listSessionMessages(tx: TenantTx, tenantId: string, intakeSessionId: string) {
  return tx
    .select()
    .from(intakeMessages)
    .where(and(eq(intakeMessages.tenantId, tenantId), eq(intakeMessages.intakeSessionId, intakeSessionId)))
    .orderBy(asc(intakeMessages.createdAt));
}

/** c71 suggestion: possible existing records for this session's contact. Staff confirm; never auto-merged. */
export async function suggestExistingContacts(tx: TenantTx, tenantId: string, intakeSessionId: string) {
  const { state } = await getSessionBundle(tx, tenantId, intakeSessionId);
  if (!state.partyId) return [];
  const [me] = await tx.select().from(parties).where(and(eq(parties.tenantId, tenantId), eq(parties.id, state.partyId))).limit(1);
  if (!me) return [];
  const conds = [eq(parties.normalizedName, me.normalizedName)];
  if (me.email) conds.push(eq(parties.email, me.email));
  if (me.phone) conds.push(eq(parties.phone, me.phone));
  const others = await tx
    .select({ id: parties.id, normalizedName: parties.normalizedName, email: parties.email, phone: parties.phone })
    .from(parties)
    .where(and(eq(parties.tenantId, tenantId), or(...conds), sql`${parties.id} <> ${me.id}`))
    .limit(50);
  return suggestDuplicates({ normalizedName: me.normalizedName === "unknown contact" ? null : me.normalizedName, email: me.email, phone: me.phone }, others);
}
