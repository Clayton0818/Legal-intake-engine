// c59 — a conflicts attorney decides every possible conflict, with written
// waivers where allowed. Database side; the rules are in decisions.ts.
//
// The AI and the system never record a decision: every row carries the
// deciding human's user id, and only a conflicts attorney may decide.

import { and, eq, inArray } from "drizzle-orm";
import { matters, parties } from "@/db/schema";
import { conflictChecks, conflictDecisions, conflictScreens, conflictWaivers, lateralChecks } from "@/db/tables/conflict-check";
import {
  addBusinessHours,
  audit,
  auditBlocked,
  createTask,
  enqueueNotification,
  getFirmSettings,
  raiseFlag,
  toBusinessCalendar,
  type Actor,
} from "@/core";
import { isApproved, PendingApprovalError, placeholderFor, requireApproval } from "@/compliance/approvals";
import { RULE_GATES, VENDOR_GATES } from "@/compliance/gates";
import type { TenantTx } from "@/tenancy/withTenant";
import { assertCan, listConflictAttorneys, listFirmAdmins, type ConflictAccess } from "./access";
import { assessHits, getCheck, latestDecisions, refreshGate, subjectsOf, type ConflictCheckRow, type ConflictDecisionRow } from "./checks";
import { interestOwners, matterIdsForPersonScreens, validateDecision, type DecisionInput } from "./decisions";
import { getESignatureProvider } from "./esign";
import { CONFLICT_COPY_GATES, CONFLICT_RULE_GATES } from "./gates";
import { startNonEngagementLetter } from "./letterService";
import { refreshLateralStatus } from "./lateralService";
import { inquiryPartiesFor } from "./partyIndex";
import { ENGINE, readConflictSettings } from "./settings";
import type { ConflictHit, SearchedName } from "./types";
import { actorFor, completeTaskIfOpen, completeTasksByRef, ConflictError } from "./util";

export type WaiverRow = typeof conflictWaivers.$inferSelect;
export type ScreenRow = typeof conflictScreens.$inferSelect;

// ---------------------------------------------------------------------------
// Review screen (c59 §4.2)
// ---------------------------------------------------------------------------

/** Everything the attorney's review screen shows. Conflicts role only. */
export async function getReviewPacket(tx: TenantTx, input: { tenantId: string; checkId: string; access: ConflictAccess }) {
  assertCan(input.access, "log.view");
  const check = await getCheck(tx, input.tenantId, input.checkId);
  if (!check) throw new ConflictError("Check not found.", 404);
  const hits = check.hits as ConflictHit[];
  if (hits.some((h) => h.sourceType === "interest")) assertCan(input.access, "log.view_interests");
  const assessment = await assessHits(tx, input.tenantId, hits, { checkId: check.id, actor: actorFor(input.access) });
  const decisions = await tx
    .select()
    .from(conflictDecisions)
    .where(and(eq(conflictDecisions.tenantId, input.tenantId), eq(conflictDecisions.checkId, check.id)));
  // Prior decisions on the same parties (other checks), for consistency.
  const partyIds = [...new Set(hits.map((h) => h.partyId).filter((x): x is string => !!x))];
  const priorChecks = partyIds.length
    ? (await tx.select().from(conflictChecks).where(eq(conflictChecks.tenantId, input.tenantId))).filter(
        (c) => c.id !== check.id && (c.hits as ConflictHit[]).some((h) => h.partyId && partyIds.includes(h.partyId))
      )
    : [];
  const priorDecisions = await latestDecisions(tx, input.tenantId, priorChecks.map((c) => c.id));
  await audit(tx, {
    tenantId: input.tenantId,
    engine: ENGINE,
    action: "check.review_viewed",
    entityType: "conflict_check",
    entityId: check.id,
    actor: actorFor(input.access),
  });
  return {
    check,
    searched: check.searchedNames as SearchedName[],
    hits,
    ruleTable: assessment.applied
      ? { applied: true as const, rows: assessment.rows, consent: assessment.consent }
      : { applied: false as const, placeholder: pendingRuleTablePlaceholder() },
    decisions,
    priorDecisions: [...priorDecisions.values()].map((d) => ({ checkId: d.checkId, decision: d.decision, decidedAt: d.decidedAt })),
    overrideAllowed: isApproved(CONFLICT_RULE_GATES.ruleTableOverride.key),
  };
}

