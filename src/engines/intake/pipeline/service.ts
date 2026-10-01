// c14 — pipeline stages (database operations).

import { and, desc, eq, lte, sql } from "drizzle-orm";
import { matters } from "@/db/schema";
import { intakeMatterFirmStages, intakePipelineVersions } from "@/db/tables/intake";
import type { TenantTx } from "@/tenancy/withTenant";
import { legalCopy } from "@/compliance/approvals";
import { SYSTEM_ACTOR, type Actor } from "@/core/audit";
import "../gates";
import { requireStaff, userActor } from "../common/actors";
import { IntakeRuleError, IntakeValidationError } from "../common/errors";
import { recordIntakeEvent } from "../common/events";
import { getMatter, latestSessionForMatter } from "../common/sessions";
import { loadIntakeContext } from "../common/context";
import {
  clientStatusGateKey,
  defaultFirmStage,
  defaultPipeline,
  resolveFirmStage,
  sortStages,
  validateHideMoves,
  validateMove,
  validatePipeline,
  type MoveVia,
  type PipelineStageDef,
  type SystemStage,
} from "./stages";

export interface PipelineVersion {
  version: number;
  effectiveFrom: Date | null;
  stages: PipelineStageDef[];
  /** False when the firm has never saved a pipeline (defaults). */
  persisted: boolean;
}

export async function getCurrentPipeline(tx: TenantTx, tenantId: string, at: Date = new Date()): Promise<PipelineVersion> {
  const [row] = await tx
    .select()
    .from(intakePipelineVersions)
    .where(and(eq(intakePipelineVersions.tenantId, tenantId), lte(intakePipelineVersions.effectiveFrom, at)))
    .orderBy(desc(intakePipelineVersions.version))
    .limit(1);
  if (!row) return { version: 0, effectiveFrom: null, stages: defaultPipeline(), persisted: false };
  const stages = row.stages;
  // c14 failure path: a corrupt version never blocks work — fall back to system stages and log.
  if (validatePipeline(stages, 1000).length > 0) {
    console.error(JSON.stringify({ level: "error", event: "intake.pipeline_invalid", tenantId, version: row.version }));
    return { version: row.version, effectiveFrom: row.effectiveFrom, stages: defaultPipeline(), persisted: true };
  }
  return { version: row.version, effectiveFrom: row.effectiveFrom, stages: sortStages(stages), persisted: true };
}

export async function listPipelineVersions(tx: TenantTx, tenantId: string) {
  return tx
    .select()
    .from(intakePipelineVersions)
    .where(eq(intakePipelineVersions.tenantId, tenantId))
    .orderBy(desc(intakePipelineVersions.version));
}

async function matterCountsByFirmStage(tx: TenantTx, tenantId: string, stages: readonly PipelineStageDef[]): Promise<Record<string, number>> {
  const rows = await tx
    .select({ id: matters.id, stage: matters.stage, key: intakeMatterFirmStages.firmStageKey })
    .from(matters)
    .leftJoin(
      intakeMatterFirmStages,
      and(eq(intakeMatterFirmStages.matterId, matters.id), eq(intakeMatterFirmStages.tenantId, matters.tenantId))
    )
    .where(eq(matters.tenantId, tenantId));
  const counts: Record<string, number> = {};
  for (const r of rows) {
    const firm = resolveFirmStage(stages, r.stage, r.key);
    if (firm) counts[firm.key] = (counts[firm.key] ?? 0) + 1;
  }
  return counts;
}

/**
 * Save a new pipeline version (firm_admin only, c14 rule 10). Optimistic
 * concurrency: `expectedVersion` must be the version the admin opened.
 * `moves` maps each hidden/removed stage that still has matters to a target
 * stage in the same system stage; every moved matter is logged.
 */
