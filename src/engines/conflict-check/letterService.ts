// c62 — declined and conflicted-out inquiries: neutral closing letter, record kept.
// Database side. See letters.ts for the pure rules.

import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { firms, intakeSessions, parties } from "@/db/schema";
import { nonEngagementLetters, inquiryParties } from "@/db/tables/conflict-check";
import {
  addBusinessHours,
  audit,
  auditBlocked,
  createTask,
  enqueueNotification,
  getFirmSettings,
  localDateString,
  raiseFlag,
  toBusinessCalendar,
  SYSTEM_ACTOR,
  type Actor,
} from "@/core";
import { gateStatus, PendingApprovalError, requireApproval } from "@/compliance/approvals";
import { RULE_GATES } from "@/compliance/gates";
import type { TenantTx } from "@/tenancy/withTenant";
import { listConflictAttorneys, listFirmAdmins, type ConflictAccess } from "./access";
import { CONFLICT_COPY_GATES } from "./gates";
import {
  assertNeutralLetter,
  chooseLetterChannel,
  chooseReferral,
  letterRequired,
  needsIndividualApproval,
  renderNonEngagementLetter,
  type DeclineType,
} from "./letters";
import { markInquiryEnded } from "./partyIndex";
import { ENGINE, readConflictSettings } from "./settings";
import { completeTaskIfOpen, ConflictError } from "./util";

export type LetterRow = typeof nonEngagementLetters.$inferSelect;

/** Letter errors carry an HTTP status for the routes. */
export const LetterError = ConflictError;

/** Lawyers may approve letters: attorneys, firm admins, or a conflicts attorney. */
export function canApproveLetters(access: ConflictAccess): boolean {
  return access.userRole === "attorney" || access.userRole === "firm_admin" || access.grant?.role === "conflicts_attorney";
}

export interface StartLetterInput {
  tenantId: string;
  prospectPartyId: string;
  declineType: DeclineType;
  intakeSessionId?: string | null;
  matterId?: string | null;
  checkId?: string | null;
  reviewingUserId?: string | null;
  practiceArea?: string | null;
  by?: Actor;
  now?: Date;
}

/**
 * Start the letter workflow when an intake reaches a declined terminal state
 * (c62 §4.1): a task for the reviewing lawyer due within the firm's send
 * window. Names stay in the party index; inquiry links become 'former'.
 */