function pendingRuleTablePlaceholder(): string {
  return placeholderFor(RULE_GATES.conflictRules.key);
}

// ---------------------------------------------------------------------------
// Recording a decision (c59 §4.3)
// ---------------------------------------------------------------------------

export interface RecordDecisionInput {
  tenantId: string;
  checkId: string;
  decision: DecisionInput;
  access: ConflictAccess;
  now?: Date;
}

export async function recordDecision(tx: TenantTx, input: RecordDecisionInput): Promise<ConflictDecisionRow> {
  const now = input.now ?? new Date();
  const actor: Actor = { type: "user", userId: input.access.userId };
  const check = await getCheck(tx, input.tenantId, input.checkId);
  if (!check) throw new ConflictError("Check not found.", 404);
  const hits = check.hits as ConflictHit[];

  const [attorneys, latest] = await Promise.all([
    listConflictAttorneys(tx, input.tenantId),
    latestDecisions(tx, input.tenantId, [check.id]),
  ]);
  const assessment = await assessHits(tx, input.tenantId, hits, { checkId: check.id, actor });

  const wantsOverride = !!input.decision.overrideRuleTable;
  let overrideGateApproved = false;
  if (wantsOverride) {
    try {
      requireApproval(CONFLICT_RULE_GATES.ruleTableOverride.key, { action: "conflict-check.rule_table_override", tenantId: input.tenantId });
      overrideGateApproved = true;
    } catch (err) {
      if (!(err instanceof PendingApprovalError)) throw err;
      await auditBlocked(tx, err, { tenantId: input.tenantId, engine: ENGINE, entityType: "conflict_check", entityId: check.id, actor });
    }
  }

  const supersedes = input.decision.supersedesDecisionId ?? null;
  const validation = validateDecision(input.decision, {
    check: { outcome: check.outcome as "clear" | "possible" | "definite", status: check.status, hits },
    decider: { userId: input.access.userId, canDecide: input.access.caps.has("decide") },
    assessment,
    overrideGateApproved,
    otherDecidersAvailable: attorneys.all.some((id) => id !== input.access.userId),
    supersedesValid: supersedes ? latest.get(check.id)?.id === supersedes : undefined,
  });
  if (!validation.ok) throw new ConflictError("The decision cannot be recorded.", 422, validation.errors);

  const d = input.decision;
  const [decision] = await tx
    .insert(conflictDecisions)
    .values({
      tenantId: input.tenantId,
      checkId: check.id,
      decision: d.decision,
      reasonCode: d.reasonCode,
      reasonText: d.reasonText?.trim() || null,
      ruleTableRefs: assessment.applied ? assessment.rows.map((r) => r.id) : [],
      overrideFlag: validation.overrideFlag,
      consentPartyIds: d.decision === "proceed_with_consent" ? [...(d.consentPartyIds ?? [])] : [],
      screenedUserIds: [...(d.screenedUserIds ?? [])],
      decidedByUserId: input.access.userId,
      decidedAt: now,
      supersedesDecisionId: supersedes,
    })
    .returning();
  const row = decision!;

  await tx.update(conflictChecks).set({ status: "decided", closedAt: now }).where(eq(conflictChecks.id, check.id));
  await completeTaskIfOpen(tx, { tenantId: input.tenantId, taskId: check.decisionTaskId, by: actor, reason: `Decision recorded: ${d.decision}`, at: now });

  // Superseding a consent/screen decision cancels what it set in motion.
  if (supersedes) {
    await tx
      .update(conflictWaivers)
      .set({ status: "cancelled", updatedAt: now })
      .where(and(eq(conflictWaivers.decisionId, supersedes), inArray(conflictWaivers.status, ["draft", "approved", "sent"])));
    await tx
      .update(conflictScreens)
      .set({ status: "lifted", liftedAt: now })
      .where(and(eq(conflictScreens.decisionId, supersedes), eq(conflictScreens.status, "requested")));
  }

  const firmSettings = await getFirmSettings(tx, input.tenantId);
  const settings = readConflictSettings(firmSettings);
  const calendar = toBusinessCalendar(firmSettings);

  if (d.decision === "proceed_with_consent") {
    for (const partyId of d.consentPartyIds ?? []) {
      await tx.insert(conflictWaivers).values({
        tenantId: input.tenantId,
        decisionId: row.id,
        checkId: check.id,
        clientPartyId: partyId,
        countersignRequired: settings.waiverCountersignRequired,
      });
    }
    await createTask(
      tx,
      {
        tenantId: input.tenantId,
        kind: "conflict-check.waiver_prepare",
        title: "Prepare and approve consent documents",
        description: "Each affected client gets their own document describing only what that client may know.",
        owner: { type: "user", userId: input.access.userId },
        due: { at: addBusinessHours(now, settings.decisionDueBusinessHoursIntake, calendar), clock: "business" },
        matterId: check.matterId,
        intakeSessionId: check.intakeSessionId,
        sourceCard: "c59",
        sourceRef: `conflict_decision:${row.id}`,
        engine: ENGINE,
        createdBy: actor,
      },
      { now, calendar }
    );
  }

  if ((d.screenedUserIds ?? []).length > 0) {
    // One screen per person per affected matter (a lateral or interest check has no matter of its own).
    const matterIds: Array<string | null> = matterIdsForPersonScreens({ ...check, hits });
    if (matterIds.length === 0) matterIds.push(null);
    for (const userId of d.screenedUserIds ?? []) {
      for (const matterId of matterIds) {
        await tx.insert(conflictScreens).values({
          tenantId: input.tenantId,
          decisionId: row.id,
          checkId: check.id,
          screenedUserId: userId,
          matterId,
          intakeSessionId: check.intakeSessionId,
          reason: d.reasonCode,
        });
      }
    }
    // Hand-off to c60 (ethical screens): the screen must be set up and confirmed active.
    await createTask(
      tx,
      {
        tenantId: input.tenantId,
        kind: "conflict-check.screen_setup",
        title: "Set up an ethical screen and send the required notice",
        owner: { type: "user", userId: input.access.userId },
        due: { at: addBusinessHours(now, settings.decisionDueBusinessHoursIntake, calendar), clock: "business" },
        matterId: check.matterId,
        intakeSessionId: check.intakeSessionId,
        sourceCard: "c60",
        sourceRef: `conflict_decision:${row.id}`,
        engine: ENGINE,
        createdBy: actor,
      },
      { now, calendar }
    );
  }

  if (d.decision === "declined") await onDeclined(tx, check, row, input.access, now);

  if (validation.overrideFlag) {
    const admins = await listFirmAdmins(tx, input.tenantId);
    await raiseFlag(
      tx,
      {
        tenantId: input.tenantId,
        type: "conflict-check.decision_override",
        severity: "high",
        audience: "internal",
        title: "A conflicts decision overrode the rule table or a definite result",
        summary: "Open the conflicts log to see the attorney's written explanation.",
        details: { checkId: check.id, decisionId: row.id },
        matterId: check.matterId,
        recipients: { userIds: admins },
        dedupeKey: `conflict-check.override:${row.id}`,
        sourceCard: "c59",
        engine: ENGINE,
      },
      { now }
    );
  }

  await audit(tx, {
    tenantId: input.tenantId,
    engine: ENGINE,
    action: "decision.recorded",
    entityType: "conflict_check",
    entityId: check.id,
    matterId: check.matterId,
    intakeSessionId: check.intakeSessionId,
    actor,
    reason: row.reasonText ?? row.reasonCode,
    payload: {
      decisionId: row.id,
      decision: row.decision,
      reasonCode: row.reasonCode,
      overrideFlag: row.overrideFlag,
      supersedes,
      consentCount: row.consentPartyIds.length,
      screenCount: row.screenedUserIds.length,
    },
  });

  for (const subject of subjectsOf(check)) await refreshGate(tx, input.tenantId, subject, now);
  if (check.lateralCheckId) await refreshLateralStatus(tx, input.tenantId, check.lateralCheckId, now);
  return row;
}

