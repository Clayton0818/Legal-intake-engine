// c68 — turn a prospect into an open matter and hand off to every other
// engine (database operations).
//
// The open is one transaction: stage → retained (only through this action),
// the opening record with its gate evidence, the intake session closed. The
// hand-offs are queued and run by the worker, each in its own savepoint,
// idempotent and retried up to three times; a failure never un-opens the
// matter (the legal step happened) — it shows as "Setup incomplete" and, after
// the last retry, flags the firm admin.

import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { documents, intakeSessions, matterParties, parties } from "@/db/schema";
import { intakeMatterHandoffs, intakeMatterOpenings, intakeOpenGateEvidence, intakeSessionState } from "@/db/tables/intake";
import type { TenantTx } from "@/tenancy/withTenant";
import { isApproved, PendingApprovalError, requireApproval, runGated } from "@/compliance/approvals";
import { RULE_GATES, VENDOR_GATES } from "@/compliance/gates";
import { auditBlocked } from "@/core/audit";
import { normalizeName } from "@/core/contacts";
import { raiseFlag } from "@/core/flags";
import { createTask } from "@/core/tasks";
import type { ScheduledTaskRow } from "@/worker/hooks";
import { OPEN_MATTER_GATES } from "../gates";
import { LAWYER_ROLES, requireStaff, resolveEscalationContacts, STAFF_ROLES, userActor } from "../common/actors";
import { loadIntakeContext, type IntakeContext } from "../common/context";
import { IntakeNotFoundError, IntakeRuleError, IntakeValidationError, requireReason } from "../common/errors";
import { recordIntakeEvent } from "../common/events";
import { notifyParty } from "../common/notify";
import { INTAKE_TASK_TYPES, payloadString, scheduleTask } from "../common/scheduling";
import { getMatter, latestSessionForMatter, type MatterRow } from "../common/sessions";
import { addMinutes } from "../common/time";
import { getConflictStatusForMatter, requestConflictCheck } from "../adapters/conflictStatus";
import { runAutoAssignment } from "../assignment/service";
import { systemMoveMatter } from "../pipeline/service";
import { INTAKE_ENGINE } from "../settings";
import {
  computeGatePanel,
  HANDOFF_ITEMS,
  initialHandoffStatus,
  MAX_HANDOFF_ATTEMPTS,
  parseFeeArrangement,
  partiesNeedRecheck,
  PAYMENT_EVIDENCE_KINDS,
  setupIncomplete,
  shouldRunHandoff,
  type FeeArrangement,
  type GateEvidence,
  type GatePanel,
  type HandoffItem,
  type PaymentEvidenceKind,
} from "./gates";

/** Document statuses that mean the agreement is fully signed. */
const SIGNED_DOCUMENT_STATUSES = ["client_approved", "final", "filed"];

async function loadEvidence(tx: TenantTx, tenantId: string, matterId: string): Promise<(GateEvidence & { id: string })[]> {
  const rows = await tx
    .select()
    .from(intakeOpenGateEvidence)
    .where(and(eq(intakeOpenGateEvidence.tenantId, tenantId), eq(intakeOpenGateEvidence.matterId, matterId), isNull(intakeOpenGateEvidence.supersededAt)));
  return rows.map((r) => ({
    id: r.id,
    gate: r.gate as GateEvidence["gate"],
    status: r.status as GateEvidence["status"],
    evidenceRef: r.evidenceRef,
    details: r.details,
    recordedAt: r.recordedAt,
  }));
}

async function recheckNeeded(tx: TenantTx, tenantId: string, matter: MatterRow, checkedAt: Date | null): Promise<boolean> {
  const rows = await tx
    .select({ normalizedName: parties.normalizedName, addedAt: matterParties.addedAt })
    .from(matterParties)
    .innerJoin(parties, and(eq(parties.id, matterParties.partyId), eq(parties.tenantId, matterParties.tenantId)))
    .where(and(eq(matterParties.tenantId, tenantId), eq(matterParties.matterId, matter.id), isNull(matterParties.endedAt)));
  const session = await latestSessionForMatter(tx, tenantId, matter.id);
  let checkedNames: string[] = [];
  if (session) {
    const [state] = await tx
      .select({ conflictMinimum: intakeSessionState.conflictMinimum })
      .from(intakeSessionState)
      .where(and(eq(intakeSessionState.tenantId, tenantId), eq(intakeSessionState.intakeSessionId, session.id)))
      .limit(1);
    const cm = state?.conflictMinimum ?? {};
    checkedNames = [cm.fullName ?? "", ...(cm.otherPartyNames ?? [])].filter(Boolean).map((n) => normalizeName(n));
  }
  return partiesNeedRecheck(rows, checkedNames, checkedAt);
}