export async function startNonEngagementLetter(tx: TenantTx, input: StartLetterInput): Promise<LetterRow | null> {
  const now = input.now ?? new Date();
  const firmSettings = await getFirmSettings(tx, input.tenantId);
  const settings = readConflictSettings(firmSettings);
  const calendar = toBusinessCalendar(firmSettings);
  const actor = input.by ?? SYSTEM_ACTOR;

  if (input.intakeSessionId) await markInquiryEnded(tx, input.tenantId, input.intakeSessionId, now);
  if (!letterRequired(input.declineType, settings)) {
    await audit(tx, {
      tenantId: input.tenantId,
      engine: ENGINE,
      action: "letter.not_required",
      intakeSessionId: input.intakeSessionId ?? null,
      matterId: input.matterId ?? null,
      actor,
      payload: { declineType: input.declineType },
    });
    return null;
  }

  let reviewer = input.reviewingUserId ?? null;
  if (!reviewer) {
    const attorneys = await listConflictAttorneys(tx, input.tenantId);
    reviewer = attorneys.designated ?? attorneys.all[0] ?? (await listFirmAdmins(tx, input.tenantId))[0] ?? null;
  }

  let contactDate = localDateString(now, firmSettings.timeZone);
  if (input.intakeSessionId) {
    const [session] = await tx
      .select({ startedAt: intakeSessions.startedAt })
      .from(intakeSessions)
      .where(and(eq(intakeSessions.tenantId, input.tenantId), eq(intakeSessions.id, input.intakeSessionId)))
      .limit(1);
    if (session) contactDate = localDateString(session.startedAt, firmSettings.timeZone);
  }

  const referral = settings.letterIncludeReferral ? chooseReferral(settings.referralSources, input.practiceArea) : null;
  const task = await createTask(
    tx,
    {
      tenantId: input.tenantId,
      kind: "conflict-check.send_non_engagement_letter",
      title: "Approve and send a non-engagement letter",
      owner: reviewer ? { type: "user", userId: reviewer } : { type: "firm" },
      due: { at: addBusinessHours(now, settings.letterSendWindowBusinessHours, calendar), clock: "business" },
      matterId: input.matterId ?? null,
      intakeSessionId: input.intakeSessionId ?? null,
      sourceCard: "c62",
      engine: ENGINE,
      createdBy: actor,
    },
    { now, calendar }
  );

  const [letter] = await tx
    .insert(nonEngagementLetters)
    .values({
      tenantId: input.tenantId,
      intakeSessionId: input.intakeSessionId ?? null,
      matterId: input.matterId ?? null,
      prospectPartyId: input.prospectPartyId,
      checkId: input.checkId ?? null,
      declineType: input.declineType,
      reviewingUserId: reviewer,
      referralName: referral?.name ?? null,
      contactDate,
      taskId: task.id,
    })
    .returning();
  await audit(tx, {
    tenantId: input.tenantId,
    engine: ENGINE,
    action: "letter.started",
    entityType: "non_engagement_letter",
    entityId: letter!.id,
    intakeSessionId: input.intakeSessionId ?? null,
    matterId: input.matterId ?? null,
    actor,
    payload: { declineType: input.declineType },
  });

  // Firms may approve the template once for non-conflict declines (c62 rule 4).
  if (!needsIndividualApproval(input.declineType, settings) && gateStatus(CONFLICT_COPY_GATES.nonEngagementLetter.key).approved) {
    const approved = await approveLetterInternal(tx, letter!, { auto: true, now });
    return sendLetter(tx, { tenantId: input.tenantId, letterId: approved.id, by: SYSTEM_ACTOR, now });
  }
  return letter!;
}

async function getLetter(tx: TenantTx, tenantId: string, letterId: string): Promise<LetterRow> {
  const [row] = await tx
    .select()
    .from(nonEngagementLetters)
    .where(and(eq(nonEngagementLetters.tenantId, tenantId), eq(nonEngagementLetters.id, letterId)))
    .limit(1);
  if (!row) throw new LetterError("Letter not found.", 404);
  return row;
}

async function otherPartyNames(tx: TenantTx, letter: LetterRow): Promise<string[]> {
  if (!letter.intakeSessionId) return [];
  const rows = await tx
    .select({ fullName: parties.fullName, aliases: parties.aliases })
    .from(inquiryParties)
    .innerJoin(parties, eq(parties.id, inquiryParties.partyId))
    .where(
      and(
        eq(inquiryParties.tenantId, letter.tenantId),
        eq(inquiryParties.intakeSessionId, letter.intakeSessionId),
        sql`${inquiryParties.partyId} <> ${letter.prospectPartyId}`
      )
    );
  return rows.flatMap((r) => [r.fullName, ...r.aliases]);
}