/** The hire (lateral check) or the lawyer (interest hits) a person-level decision concerns. */
async function personsConcerned(tx: TenantTx, check: ConflictCheckRow): Promise<string[]> {
  if (check.lateralCheckId) {
    const [l] = await tx
      .select({ userId: lateralChecks.userId })
      .from(lateralChecks)
      .where(and(eq(lateralChecks.tenantId, check.tenantId), eq(lateralChecks.id, check.lateralCheckId)))
      .limit(1);
    return l ? [l.userId] : [];
  }
  return interestOwners(check.hits as ConflictHit[]);
}

const PRE_ENGAGEMENT_STAGES = ["prospective", "consultation_scheduled", "consult_completed_manual_follow_up", "pending_review", "did_not_schedule"] as const;

async function onDeclined(tx: TenantTx, check: ConflictCheckRow, decision: ConflictDecisionRow, access: ConflictAccess, now: Date) {
  const actor: Actor = { type: "user", userId: access.userId };
  if (check.trigger === "lateral_hire" || check.trigger === "interest") {
    // The lawyer/hire may not work on the affected matter(s): record an exclusion (an active screen,
    // the most restrictive option, so no Rule 1.10 screening approval is needed) and tell the owner.
    const people = await personsConcerned(tx, check);
    const hits = check.hits as ConflictHit[];
    for (const userId of people) {
      for (const matterId of matterIdsForPersonScreens({ ...check, hits })) {
        await tx.insert(conflictScreens).values({
          tenantId: check.tenantId,
          decisionId: decision.id,
          checkId: check.id,
          screenedUserId: userId,
          matterId,
          reason: "excluded_conflict_not_curable",
          status: "active",
          activatedAt: now,
          activatedByUserId: access.userId,
        });
      }
    }
    await raiseFlag(
      tx,
      {
        tenantId: check.tenantId,
        type: "conflict-check.staff_excluded_from_matter",
        severity: "high",
        audience: "internal",
        title: "A lawyer or staff member may not work on an affected matter",
        summary: "The conflicts attorney decided a conflict cannot be cured. Assess whether the firm can keep the affected matter(s).",
        details: { checkId: check.id, decisionId: decision.id },
        recipients: { userIds: await listFirmAdmins(tx, check.tenantId) },
        dedupeKey: `conflict-check.staff_excluded:${decision.id}`,
        sourceCard: check.trigger === "lateral_hire" ? "c61" : "c97",
        engine: ENGINE,
      },
      { now }
    );
    return;
  }

  // Only a not-yet-engaged matter ends as 'declined_conflict'; an open matter is the responsible lawyer's call (c59 Q4).
  let preEngagement = check.trigger === "intake";
  if (check.matterId) {
    const [m] = await tx
      .select({ stage: matters.stage, primaryPartyId: matters.primaryPartyId })
      .from(matters)
      .where(and(eq(matters.tenantId, check.tenantId), eq(matters.id, check.matterId)))
      .limit(1);
    preEngagement = !!m && (PRE_ENGAGEMENT_STAGES as readonly string[]).includes(m.stage);
    if (preEngagement) {
      await tx.update(matters).set({ stage: "declined_conflict" }).where(and(eq(matters.tenantId, check.tenantId), eq(matters.id, check.matterId)));
    }
  }
  if (!preEngagement) return;

  // c62: the prospective client gets a neutral letter. Find them among the searched names.
  const searched = check.searchedNames as SearchedName[];
  const prospect = searched.find((s) => (s.role === "prospective_client" || s.role === "caller" || s.role === "client") && s.partyId);
  let prospectPartyId = prospect?.partyId ?? null;
  if (!prospectPartyId && check.matterId) {
    const [m] = await tx.select({ primaryPartyId: matters.primaryPartyId }).from(matters).where(eq(matters.id, check.matterId)).limit(1);
    prospectPartyId = m?.primaryPartyId ?? null;
  }
  if (!prospectPartyId && check.intakeSessionId) {
    const links = await inquiryPartiesFor(tx, check.tenantId, check.intakeSessionId);
    prospectPartyId = links.find((l) => l.role === "prospective_client" && l.partyId)?.partyId ?? null;
  }
  if (prospectPartyId) {
    await startNonEngagementLetter(tx, {
      tenantId: check.tenantId,
      prospectPartyId,
      declineType: "conflict",
      intakeSessionId: check.intakeSessionId,
      matterId: check.matterId,
      checkId: check.id,
      reviewingUserId: decision.decidedByUserId,
      by: actor,
      now,
    });
  }
}