export interface OpenGateView extends GatePanel {
  matterId: string;
  stage: string;
  opened: { retainedAt: Date; openedByUserId: string } | null;
  handoffs: Array<{ item: string; status: string; attempts: number; lastError: string | null; completedAt: Date | null }>;
  setupIncomplete: string[];
  /** The open action also needs the attorney review of these gates. */
  openRuleApproved: boolean;
}

/** The gate panel on a prospective matter (internal; clients see only their own sign/pay tasks). */
export async function getOpenGatePanel(tx: TenantTx, tenantId: string, matterId: string): Promise<OpenGateView> {
  const ctx = await loadIntakeContext(tx, tenantId);
  const matter = await getMatter(tx, tenantId, matterId);
  const conflict = await getConflictStatusForMatter(tx, tenantId, matterId, matter.stage);
  const panel = computeGatePanel({
    conflict: conflict.state,
    conflictRecheckNeeded: await recheckNeeded(tx, tenantId, matter, conflict.checkedAt),
    evidence: await loadEvidence(tx, tenantId, matterId),
    retainerFloorCents: ctx.firm.retainerFloorCents,
  });
  const [opening] = await tx
    .select()
    .from(intakeMatterOpenings)
    .where(and(eq(intakeMatterOpenings.tenantId, tenantId), eq(intakeMatterOpenings.matterId, matterId)))
    .limit(1);
  const handoffs = await tx
    .select()
    .from(intakeMatterHandoffs)
    .where(and(eq(intakeMatterHandoffs.tenantId, tenantId), eq(intakeMatterHandoffs.matterId, matterId)));
  return {
    ...panel,
    matterId,
    stage: matter.stage,
    opened: opening ? { retainedAt: opening.retainedAt, openedByUserId: opening.openedByUserId } : null,
    handoffs: handoffs.map((h) => ({ item: h.item, status: h.status, attempts: h.attempts, lastError: h.lastError, completedAt: h.completedAt })),
    setupIncomplete: setupIncomplete(handoffs),
    openRuleApproved: isApproved(OPEN_MATTER_GATES.openGates.key),
  };
}

export type EvidenceInput =
  | { gate: "engagement_signed"; documentId: string; note?: string }
  | { gate: "fee_arrangement"; fee: FeeArrangement; note?: string }
  | { gate: "first_payment"; kind: PaymentEvidenceKind; paymentRef?: string; amountCents: number; note?: string };

/**
 * Record evidence for a gate. The newest evidence supersedes earlier rows
 * for the same gate (history kept). Nothing here moves money.
 */