async function approveLetterInternal(
  tx: TenantTx,
  letter: LetterRow,
  opts: { auto?: boolean; by?: ConflictAccess; now: Date }
): Promise<LetterRow> {
  const firmSettings = await getFirmSettings(tx, letter.tenantId);
  const [firm] = await tx.select({ name: firms.name }).from(firms).where(eq(firms.id, letter.tenantId)).limit(1);
  const [prospect] = await tx.select({ fullName: parties.fullName }).from(parties).where(eq(parties.id, letter.prospectPartyId)).limit(1);
  const settings = readConflictSettings(firmSettings);
  const referral = letter.referralName ? settings.referralSources.find((r) => r.name === letter.referralName) ?? null : null;
  const rendered = renderNonEngagementLetter({
    prospectName: prospect?.fullName ?? "",
    firmName: firm?.name ?? "",
    date: localDateString(opts.now, firmSettings.timeZone),
    contactDate: letter.contactDate ?? localDateString(letter.createdAt, firmSettings.timeZone),
    referral,
  });
  assertNeutralLetter(rendered.text, await otherPartyNames(tx, letter));

  const [row] = await tx
    .update(nonEngagementLetters)
    .set({
      status: "approved",
      body: rendered.text,
      referralIncluded: rendered.referralIncluded,
      templateHash: gateStatus(CONFLICT_COPY_GATES.nonEngagementLetter.key).gate.draftHash,
      approvedByUserId: opts.by?.userId ?? null,
      autoApproved: !!opts.auto,
      approvedAt: opts.now,
    })
    .where(eq(nonEngagementLetters.id, letter.id))
    .returning();
  await audit(tx, {
    tenantId: letter.tenantId,
    engine: ENGINE,
    action: "letter.approved",
    entityType: "non_engagement_letter",
    entityId: letter.id,
    intakeSessionId: letter.intakeSessionId,
    matterId: letter.matterId,
    actor: opts.by ? { type: "user", userId: opts.by.userId } : SYSTEM_ACTOR,
    payload: { auto: !!opts.auto, referralIncluded: rendered.referralIncluded },
  });
  return row!;
}

/**
 * A lawyer approves the individual letter (c62 §4.2.2). Blocked (and logged,
 * with a setup flag to the firm admin) while the letter wording is pending
 * attorney review: letters cannot be generated from a placeholder (§4.5).
 */
export async function approveLetter(tx: TenantTx, input: { tenantId: string; letterId: string; access: ConflictAccess; now?: Date }) {
  if (!canApproveLetters(input.access)) throw new LetterError("Only a lawyer can approve a non-engagement letter.", 403);
  const now = input.now ?? new Date();
  const letter = await getLetter(tx, input.tenantId, input.letterId);
  if (letter.status !== "awaiting_approval") throw new LetterError(`Letter is already ${letter.status}.`);
  try {
    requireApproval(CONFLICT_COPY_GATES.nonEngagementLetter.key, { action: "conflict-check.letter_approve", tenantId: input.tenantId });
  } catch (err) {
    if (!(err instanceof PendingApprovalError)) throw err;
    await auditBlocked(tx, err, {
      tenantId: input.tenantId,
      engine: ENGINE,
      entityType: "non_engagement_letter",
      entityId: letter.id,
      intakeSessionId: letter.intakeSessionId,
      actor: { type: "user", userId: input.access.userId },
    });
    await raiseFlag(tx, {
      tenantId: input.tenantId,
      type: "conflict-check.letter_template_pending",
      severity: "warning",
      audience: "internal",
      title: "Non-engagement letter wording is waiting for attorney review",
      summary: "Letters cannot be generated until the template is approved. The letter task stays open.",
      recipients: { userIds: await listFirmAdmins(tx, input.tenantId) },
      dedupeKey: "conflict-check.letter_template_pending",
      sourceCard: "c62",
      engine: ENGINE,
    });
    throw err;
  }
  return approveLetterInternal(tx, letter, { by: input.access, now });
}