// ---------------------------------------------------------------------------
// Waivers (c59 §4.4)
// ---------------------------------------------------------------------------

async function getWaiver(tx: TenantTx, tenantId: string, waiverId: string): Promise<WaiverRow> {
  const [row] = await tx.select().from(conflictWaivers).where(and(eq(conflictWaivers.tenantId, tenantId), eq(conflictWaivers.id, waiverId))).limit(1);
  if (!row) throw new ConflictError("Waiver not found.", 404);
  return row;
}

/** Re-evaluate the gate(s) and any lateral check after a waiver changed. */
export async function afterWaiverChange(tx: TenantTx, waiver: WaiverRow, now: Date) {
  const check = await getCheck(tx, waiver.tenantId, waiver.checkId);
  if (check) for (const subject of subjectsOf(check)) await refreshGate(tx, waiver.tenantId, subject, now);
  if (check?.lateralCheckId) await refreshLateralStatus(tx, waiver.tenantId, check.lateralCheckId, now);
}

/**
 * The conflicts attorney approves a waiver draft (the AI never sends an
 * unreviewed waiver). The wording comes from the attorney-reviewed template
 * gate; while it is pending, approval is blocked and logged.
 */
export async function approveWaiver(tx: TenantTx, input: { tenantId: string; waiverId: string; documentId?: string | null; access: ConflictAccess; now?: Date }) {
  assertCan(input.access, "decide");
  const now = input.now ?? new Date();
  const waiver = await getWaiver(tx, input.tenantId, input.waiverId);
  if (waiver.status !== "draft") throw new ConflictError(`Waiver is ${waiver.status}.`);
  try {
    requireApproval(CONFLICT_COPY_GATES.waiverTemplate.key, { action: "conflict-check.waiver_approve", tenantId: input.tenantId });
  } catch (err) {
    if (err instanceof PendingApprovalError) {
      await auditBlocked(tx, err, { tenantId: input.tenantId, engine: ENGINE, entityType: "conflict_waiver", entityId: waiver.id, actor: actorFor(input.access) });
    }
    throw err;
  }
  const [row] = await tx
    .update(conflictWaivers)
    .set({ status: "approved", approvedByUserId: input.access.userId, approvedAt: now, documentId: input.documentId ?? waiver.documentId, updatedAt: now })
    .where(eq(conflictWaivers.id, waiver.id))
    .returning();
  await audit(tx, { tenantId: input.tenantId, engine: ENGINE, action: "waiver.approved", entityType: "conflict_waiver", entityId: waiver.id, actor: actorFor(input.access) });
  return row!;
}