export async function recordGateEvidence(tx: TenantTx, input: { tenantId: string; matterId: string; userId: string; evidence: EvidenceInput; now?: Date }) {
  const now = input.now ?? new Date();
  const e = input.evidence;
  const matter = await getMatter(tx, input.tenantId, input.matterId);
  if (matter.stage === "retained" || matter.stage === "closed") throw new IntakeRuleError("This matter is already open; gate evidence can no longer change here.");
  let evidenceRef: string | null = null;
  let details: Record<string, unknown> = {};

  if (e.gate === "engagement_signed") {
    await requireStaff(tx, input.tenantId, input.userId, STAFF_ROLES, "record a signed engagement agreement");
    const [doc] = await tx
      .select({ id: documents.id, status: documents.status })
      .from(documents)
      .where(and(eq(documents.tenantId, input.tenantId), eq(documents.id, e.documentId), eq(documents.matterId, matter.id)))
      .limit(1);
    if (!doc) throw new IntakeNotFoundError("Engagement agreement document");
    if (!SIGNED_DOCUMENT_STATUSES.includes(doc.status)) {
      throw new IntakeRuleError(`The agreement is '${doc.status}'; it must be signed by the client and countersigned (${SIGNED_DOCUMENT_STATUSES.join(" / ")}).`);
    }
    evidenceRef = `document:${doc.id}`;
  } else if (e.gate === "fee_arrangement") {
    await requireStaff(tx, input.tenantId, input.userId, LAWYER_ROLES, "set the fee arrangement");
    const parsed = parseFeeArrangement(e.fee as unknown as Record<string, unknown>);
    if (!parsed.ok) throw new IntakeValidationError(parsed.error);
    details = { ...parsed.value };
    evidenceRef = "signed_agreement";
  } else {
    if (!(PAYMENT_EVIDENCE_KINDS as readonly string[]).includes(e.kind)) throw new IntakeValidationError(`Unknown payment evidence '${e.kind}'.`);
    if (!Number.isInteger(e.amountCents) || e.amountCents <= 0) throw new IntakeValidationError("amountCents must be a positive whole number.");
    if (e.kind === "processor_settled") {
      await requireStaff(tx, input.tenantId, input.userId, ["firm_admin"], "record a settled payment");
      requireApproval(VENDOR_GATES.paymentProcessor.key, { action: "intake.open_gate.processor_payment", tenantId: input.tenantId });
      if (!e.paymentRef?.trim()) throw new IntakeValidationError("A settled payment needs the processor's payment reference.");
      evidenceRef = `payment:${e.paymentRef.trim()}`;
    } else {
      // Pre-c75 path (c68 rule 6): staff attest the deposit was made to trust outside the product.
      await requireStaff(tx, input.tenantId, input.userId, ["firm_admin", "attorney"], "attest a deposit");
      requireApproval(OPEN_MATTER_GATES.retainerAttestation.key, { action: "intake.open_gate.retainer_attestation", tenantId: input.tenantId });
      evidenceRef = "attestation";
    }
    details = { kind: e.kind, amountCents: e.amountCents, attestedByUserId: input.userId, attestedAt: now.toISOString() };
  }

  await tx
    .update(intakeOpenGateEvidence)
    .set({ supersededAt: now })
    .where(and(eq(intakeOpenGateEvidence.tenantId, input.tenantId), eq(intakeOpenGateEvidence.matterId, matter.id), eq(intakeOpenGateEvidence.gate, e.gate), isNull(intakeOpenGateEvidence.supersededAt)));
  const [row] = await tx
    .insert(intakeOpenGateEvidence)
    .values({ tenantId: input.tenantId, matterId: matter.id, gate: e.gate, status: "met", evidenceRef, details, note: e.note ?? null, recordedByUserId: input.userId, recordedAt: now })
    .returning();
  const session = await latestSessionForMatter(tx, input.tenantId, matter.id);
  await recordIntakeEvent(tx, {
    tenantId: input.tenantId,
    intakeSessionId: session?.id ?? null,
    matterId: matter.id,
    eventType: "open_gate_evidence_recorded",
    actor: userActor(input.userId),
    entityType: "open_gate_evidence",
    entityId: row?.id ?? null,
    payload: { gate: e.gate, evidenceRef, kind: e.gate === "first_payment" ? e.kind : undefined },
  });

  // Tell the responsible lawyer when every gate is met (in-app only).
  const panel = await getOpenGatePanel(tx, input.tenantId, matter.id);
  if (panel.canOpen && matter.assignedUserId) {
    await raiseFlag(
      tx,
      {
        tenantId: input.tenantId,
        type: "intake.ready_to_open",
        severity: "info",
        audience: "internal",
        title: "All gates met: the matter is ready to open",
        summary: "Review and click Open matter.",
        matterId: matter.id,
        recipients: { userIds: [matter.assignedUserId] },
        dedupeKey: `intake.ready_to_open:${matter.id}`,
        channels: ["in_app"],
        sourceCard: "c68",
        engine: INTAKE_ENGINE,
      },
      { now }
    );
  }
  return row;
}

/**
 * The lawyer opens the matter (c68 §4 Open). Only an attorney; all gates
 * met; no override; conflict re-check first if parties changed.
 */