/** Send an approved letter through the prospect's verified, DV-safe channel (c62 §4.3). */
export async function sendLetter(
  tx: TenantTx,
  input: { tenantId: string; letterId: string; by: ConflictAccess | Actor; now?: Date }
): Promise<LetterRow> {
  const now = input.now ?? new Date();
  const actor: Actor = "caps" in input.by ? { type: "user", userId: input.by.userId } : input.by;
  if ("caps" in input.by && !canApproveLetters(input.by)) throw new LetterError("Only a lawyer can send a non-engagement letter.", 403);
  const letter = await getLetter(tx, input.tenantId, input.letterId);
  if (letter.status !== "approved") throw new LetterError("Only an approved letter can be sent.");

  const [prospect] = await tx.select().from(parties).where(and(eq(parties.tenantId, input.tenantId), eq(parties.id, letter.prospectPartyId))).limit(1);
  if (!prospect) throw new LetterError("Prospect not found.", 404);
  // Portals are created by the client-portal work; none exists for a declined prospect yet.
  const choice = chooseLetterChannel(prospect, false);

  let row: LetterRow;
  if (choice.channel === "none") {
    [row] = (await tx
      .update(nonEngagementLetters)
      .set({ status: "no_channel" })
      .where(eq(nonEngagementLetters.id, letter.id))
      .returning()) as [LetterRow];
    await flagDeliveryProblem(tx, letter, "No safe way to deliver the letter", choice.reason, now);
  } else {
    await enqueueNotification(
      tx,
      {
        tenantId: input.tenantId,
        channel: "email",
        recipient: { type: "party", partyId: letter.prospectPartyId },
        templateKey: CONFLICT_COPY_GATES.nonEngagementNotice.key,
        payload: letter.documentId ? { documentId: letter.documentId } : {},
        matterId: letter.matterId,
        sensitive: true,
        dedupeKey: `conflict-check.letter:${letter.id}`,
      },
      { now }
    );
    [row] = (await tx
      .update(nonEngagementLetters)
      .set({ status: "sent", channel: choice.channel, sentAt: now })
      .where(eq(nonEngagementLetters.id, letter.id))
      .returning()) as [LetterRow];
    await completeTaskIfOpen(tx, { tenantId: input.tenantId, taskId: letter.taskId, by: actor, reason: "Letter sent", at: now });
  }
  await audit(tx, {
    tenantId: input.tenantId,
    engine: ENGINE,
    action: "letter.send_attempted",
    entityType: "non_engagement_letter",
    entityId: letter.id,
    intakeSessionId: letter.intakeSessionId,
    matterId: letter.matterId,
    actor,
    payload: { channel: choice.channel },
  });
  return row;
}

/** Staff printed and posted the letter. */
export async function recordPostalLetter(tx: TenantTx, input: { tenantId: string; letterId: string; access: ConflictAccess; now?: Date }) {
  if (!canApproveLetters(input.access)) throw new LetterError("Only a lawyer can record the letter as posted.", 403);
  const now = input.now ?? new Date();
  const letter = await getLetter(tx, input.tenantId, input.letterId);
  if (!["approved", "no_channel", "bounced"].includes(letter.status)) throw new LetterError(`Letter is ${letter.status}.`);
  const [row] = await tx
    .update(nonEngagementLetters)
    .set({ status: "sent", channel: "postal", sentAt: now })
    .where(eq(nonEngagementLetters.id, letter.id))
    .returning();
  await completeTaskIfOpen(tx, { tenantId: input.tenantId, taskId: letter.taskId, by: { type: "user", userId: input.access.userId }, reason: "Letter posted", at: now });
  await audit(tx, {
    tenantId: input.tenantId,
    engine: ENGINE,
    action: "letter.posted",
    entityType: "non_engagement_letter",
    entityId: letter.id,
    actor: { type: "user", userId: input.access.userId },
  });
  return row!;
}

/** Delivery report (from the email provider webhook or staff). A bounce is flagged internally (c51 bounce rule). */
export async function recordLetterDelivery(
  tx: TenantTx,
  input: { tenantId: string; letterId: string; status: "delivered" | "bounced"; now?: Date }
): Promise<LetterRow> {
  const now = input.now ?? new Date();
  const letter = await getLetter(tx, input.tenantId, input.letterId);
  const [row] = await tx
    .update(nonEngagementLetters)
    .set(input.status === "delivered" ? { status: "delivered", deliveredAt: now } : { status: "bounced", bouncedAt: now })
    .where(eq(nonEngagementLetters.id, letter.id))
    .returning();
  if (input.status === "bounced") await flagDeliveryProblem(tx, letter, "Non-engagement letter bounced", "The email bounced.", now);
  await audit(tx, {
    tenantId: input.tenantId,
    engine: ENGINE,
    action: `letter.${input.status}`,
    entityType: "non_engagement_letter",
    entityId: letter.id,
  });
  return row!;
}