/**
 * Send an approved waiver for e-signature (VENDOR — GATED on
 * vendor.esignature). While the vendor is pending, or with the stub adapter,
 * the waiver stays 'approved' with a visible hold reason; nothing is sent.
 */
export async function sendWaiver(tx: TenantTx, input: { tenantId: string; waiverId: string; access: ConflictAccess; now?: Date }) {
  assertCan(input.access, "decide");
  const now = input.now ?? new Date();
  const waiver = await getWaiver(tx, input.tenantId, input.waiverId);
  if (waiver.status !== "approved") throw new ConflictError("Only an approved waiver can be sent.");
  const actor = actorFor(input.access);

  try {
    requireApproval(VENDOR_GATES.esignature.key, { action: "conflict-check.waiver_send", tenantId: input.tenantId });
  } catch (err) {
    if (!(err instanceof PendingApprovalError)) throw err;
    await auditBlocked(tx, err, { tenantId: input.tenantId, engine: ENGINE, entityType: "conflict_waiver", entityId: waiver.id, actor });
    const [held] = await tx.update(conflictWaivers).set({ holdReason: err.placeholder, updatedAt: now }).where(eq(conflictWaivers.id, waiver.id)).returning();
    return { waiver: held!, outcome: "held" as const, detail: err.placeholder };
  }

  const provider = getESignatureProvider();
  const result = await provider.sendForSignature({
    tenantId: input.tenantId,
    waiverId: waiver.id,
    signerPartyId: waiver.clientPartyId,
    documentId: waiver.documentId,
    countersign: waiver.countersignRequired,
  });
  if (result.outcome !== "sent") {
    const [held] = await tx
      .update(conflictWaivers)
      .set({ holdReason: result.detail ?? `E-signature ${result.outcome}`, updatedAt: now })
      .where(eq(conflictWaivers.id, waiver.id))
      .returning();
    await audit(tx, {
      tenantId: input.tenantId,
      engine: ENGINE,
      action: `waiver.send_${result.outcome}`,
      entityType: "conflict_waiver",
      entityId: waiver.id,
      actor,
      payload: { provider: provider.name, detail: result.detail ?? null },
    });
    return { waiver: held!, outcome: result.outcome, detail: result.detail ?? null };
  }

  const firmSettings = await getFirmSettings(tx, input.tenantId);
  const settings = readConflictSettings(firmSettings);
  const calendar = toBusinessCalendar(firmSettings);
  const dueAt = addBusinessHours(now, settings.waiverDueBusinessHours, calendar);
  const outerLimitAt = addBusinessHours(now, settings.waiverOuterLimitBusinessHours, calendar);
  const [sent] = await tx
    .update(conflictWaivers)
    .set({ status: "sent", sentAt: now, dueAt, outerLimitAt, providerRef: result.envelopeId ?? null, holdReason: null, updatedAt: now })
    .where(eq(conflictWaivers.id, waiver.id))
    .returning();

  // Minimal notice to the client's DV-safe address: "a document needs your signature", no content (c51).
  await enqueueNotification(
    tx,
    {
      tenantId: input.tenantId,
      channel: "email",
      recipient: { type: "party", partyId: waiver.clientPartyId },
      templateKey: CONFLICT_COPY_GATES.waiverSignatureRequest.key,
      payload: waiver.documentId ? { documentId: waiver.documentId } : {},
      sensitive: true,
      dedupeKey: `conflict-check.waiver_sent:${waiver.id}`,
    },
    { now }
  );
  // Internal follow-up owned by the attorney; c45's overdue scan flags it if the client has not signed.
  await createTask(
    tx,
    {
      tenantId: input.tenantId,
      kind: "conflict-check.waiver_signature_due",
      title: "Consent signature outstanding",
      owner: { type: "user", userId: input.access.userId },
      due: { at: dueAt, clock: "business" },
      sourceCard: "c59",
      sourceRef: `conflict_waiver:${waiver.id}`,
      engine: ENGINE,
      createdBy: actor,
    },
    { now, calendar }
  );
  await audit(tx, {
    tenantId: input.tenantId,
    engine: ENGINE,
    action: "waiver.sent",
    entityType: "conflict_waiver",
    entityId: waiver.id,
    actor,
    payload: { dueAt: dueAt.toISOString(), outerLimitAt: outerLimitAt.toISOString(), provider: provider.name },
  });
  return { waiver: sent!, outcome: "sent" as const, detail: null };
}