export async function openMatter(tx: TenantTx, input: { tenantId: string; matterId: string; userId: string; now?: Date }): Promise<{ matterId: string; retainedAt: Date; handoffs: string[] }> {
  const now = input.now ?? new Date();
  await requireStaff(tx, input.tenantId, input.userId, LAWYER_ROLES, "open a matter");
  requireApproval(OPEN_MATTER_GATES.openGates.key, { action: "intake.open_matter", tenantId: input.tenantId, detail: { matterId: input.matterId } });
  const matter = await getMatter(tx, input.tenantId, input.matterId);
  const [existing] = await tx
    .select()
    .from(intakeMatterOpenings)
    .where(and(eq(intakeMatterOpenings.tenantId, input.tenantId), eq(intakeMatterOpenings.matterId, matter.id)))
    .limit(1);
  if (existing) return { matterId: matter.id, retainedAt: existing.retainedAt, handoffs: [] };

  const ctx = await loadIntakeContext(tx, input.tenantId);
  const conflict = await getConflictStatusForMatter(tx, input.tenantId, matter.id, matter.stage);
  const needRecheck = await recheckNeeded(tx, input.tenantId, matter, conflict.checkedAt);
  const session = await latestSessionForMatter(tx, input.tenantId, matter.id);
  if (needRecheck && session && (conflict.state === "clear" || conflict.state === "attorney_cleared")) {
    await requestConflictCheck(tx, { tenantId: input.tenantId, intakeSessionId: session.id, matterId: matter.id, reason: "A party was added after the last conflict check; re-check before the matter opens (c68 rule 4).", now });
    throw new IntakeRuleError("A party was added since the last conflict check. A re-check has been requested; the matter can open once it is clear.");
  }
  const evidence = await loadEvidence(tx, input.tenantId, matter.id);
  const panel = computeGatePanel({ conflict: conflict.state, conflictRecheckNeeded: needRecheck, evidence, retainerFloorCents: ctx.firm.retainerFloorCents });
  if (!panel.canOpen) {
    throw new IntakeRuleError("The matter cannot open yet.", { outstanding: panel.outstanding.map((o) => ({ gate: o.gate, owner: o.owner, message: o.message })) });
  }
  const feeRow = evidence.find((e) => e.gate === "fee_arrangement");
  const fee = parseFeeArrangement(feeRow!.details);
  if (!fee.ok) throw new IntakeRuleError(fee.error);

  const gateEvidence = {
    conflictResultId: conflict.resultId,
    conflictState: conflict.state,
    evidence: evidence.map((e) => ({ id: e.id, gate: e.gate, evidenceRef: e.evidenceRef })),
    warnings: panel.warnings,
  };
  await tx.insert(intakeMatterOpenings).values({ tenantId: input.tenantId, matterId: matter.id, retainedAt: now, openedByUserId: input.userId, gateEvidence });
  await systemMoveMatter(tx, { tenantId: input.tenantId, matterId: matter.id, systemStage: "retained", via: "open_matter", actor: userActor(input.userId), reason: "Matter opened by the responsible lawyer" });

  // Close every intake session of this matter; answers stay linked (no re-entry, c68 rule 7).
  const sessions = await tx.select({ id: intakeSessions.id, terminalState: intakeSessions.terminalState }).from(intakeSessions).where(and(eq(intakeSessions.tenantId, input.tenantId), eq(intakeSessions.matterId, matter.id)));
  for (const s of sessions) {
    if (!s.terminalState) await tx.update(intakeSessions).set({ terminalState: "retained", completedAt: now }).where(eq(intakeSessions.id, s.id));
    await tx
      .update(intakeSessionState)
      .set({ status: "closed", followUpStoppedAt: now, followUpStopReason: "retained", updatedAt: now })
      .where(and(eq(intakeSessionState.tenantId, input.tenantId), eq(intakeSessionState.intakeSessionId, s.id)));
  }

  for (const item of HANDOFF_ITEMS) {
    await tx
      .insert(intakeMatterHandoffs)
      .values({ tenantId: input.tenantId, matterId: matter.id, item, status: initialHandoffStatus(item, fee.value) })
      .onConflictDoNothing();
  }
  await scheduleTask(tx, { tenantId: input.tenantId, taskType: INTAKE_TASK_TYPES.processHandoffs, dueAt: now, matterId: matter.id, payload: { matterId: matter.id } });
  await recordIntakeEvent(tx, {
    tenantId: input.tenantId,
    intakeSessionId: session?.id ?? null,
    matterId: matter.id,
    eventType: "matter_opened",
    ruleName: "open_matter.all_gates_met",
    firmConfigVersionId: session?.firmConfigVersionId ?? null,
    actor: userActor(input.userId),
    entityType: "matter",
    entityId: matter.id,
    payload: gateEvidence,
  });
  return { matterId: matter.id, retainedAt: now, handoffs: [...HANDOFF_ITEMS] };
}