export async function savePipeline(
  tx: TenantTx,
  input: {
    tenantId: string;
    byUserId: string;
    stages: PipelineStageDef[];
    expectedVersion: number;
    moves?: Record<string, string>;
    now?: Date;
  }
): Promise<PipelineVersion> {
  await requireStaff(tx, input.tenantId, input.byUserId, ["firm_admin"], "edit the pipeline");
  const now = input.now ?? new Date();
  const ctx = await loadIntakeContext(tx, input.tenantId);
  // Serialise concurrent saves for this firm.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`intake.pipeline:${input.tenantId}`}))`);
  const current = await getCurrentPipeline(tx, input.tenantId, now);
  if (current.version !== input.expectedVersion) {
    throw new IntakeRuleError("The pipeline changed since you opened it. Reload to see the newer version.", {
      currentVersion: current.version,
    });
  }
  const stages = sortStages(input.stages).map((s, i) => ({ ...s, order: i, label: s.label.trim() }));
  const errors = validatePipeline(stages, ctx.settings.pipeline.maxStages);
  if (errors.length > 0) throw new IntakeValidationError(errors.join(" "));

  const counts = await matterCountsByFirmStage(tx, input.tenantId, current.stages);
  const moveErrors = validateHideMoves(current.stages, stages, counts, input.moves ?? {});
  if (moveErrors.length > 0) throw new IntakeRuleError(moveErrors.map((e) => e.reason).join(" "), { moveErrors });

  const version = current.version + 1;
  await tx.insert(intakePipelineVersions).values({
    tenantId: input.tenantId,
    version,
    stages,
    effectiveFrom: now,
    createdByUserId: input.byUserId,
  });

  // Move matters out of stages that were hidden/removed.
  for (const [fromKey, toKey] of Object.entries(input.moves ?? {})) {
    const from = current.stages.find((s) => s.key === fromKey);
    if (!from) continue;
    const affected = await tx
      .select({ id: matters.id, stage: matters.stage, key: intakeMatterFirmStages.firmStageKey })
      .from(matters)
      .leftJoin(
        intakeMatterFirmStages,
        and(eq(intakeMatterFirmStages.matterId, matters.id), eq(intakeMatterFirmStages.tenantId, matters.tenantId))
      )
      .where(and(eq(matters.tenantId, input.tenantId), eq(matters.stage, from.systemStage as SystemStage)));
    for (const m of affected) {
      if (resolveFirmStage(current.stages, m.stage, m.key)?.key !== fromKey) continue;
      await setFirmStage(tx, input.tenantId, m.id, toKey, version);
      await logStageChange(tx, {
        tenantId: input.tenantId,
        matterId: m.id,
        fromSystem: m.stage,
        toSystem: m.stage,
        fromKey,
        toKey,
        pipelineVersion: version,
        actor: userActor(input.byUserId),
        reason: "Stage hidden in pipeline edit",
      });
    }
  }

  await recordIntakeEvent(tx, {
    tenantId: input.tenantId,
    eventType: "pipeline_saved",
    actor: userActor(input.byUserId),
    entityType: "pipeline",
    payload: { version, stageCount: stages.length },
  });
  return { version, effectiveFrom: now, stages, persisted: true };
}

async function setFirmStage(tx: TenantTx, tenantId: string, matterId: string, key: string, pipelineVersion: number): Promise<void> {
  await tx
    .insert(intakeMatterFirmStages)
    .values({ tenantId, matterId, firmStageKey: key, pipelineVersion })
    .onConflictDoUpdate({
      target: [intakeMatterFirmStages.tenantId, intakeMatterFirmStages.matterId],
      set: { firmStageKey: key, pipelineVersion, updatedAt: new Date() },
    });
}

async function logStageChange(
  tx: TenantTx,
  e: {
    tenantId: string;
    matterId: string;
    fromSystem: string;
    toSystem: string;
    fromKey: string | null;
    toKey: string;
    pipelineVersion: number;
    actor: Actor;
    reason?: string;
    via?: MoveVia;
  }
): Promise<void> {
  const session = await latestSessionForMatter(tx, e.tenantId, e.matterId);
  await recordIntakeEvent(tx, {
    tenantId: e.tenantId,
    intakeSessionId: session?.id ?? null,
    matterId: e.matterId,
    eventType: "stage_changed",
    ruleName: `pipeline.v${e.pipelineVersion}`,
    firmConfigVersionId: session?.firmConfigVersionId ?? null,
    actor: e.actor,
    reason: e.reason ?? null,
    entityType: "matter",
    entityId: e.matterId,
    payload: {
      fromSystemStage: e.fromSystem,
      toSystemStage: e.toSystem,
      fromFirmStageKey: e.fromKey,
      toFirmStageKey: e.toKey,
      pipelineVersion: e.pipelineVersion,
      via: e.via ?? "manual",
    },
  });
}

async function storedFirmStageKey(tx: TenantTx, tenantId: string, matterId: string): Promise<string | null> {
  const [row] = await tx
    .select({ key: intakeMatterFirmStages.firmStageKey })
    .from(intakeMatterFirmStages)
    .where(and(eq(intakeMatterFirmStages.tenantId, tenantId), eq(intakeMatterFirmStages.matterId, matterId)))
    .limit(1);
  return row?.key ?? null;
}