/**
 * Signature events (from the e-signature webhook, or recorded by the
 * conflicts attorney). `signedOutsidePlatform` records a consent the client
 * signed in person or on paper: allowed only for an attorney-APPROVED waiver,
 * only by a conflicts attorney, and only with the signed copy filed
 * (`documentId`), so the e-signature vendor gate is never needed for it.
 */
export async function recordWaiverEvent(
  tx: TenantTx,
  input: {
    tenantId: string;
    waiverId: string;
    event: "signed" | "countersigned" | "refused";
    at?: Date;
    by: ConflictAccess | Actor;
    signedOutsidePlatform?: boolean;
    documentId?: string | null;
  }
) {
  const at = input.at ?? new Date();
  const actor = actorFor(input.by);
  if ("caps" in input.by) assertCan(input.by, "decide");
  const waiver = await getWaiver(tx, input.tenantId, input.waiverId);

  let set: Partial<typeof conflictWaivers.$inferInsert>;
  if (input.event === "signed") {
    const outside = input.signedOutsidePlatform === true;
    if (outside) {
      if (!("caps" in input.by)) throw new ConflictError("A signature made outside the platform is recorded by the conflicts attorney.", 403);
      if (waiver.status !== "approved" && waiver.status !== "sent") throw new ConflictError("Only an approved waiver can be recorded as signed.");
      const documentId = input.documentId ?? waiver.documentId;
      if (!documentId) throw new ConflictError("File the signed copy first and give its document id.", 422);
      set = { status: "signed", signedAt: at, documentId };
    } else {
      if (waiver.status !== "sent") throw new ConflictError("Only a sent waiver can be signed.");
      set = { status: "signed", signedAt: at };
    }
  } else if (input.event === "countersigned") {
    if (waiver.status !== "signed") throw new ConflictError("The client must sign before the firm countersigns.");
    if (actor.type !== "user") throw new ConflictError("A firm lawyer countersigns.", 403);
    set = { countersignedAt: at, countersignedByUserId: actor.userId };
  } else {
    if (!["sent", "approved"].includes(waiver.status)) throw new ConflictError(`Waiver is ${waiver.status}.`);
    set = { status: "refused", refusedAt: at };
  }
  const [row] = await tx.update(conflictWaivers).set({ ...set, updatedAt: at }).where(eq(conflictWaivers.id, waiver.id)).returning();
  await audit(tx, {
    tenantId: input.tenantId,
    engine: ENGINE,
    action: `waiver.${input.event}`,
    entityType: "conflict_waiver",
    entityId: waiver.id,
    actor,
    payload: { at: at.toISOString(), outsidePlatform: input.signedOutsidePlatform === true },
  });
  if (input.event === "signed" || input.event === "refused") {
    await completeTasksByRef(tx, {
      tenantId: input.tenantId,
      kind: "conflict-check.waiver_signature_due",
      sourceRef: `conflict_waiver:${waiver.id}`,
      by: actor,
      reason: input.event === "signed" ? "Client signed" : "Client declined to sign",
      at,
    });
  }
  if (input.event === "refused") await returnToAttorney(tx, row!, "A client declined to sign a consent document", at);
  await afterWaiverChange(tx, row!, at);
  return row!;
}