type HandoffOutcome = { status: "done" | "requested" | "blocked_pending_approval" | "not_applicable"; taskId?: string | null; detail?: string };

async function handoffTask(tx: TenantTx, ctx: IntakeContext, matter: MatterRow, item: HandoffItem, title: string, metadata: Record<string, unknown>, now: Date): Promise<HandoffOutcome> {
  const task = await createTask(
    tx,
    {
      tenantId: ctx.tenantId,
      kind: `intake.handoff_${item}`,
      title,
      owner: { type: "firm" },
      due: { hours: 8, clock: "business" },
      matterId: matter.id,
      sourceCard: "c68",
      sourceRef: `matter_handoff:${matter.id}:${item}`,
      metadata,
      engine: INTAKE_ENGINE,
    },
    { now, calendar: ctx.calendar }
  );
  return { status: "requested", taskId: task.id };
}

async function runHandoff(tx: TenantTx, ctx: IntakeContext, matter: MatterRow, item: HandoffItem, fee: FeeArrangement, existingTaskId: string | null, now: Date): Promise<HandoffOutcome> {
  if (existingTaskId) return { status: "requested", taskId: existingTaskId };
  const session = await latestSessionForMatter(tx, ctx.tenantId, matter.id);
  switch (item) {
    case "party_index": {
      // Caller becomes the client; the other parties named at intake join the matter (c56 searches parties).
      await tx.insert(matterParties).values({ tenantId: ctx.tenantId, matterId: matter.id, partyId: matter.primaryPartyId, role: "client", addedAt: now }).onConflictDoNothing();
      if (session) {
        const [state] = await tx.select({ cm: intakeSessionState.conflictMinimum }).from(intakeSessionState).where(and(eq(intakeSessionState.tenantId, ctx.tenantId), eq(intakeSessionState.intakeSessionId, session.id))).limit(1);
        const existing = await tx
          .select({ normalizedName: parties.normalizedName })
          .from(matterParties)
          .innerJoin(parties, eq(parties.id, matterParties.partyId))
          .where(and(eq(matterParties.tenantId, ctx.tenantId), eq(matterParties.matterId, matter.id), eq(matterParties.role, "opposing_party")));
        const have = new Set(existing.map((e) => e.normalizedName));
        for (const name of state?.cm.otherPartyNames ?? []) {
          const normalized = normalizeName(name);
          if (!normalized || have.has(normalized)) continue;
          const [p] = await tx.insert(parties).values({ tenantId: ctx.tenantId, fullName: name.trim(), normalizedName: normalized }).returning({ id: parties.id });
          if (p) await tx.insert(matterParties).values({ tenantId: ctx.tenantId, matterId: matter.id, partyId: p.id, role: "opposing_party", isAdverse: true, addedAt: now }).onConflictDoNothing();
          have.add(normalized);
        }
      }
      return { status: "done" };
    }
    case "document_checklist":
      return handoffTask(tx, ctx, matter, item, "Start the document checklist for the newly opened matter", { practiceArea: matter.practiceArea }, now);
    case "trust_ledger": {
      if (fee.feeType !== "retainer") return { status: "not_applicable" };
      const gated = await runGated(RULE_GATES.trustAccounting.key, "intake.handoff.trust_ledger", () => true, { tenantId: ctx.tenantId, detail: { matterId: matter.id } });
      if (!gated.ok) {
        await auditBlocked(tx, gated.blocked, { tenantId: ctx.tenantId, engine: INTAKE_ENGINE, matterId: matter.id, entityType: "matter", entityId: matter.id });
        return { status: "blocked_pending_approval", detail: gated.blocked.placeholder };
      }
      return handoffTask(tx, ctx, matter, item, "Open the trust ledger and set the retainer floor", { floorCents: Math.max(ctx.firm.retainerFloorCents, 0), agreementRetainerCents: fee.amountCents }, now);
    }
    case "fee_schedule":
      return handoffTask(tx, ctx, matter, item, "Activate the fee arrangement and pay schedule from the signed agreement", { fee }, now);
    case "client_updates": {
      await notifyParty(tx, { tenantId: ctx.tenantId, partyId: matter.primaryPartyId, templateKey: OPEN_MATTER_GATES.matterOpened.key, channels: ["in_app", "email"], matterId: matter.id, dedupeBase: `intake.matter_opened:${matter.id}` }, { now });
      return handoffTask(tx, ctx, matter, item, "Start the client update rhythm", {}, now);
    }
    case "health_meter":
      return handoffTask(tx, ctx, matter, item, "Start the matter health meter", {}, now);
    case "portal_invite":
      await notifyParty(tx, { tenantId: ctx.tenantId, partyId: matter.primaryPartyId, templateKey: OPEN_MATTER_GATES.portalInvite.key, channels: ["email"], matterId: matter.id, dedupeBase: `intake.portal_invite:${matter.id}` }, { now });
      return { status: "done" };
    case "team": {
      if (matter.assignedUserId) return { status: "done" };
      const run = await runAutoAssignment(tx, { tenantId: ctx.tenantId, matterId: matter.id, trigger: "matter_opened", now });
      if (run.status === "assigned" || run.status === "already_assigned") return { status: "done" };
      throw new Error(`No lawyer could be assigned (${run.status}); the matter is in the unassigned queue.`);
    }
  }
}