/** Staff drags a matter to another firm stage (c14 §4 "Move a matter"). */
export async function moveMatterToFirmStage(
  tx: TenantTx,
  input: { tenantId: string; matterId: string; toKey: string; byUserId: string; reason?: string }
): Promise<{ systemStage: string; firmStageKey: string }> {
  await requireStaff(tx, input.tenantId, input.byUserId, ["attorney", "intake_staff", "firm_admin"], "move matters between stages");
  return applyMove(tx, { ...input, via: "manual", actor: userActor(input.byUserId) });
}

/**
 * A product step moves a matter into a system stage (booking → consultation
 * scheduled, c68 open → retained, c73 referral → referred out). Uses the
 * system stage's default firm stage. `via` must match the protected route
 * for retained / declined_conflict.
 */
export async function systemMoveMatter(
  tx: TenantTx,
  input: { tenantId: string; matterId: string; systemStage: SystemStage; via: Exclude<MoveVia, "manual">; actor?: Actor; reason?: string }
): Promise<{ systemStage: string; firmStageKey: string }> {
  const pipeline = await getCurrentPipeline(tx, input.tenantId);
  const target = defaultFirmStage(pipeline.stages, input.systemStage);
  if (!target) throw new IntakeRuleError(`No firm stage maps to '${input.systemStage}'.`);
  return applyMove(tx, { tenantId: input.tenantId, matterId: input.matterId, toKey: target.key, via: input.via, actor: input.actor ?? SYSTEM_ACTOR, reason: input.reason });
}

async function applyMove(
  tx: TenantTx,
  input: { tenantId: string; matterId: string; toKey: string; via: MoveVia; actor: Actor; reason?: string }
): Promise<{ systemStage: string; firmStageKey: string }> {
  const pipeline = await getCurrentPipeline(tx, input.tenantId);
  const check = validateMove(pipeline.stages, input.toKey, input.via);
  if (!check.ok) throw new IntakeRuleError(check.reason);
  const matter = await getMatter(tx, input.tenantId, input.matterId);
  const fromKey = resolveFirmStage(pipeline.stages, matter.stage, await storedFirmStageKey(tx, input.tenantId, matter.id))?.key ?? null;
  const toSystem = check.target.systemStage as SystemStage;
  if (fromKey === check.target.key && matter.stage === toSystem) {
    return { systemStage: matter.stage, firmStageKey: check.target.key };
  }
  if (matter.stage !== toSystem) {
    await tx.update(matters).set({ stage: toSystem }).where(and(eq(matters.tenantId, input.tenantId), eq(matters.id, matter.id)));
  }
  await setFirmStage(tx, input.tenantId, matter.id, check.target.key, pipeline.version);
  await logStageChange(tx, {
    tenantId: input.tenantId,
    matterId: matter.id,
    fromSystem: matter.stage,
    toSystem,
    fromKey,
    toKey: check.target.key,
    pipelineVersion: pipeline.version,
    actor: input.actor,
    reason: input.reason,
    via: input.via,
  });
  return { systemStage: toSystem, firmStageKey: check.target.key };
}

/** Staff-side view of a matter's stage (firm label and colour). */
export async function getMatterStageView(tx: TenantTx, tenantId: string, matterId: string) {
  const [matter, pipeline] = await Promise.all([getMatter(tx, tenantId, matterId), getCurrentPipeline(tx, tenantId)]);
  const firm = resolveFirmStage(pipeline.stages, matter.stage, await storedFirmStageKey(tx, tenantId, matterId));
  return {
    matterId,
    systemStage: matter.stage,
    firmStageKey: firm?.key ?? matter.stage,
    label: firm?.label ?? matter.stage,
    colour: firm?.colour ?? "#64748b",
    pipelineVersion: pipeline.version,
  };
}

/**
 * What a CLIENT may see of the stage (c14 rule 8): only the attorney-reviewed
 * generic status for the system stage (a visible placeholder until approved).
 * Never the firm's internal label. Firm-authored client labels are stored on
 * the pipeline but not shown until the founder decides open question 13 and
 * the wording goes through review.
 */
export async function clientStatusForMatter(tx: TenantTx, tenantId: string, matterId: string): Promise<{ status: string }> {
  const matter = await getMatter(tx, tenantId, matterId);
  return { status: legalCopy(clientStatusGateKey(matter.stage)) };
}