/** c59 §4.4.6: refused or past the outer limit — back to the conflicts attorney to decline or re-approach. */
export async function returnToAttorney(tx: TenantTx, waiver: WaiverRow, title: string, now: Date) {
  const [decision] = await tx.select().from(conflictDecisions).where(eq(conflictDecisions.id, waiver.decisionId)).limit(1);
  const owner = decision?.decidedByUserId ?? null;
  const task = await createTask(
    tx,
    {
      tenantId: waiver.tenantId,
      kind: "conflict-check.waiver_redecide",
      title: "Consent not received: decide whether to decline or re-approach",
      owner: owner ? { type: "user", userId: owner } : { type: "firm" },
      due: { hours: 8, clock: "business", from: now },
      sourceCard: "c59",
      sourceRef: `conflict_waiver:${waiver.id}`,
      engine: ENGINE,
    },
    { now }
  );
  if (owner) {
    await raiseFlag(
      tx,
      {
        tenantId: waiver.tenantId,
        type: "conflict-check.waiver_not_signed",
        severity: "warning",
        audience: "internal",
        title,
        summary: "Open the conflicts queue to decide the next step.",
        taskId: task.id,
        recipients: { userIds: [owner] },
        dedupeKey: `conflict-check.waiver_not_signed:${waiver.id}`,
        sourceCard: "c59",
        engine: ENGINE,
      },
      { now }
    );
  }
}