async function flagDeliveryProblem(tx: TenantTx, letter: LetterRow, title: string, reason: string, now: Date): Promise<void> {
  const recipients = letter.reviewingUserId ? [letter.reviewingUserId] : await listFirmAdmins(tx, letter.tenantId);
  const task = await createTask(
    tx,
    {
      tenantId: letter.tenantId,
      kind: "conflict-check.letter_delivery_problem",
      title: "Try another way to deliver a non-engagement letter, or record that none exists",
      owner: letter.reviewingUserId ? { type: "user", userId: letter.reviewingUserId } : { type: "firm" },
      due: { hours: 8, clock: "business", from: now },
      matterId: letter.matterId,
      intakeSessionId: letter.intakeSessionId,
      sourceCard: "c62",
      sourceRef: `non_engagement_letter:${letter.id}`,
      engine: ENGINE,
    },
    { now }
  );
  await raiseFlag(
    tx,
    {
      tenantId: letter.tenantId,
      type: "conflict-check.letter_delivery_problem",
      severity: "warning",
      audience: "internal",
      title,
      summary: reason,
      taskId: task.id,
      matterId: letter.matterId,
      recipients: { userIds: recipients },
      dedupeKey: `conflict-check.letter_delivery:${letter.id}`,
      sourceCard: "c62",
      engine: ENGINE,
    },
    { now }
  );
}

export async function listLetters(tx: TenantTx, tenantId: string, access: ConflictAccess, statuses?: string[]) {
  if (!canApproveLetters(access) && !access.caps.has("log.view")) throw new LetterError("Not allowed.", 403);
  return tx
    .select({
      id: nonEngagementLetters.id,
      status: nonEngagementLetters.status,
      declineType: nonEngagementLetters.declineType,
      channel: nonEngagementLetters.channel,
      createdAt: nonEngagementLetters.createdAt,
      sentAt: nonEngagementLetters.sentAt,
      reviewingUserId: nonEngagementLetters.reviewingUserId,
      intakeSessionId: nonEngagementLetters.intakeSessionId,
    })
    .from(nonEngagementLetters)
    .where(
      and(eq(nonEngagementLetters.tenantId, tenantId), statuses && statuses.length > 0 ? inArray(nonEngagementLetters.status, statuses) : undefined)
    )
    .limit(200);
}

/**
 * c62 §4.4.2 / c2: purge the narrative of declined inquiries after the
 * retention period. RETENTION RULE — GATED on `rules.retention_periods`:
 * blocked (and logged) until an attorney approves the period. Only inquiries
 * this engine closed with a letter are touched; names stay in the index.
 */
export async function purgeDeclinedNarratives(tx: TenantTx, tenantId: string, now = new Date()): Promise<{ purged: number } | { blocked: string }> {
  try {
    requireApproval(RULE_GATES.retentionPeriods.key, { action: "conflict-check.inquiry_narrative_purge", tenantId });
  } catch (err) {
    if (!(err instanceof PendingApprovalError)) throw err;
    await auditBlocked(tx, err, { tenantId, engine: ENGINE, entityType: "intake_session" });
    return { blocked: err.placeholder };
  }
  const settings = readConflictSettings(await getFirmSettings(tx, tenantId));
  const cutoff = new Date(now.getTime() - settings.declinedNarrativeRetentionDays * 24 * 3_600_000);
  const due = await tx
    .select({ id: nonEngagementLetters.intakeSessionId })
    .from(nonEngagementLetters)
    .where(and(eq(nonEngagementLetters.tenantId, tenantId), lt(nonEngagementLetters.createdAt, cutoff), sql`${nonEngagementLetters.intakeSessionId} is not null`));
  const ids = [...new Set(due.map((d) => d.id!))];
  if (ids.length === 0) return { purged: 0 };
  const purged = await tx
    .update(intakeSessions)
    .set({ collectedAnswers: { purged: true, purgedAt: now.toISOString() }, classifierOutput: null })
    .where(and(eq(intakeSessions.tenantId, tenantId), inArray(intakeSessions.id, ids), sql`not (${intakeSessions.collectedAnswers} ? 'purged')`))
    .returning({ id: intakeSessions.id });
  if (purged.length > 0) {
    await audit(tx, { tenantId, engine: ENGINE, action: "retention.narrative_purged", payload: { count: purged.length } });
  }
  return { purged: purged.length };
}