/** Run every due hand-off for a matter. Each runs in its own savepoint. */
export async function processHandoffs(tx: TenantTx, tenantId: string, matterId: string, now: Date): Promise<{ done: number; failed: number; pending: number }> {
  const ctx = await loadIntakeContext(tx, tenantId);
  const matter = await getMatter(tx, tenantId, matterId);
  const evidence = await loadEvidence(tx, tenantId, matterId);
  const feeRow = evidence.find((e) => e.gate === "fee_arrangement");
  const fee = feeRow ? parseFeeArrangement(feeRow.details) : null;
  if (!fee?.ok) return { done: 0, failed: 0, pending: 0 };
  const rows = await tx.select().from(intakeMatterHandoffs).where(and(eq(intakeMatterHandoffs.tenantId, tenantId), eq(intakeMatterHandoffs.matterId, matterId)));
  let done = 0;
  let failed = 0;
  let pending = 0;
  for (const h of rows) {
    if (!shouldRunHandoff(h)) continue;
    const item = h.item as HandoffItem;
    try {
      const outcome = await tx.transaction(async (sp) => runHandoff(sp, ctx, matter, item, fee.value, h.taskId, now));
      await tx
        .update(intakeMatterHandoffs)
        .set({
          status: outcome.status,
          attempts: h.attempts + 1,
          lastError: outcome.detail ?? null,
          taskId: outcome.taskId ?? h.taskId,
          completedAt: outcome.status === "done" || outcome.status === "requested" ? now : null,
          updatedAt: now,
        })
        .where(eq(intakeMatterHandoffs.id, h.id));
      await recordIntakeEvent(tx, { tenantId, matterId, eventType: "handoff_run", entityType: "matter_handoff", entityId: h.id, payload: { item, status: outcome.status } });
      done++;
    } catch (err) {
      if (err instanceof PendingApprovalError) throw err;
      const attempts = h.attempts + 1;
      const message = err instanceof Error ? err.message : String(err);
      await tx.update(intakeMatterHandoffs).set({ status: "failed", attempts, lastError: message.slice(0, 500), updatedAt: now }).where(eq(intakeMatterHandoffs.id, h.id));
      await recordIntakeEvent(tx, { tenantId, matterId, eventType: "handoff_failed", entityType: "matter_handoff", entityId: h.id, payload: { item, attempts, error: message.slice(0, 200) } });
      failed++;
      if (attempts >= MAX_HANDOFF_ATTEMPTS) {
        const { owners } = await resolveEscalationContacts(tx, tenantId, ctx.settings);
        if (owners.length > 0) {
          await raiseFlag(
            tx,
            {
              tenantId,
              type: "intake.handoff_failed",
              severity: "high",
              audience: "internal",
              title: "Matter setup incomplete after three attempts",
              summary: `Hand-off '${item}' keeps failing. Open the matter and retry once the cause is fixed.`,
              matterId,
              recipients: { userIds: owners },
              dedupeKey: `intake.handoff_failed:${matterId}:${item}`,
              sourceCard: "c68",
              engine: INTAKE_ENGINE,
            },
            { now }
          );
        }
      } else {
        pending++;
      }
    }
  }
  if (pending > 0) {
    await scheduleTask(tx, { tenantId, taskType: INTAKE_TASK_TYPES.processHandoffs, dueAt: addMinutes(now, 5), matterId, payload: { matterId } });
  }
  return { done, failed, pending };
}