export async function listWaiversForCheck(tx: TenantTx, tenantId: string, checkId: string, access: ConflictAccess) {
  assertCan(access, "log.view");
  return tx
    .select({
      id: conflictWaivers.id,
      status: conflictWaivers.status,
      clientPartyId: conflictWaivers.clientPartyId,
      clientName: parties.fullName,
      sentAt: conflictWaivers.sentAt,
      dueAt: conflictWaivers.dueAt,
      signedAt: conflictWaivers.signedAt,
      countersignedAt: conflictWaivers.countersignedAt,
      holdReason: conflictWaivers.holdReason,
    })
    .from(conflictWaivers)
    .innerJoin(parties, eq(parties.id, conflictWaivers.clientPartyId))
    .where(and(eq(conflictWaivers.tenantId, tenantId), eq(conflictWaivers.checkId, checkId)));
}

// ---------------------------------------------------------------------------
// Screens (hand-off to c60)
// ---------------------------------------------------------------------------

/**
 * Confirm a requested screen is active (c60 confirms; until c60 ships the
 * conflicts attorney records it here with the notice date). For lateral-hire
 * screens this relies on Rule 1.10 screening, so it is gated on
 * `rules.conflict-check.lateral_screening`.
 */
export async function activateScreen(
  tx: TenantTx,
  input: { tenantId: string; screenId: string; noticeSentAt?: Date | null; access: ConflictAccess; now?: Date }
): Promise<ScreenRow> {
  assertCan(input.access, "decide");
  const now = input.now ?? new Date();
  const [screen] = await tx.select().from(conflictScreens).where(and(eq(conflictScreens.tenantId, input.tenantId), eq(conflictScreens.id, input.screenId))).limit(1);
  if (!screen) throw new ConflictError("Screen not found.", 404);
  if (screen.status !== "requested") throw new ConflictError(`Screen is ${screen.status}.`);
  const check = await getCheck(tx, input.tenantId, screen.checkId);
  if (check?.trigger === "lateral_hire") {
    try {
      requireApproval(CONFLICT_RULE_GATES.lateralScreening.key, { action: "conflict-check.lateral_screen_activate", tenantId: input.tenantId });
    } catch (err) {
      if (err instanceof PendingApprovalError) {
        await auditBlocked(tx, err, { tenantId: input.tenantId, engine: ENGINE, entityType: "conflict_screen", entityId: screen.id, actor: actorFor(input.access) });
      }
      throw err;
    }
  }
  const [row] = await tx
    .update(conflictScreens)
    .set({ status: "active", activatedAt: now, activatedByUserId: input.access.userId, noticeSentAt: input.noticeSentAt ?? null })
    .where(eq(conflictScreens.id, screen.id))
    .returning();
  await audit(tx, {
    tenantId: input.tenantId,
    engine: ENGINE,
    action: "screen.activated",
    entityType: "conflict_screen",
    entityId: screen.id,
    matterId: screen.matterId,
    actor: actorFor(input.access),
    payload: { noticeSentAt: input.noticeSentAt?.toISOString() ?? null },
  });
  if (check) for (const subject of subjectsOf(check)) await refreshGate(tx, input.tenantId, subject, now);
  if (check?.lateralCheckId) await refreshLateralStatus(tx, input.tenantId, check.lateralCheckId, now);
  return row!;
}