export async function handleProcessHandoffs(tx: TenantTx, tenantId: string, task: ScheduledTaskRow, now: Date): Promise<void> {
  const matterId = payloadString(task.payload, "matterId") ?? task.matterId;
  if (!matterId) return;
  await processHandoffs(tx, tenantId, matterId, now);
}

/** Staff retry a failed or blocked hand-off (idempotent: no duplicate invites or tasks). */
export async function retryHandoff(tx: TenantTx, input: { tenantId: string; matterId: string; item: string; userId: string; now?: Date }) {
  await requireStaff(tx, input.tenantId, input.userId, ["firm_admin", "attorney"], "retry a matter set-up step");
  const now = input.now ?? new Date();
  if (!(HANDOFF_ITEMS as readonly string[]).includes(input.item)) throw new IntakeValidationError(`Unknown hand-off '${input.item}'.`);
  const updated = await tx
    .update(intakeMatterHandoffs)
    .set({ status: "pending", attempts: 0, lastError: null, updatedAt: now })
    .where(and(eq(intakeMatterHandoffs.tenantId, input.tenantId), eq(intakeMatterHandoffs.matterId, input.matterId), eq(intakeMatterHandoffs.item, input.item), inArray(intakeMatterHandoffs.status, ["failed", "blocked_pending_approval"])))
    .returning({ id: intakeMatterHandoffs.id });
  if (updated.length === 0) throw new IntakeRuleError("Only a failed or blocked set-up step can be retried.");
  await recordIntakeEvent(tx, { tenantId: input.tenantId, matterId: input.matterId, eventType: "handoff_retry_requested", actor: userActor(input.userId), payload: { item: input.item } });
  return processHandoffs(tx, input.tenantId, input.matterId, now);
}

/**
 * A payment reversed after opening (chargeback, returned ACH): never an
 * automatic close — flag the lawyer and billing admins (c68 failure paths).
 */
export async function reportPaymentReversal(tx: TenantTx, input: { tenantId: string; matterId: string; userId: string; reason: string; now?: Date }) {
  const reason = requireReason(input.reason, "Reporting a payment reversal");
  await requireStaff(tx, input.tenantId, input.userId, ["firm_admin", "attorney"], "report a payment reversal");
  const now = input.now ?? new Date();
  const matter = await getMatter(tx, input.tenantId, input.matterId);
  const ctx = await loadIntakeContext(tx, input.tenantId);
  const { owners } = await resolveEscalationContacts(tx, input.tenantId, ctx.settings);
  const recipients = [...new Set([...(matter.assignedUserId ? [matter.assignedUserId] : []), ...owners])];
  if (recipients.length > 0) {
    await raiseFlag(
      tx,
      {
        tenantId: input.tenantId,
        type: "intake.payment_reversed",
        severity: "high",
        audience: "internal",
        title: "A payment on an open matter was reversed",
        summary: "The matter stays open. Review with billing; trust-accounting rules apply.",
        matterId: matter.id,
        recipients: { userIds: recipients },
        dedupeKey: `intake.payment_reversed:${matter.id}:${now.toISOString().slice(0, 10)}`,
        sourceCard: "c68",
        engine: INTAKE_ENGINE,
      },
      { now }
    );
  }
  await recordIntakeEvent(tx, { tenantId: input.tenantId, matterId: matter.id, eventType: "payment_reversal_reported", actor: userActor(input.userId), reason });
}

/** Evidence history for a matter (internal). */
export async function listGateEvidence(tx: TenantTx, tenantId: string, matterId: string) {
  return tx
    .select()
    .from(intakeOpenGateEvidence)
    .where(and(eq(intakeOpenGateEvidence.tenantId, tenantId), eq(intakeOpenGateEvidence.matterId, matterId)))
    .orderBy(desc(intakeOpenGateEvidence.recordedAt));
}
