// c102 — the practice-area settings flow (owner/admin, logged) and pack
// version acceptance. Turning an area off never deletes or changes existing
// matters; it only stops new ones (intake reads the switch, c73/c62).

import { and, eq, isNull, sql } from "drizzle-orm";
import { matters } from "@/db/schema";
import { practiceAreaPackAdoptions } from "@/db/tables/all-engines";
import { getFirmSettings, updateFirmSettings } from "@/core/firmSettings";
import { PRACTICE_AREAS, enabledPracticeAreas, isPracticeAreaId, type PracticeAreaId } from "@/core/practiceAreas";
import type { Actor } from "@/core/audit";
import type { TenantTx } from "@/tenancy/withTenant";
import { AllEnginesError } from "../common/errors";
import { FIRM, assertCan } from "../permissions/policy";
import { logAccessChange, type StaffContext } from "../permissions/service";
import { availablePracticeAreaIds, getPack, packContentHash } from "../packs/registry";
import type { PracticeAreaPack } from "../packs/types";
import { diffPacks, packState, planAreaChange, validateAcceptance, type PackDiffSection, type PackState } from "./plan";
import { readPublishedPacks, withPublishedPacks, type PublishedPacks } from "./published";

type AdoptionRow = typeof practiceAreaPackAdoptions.$inferSelect;

async function acceptedAdoptions(tx: TenantTx, tenantId: string): Promise<Map<PracticeAreaId, AdoptionRow>> {
  const rows = await tx
    .select()
    .from(practiceAreaPackAdoptions)
    .where(and(eq(practiceAreaPackAdoptions.tenantId, tenantId), eq(practiceAreaPackAdoptions.status, "accepted")));
  const out = new Map<PracticeAreaId, AdoptionRow>();
  for (const r of rows) if (isPracticeAreaId(r.practiceArea)) out.set(r.practiceArea, r);
  return out;
}

function latestOf(id: PracticeAreaId): { pack: PracticeAreaPack; version: string; contentHash: string } | null {
  const pack = getPack(id);
  return pack ? { pack, version: pack.version, contentHash: packContentHash(pack) } : null;
}

function publishedFrom(adoptions: Map<PracticeAreaId, AdoptionRow>): PublishedPacks {
  const out: PublishedPacks = {};
  for (const [id, a] of adoptions) {
    out[id] = { practiceArea: id, version: a.version, contentHash: a.contentHash, acceptedAt: a.acceptedAt.toISOString(), pack: a.content as unknown as PracticeAreaPack };
  }
  return out;
}

async function insertAdoption(tx: TenantTx, tenantId: string, id: PracticeAreaId, by: Actor, notes: string | null): Promise<AdoptionRow> {
  const latest = latestOf(id);
  if (!latest) throw new AllEnginesError("There is no pack for this practice area.", 404);
  const now = new Date();
  await tx
    .update(practiceAreaPackAdoptions)
    .set({ status: "superseded", supersededAt: now })
    .where(and(eq(practiceAreaPackAdoptions.tenantId, tenantId), eq(practiceAreaPackAdoptions.practiceArea, id), eq(practiceAreaPackAdoptions.status, "accepted")));
  const [row] = await tx
    .insert(practiceAreaPackAdoptions)
    .values({
      tenantId,
      practiceArea: id,
      version: latest.version,
      contentHash: latest.contentHash,
      content: JSON.parse(JSON.stringify(latest.pack)) as Record<string, unknown>,
      status: "accepted",
      acceptedByUserId: by.type === "user" ? by.userId : null,
      acceptedAt: now,
      notes,
    })
    .returning();
  return row!;
}

export interface PracticeAreaOverviewRow {
  id: PracticeAreaId;
  label: string;
  cardId: string;
  enabled: boolean;
  packAvailable: boolean;
  latestVersion: string | null;
  latestContentHash: string | null;
  acceptedVersion: string | null;
  acceptedAt: Date | null;
  state: PackState;
  /** What changed since the accepted version (empty when current). */
  changes: PackDiffSection[];
  latestChangelog: string[];
  openMatters: number;
}

export async function getPracticeAreaOverview(tx: TenantTx, tenantId: string, viewer: StaffContext): Promise<PracticeAreaOverviewRow[]> {
  assertCan(viewer.actor, "practice_areas.manage", FIRM, viewer.config);
  const settings = await getFirmSettings(tx, tenantId);
  const enabled = enabledPracticeAreas(settings);
  const adoptions = await acceptedAdoptions(tx, tenantId);
  const counts = await tx
    .select({ area: matters.practiceArea, n: sql<number>`count(*)::int` })
    .from(matters)
    .where(and(eq(matters.tenantId, tenantId), isNull(matters.closedAt)))
    .groupBy(matters.practiceArea);
  const openBy = new Map(counts.map((c) => [c.area, Number(c.n)]));
  return PRACTICE_AREAS.map((a) => {
    const latest = latestOf(a.id);
    const acc = adoptions.get(a.id) ?? null;
    const state = packState(latest, acc);
    return {
      id: a.id,
      label: a.label,
      cardId: a.cardId,
      enabled: enabled.includes(a.id),
      packAvailable: Boolean(latest),
      latestVersion: latest?.version ?? null,
      latestContentHash: latest?.contentHash ?? null,
      acceptedVersion: acc?.version ?? null,
      acceptedAt: acc?.acceptedAt ?? null,
      state,
      changes: state === "update_available" && latest && acc ? diffPacks(acc.content as unknown as PracticeAreaPack, latest.pack) : [],
      latestChangelog: latest?.pack.changelog ?? [],
      openMatters: openBy.get(a.id) ?? 0,
    };
  });
}

/** Switch practice areas on/off. First switch-on of an area accepts its current pack version. */
export async function setEnabledPracticeAreas(
  tx: TenantTx,
  input: { tenantId: string; by: StaffContext; areas: readonly unknown[]; reason: string }
) {
  const { tenantId, by } = input;
  assertCan(by.actor, "practice_areas.manage", FIRM, by.config);
  if (!input.reason.trim()) throw new AllEnginesError("A reason is required.");
  const settings = await getFirmSettings(tx, tenantId);
  const current = enabledPracticeAreas(settings);
  const plan = planAreaChange({ current, requested: input.areas, available: availablePracticeAreaIds() });
  if (!plan.ok) throw new AllEnginesError("These practice-area settings cannot be saved.", 422, plan.errors);
  if (plan.enabled.length === 0 && plan.disabled.length === 0) return { changed: false, enabled: current };

  const adoptions = await acceptedAdoptions(tx, tenantId);
  for (const id of plan.enabled) {
    if (!adoptions.has(id)) {
      const row = await insertAdoption(tx, tenantId, id, by.auditActor, "Accepted when the practice area was switched on.");
      adoptions.set(id, row);
      await logAccessChange(tx, tenantId, { area: "packs", action: "pack.accepted", by: by.auditActor, practiceArea: id, after: { version: row.version, contentHash: row.contentHash }, reason: input.reason.trim() });
    }
  }
  const openBy = new Map<string, number>();
  for (const id of plan.disabled) {
    const [c] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(matters)
      .where(and(eq(matters.tenantId, tenantId), eq(matters.practiceArea, id), isNull(matters.closedAt)));
    openBy.set(id, Number(c?.n ?? 0));
  }
  await updateFirmSettings(
    tx,
    tenantId,
    { enabledPracticeAreas: plan.next, engineSettings: withPublishedPacks(settings.engineSettings, publishedFrom(adoptions)) },
    by.auditActor
  );
  for (const id of plan.enabled) {
    await logAccessChange(tx, tenantId, { area: "practice_areas", action: "practice_area.enabled", by: by.auditActor, practiceArea: id, before: { enabled: current }, after: { enabled: plan.next }, reason: input.reason.trim() });
  }
  for (const id of plan.disabled) {
    await logAccessChange(tx, tenantId, {
      area: "practice_areas",
      action: "practice_area.disabled",
      by: by.auditActor,
      practiceArea: id,
      before: { enabled: current },
      after: { enabled: plan.next, openMattersKept: openBy.get(id) ?? 0 },
      reason: input.reason.trim(),
    });
  }
  return {
    changed: true,
    enabled: plan.next,
    switchedOn: plan.enabled,
    switchedOff: plan.disabled.map((id) => ({ id, openMattersKept: openBy.get(id) ?? 0 })),
  };
}

/** Accept the product's current version of a pack after reviewing the changes. */
export async function acceptPackUpdate(
  tx: TenantTx,
  input: { tenantId: string; by: StaffContext; area: string; version: string; contentHash: string; notes?: string | null }
) {
  const { tenantId, by } = input;
  assertCan(by.actor, "practice_areas.manage", FIRM, by.config);
  if (!isPracticeAreaId(input.area)) throw new AllEnginesError("Unknown practice area.", 404);
  const adoptions = await acceptedAdoptions(tx, tenantId);
  const previous = adoptions.get(input.area) ?? null;
  const errors = validateAcceptance({ latest: latestOf(input.area), accepted: previous, version: input.version, contentHash: input.contentHash });
  if (errors.length > 0) throw new AllEnginesError("This pack version cannot be accepted.", 409, errors);
  const row = await insertAdoption(tx, tenantId, input.area, by.auditActor, input.notes?.trim() || null);
  adoptions.set(input.area, row);
  const settings = await getFirmSettings(tx, tenantId);
  await updateFirmSettings(tx, tenantId, { engineSettings: withPublishedPacks(settings.engineSettings, publishedFrom(adoptions)) }, by.auditActor);
  await logAccessChange(tx, tenantId, {
    area: "packs",
    action: "pack.accepted",
    by: by.auditActor,
    practiceArea: input.area,
    before: previous ? { version: previous.version, contentHash: previous.contentHash } : null,
    after: { version: row.version, contentHash: row.contentHash },
    reason: input.notes ?? null,
  });
  return { area: input.area, version: row.version, contentHash: row.contentHash, acceptedAt: row.acceptedAt };
}

/** Pure: what the default-adoption hook should do for one firm. */
export function planDefaultAdoptions(input: {
  enabled: readonly PracticeAreaId[];
  accepted: ReadonlyMap<PracticeAreaId, { version: string; contentHash: string }>;
  published: PublishedPacks;
  available: readonly PracticeAreaId[];
}): { adopt: PracticeAreaId[]; republish: boolean } {
  const adopt = input.enabled.filter((id) => input.available.includes(id) && !input.accepted.has(id));
  let republish = adopt.length > 0;
  for (const [id, a] of input.accepted) {
    const p = input.published[id];
    if (!p || p.version !== a.version || p.contentHash !== a.contentHash) republish = true;
  }
  return { adopt, republish };
}

/**
 * Worker hook body: a firm whose areas are on by default (Family Law, founder
 * decision) gets that pack's current version accepted ONCE, by the system, so
 * engines find it in settings. Updates are never accepted automatically. Also
 * repairs a published snapshot that drifted from the accepted row.
 */
export async function ensureDefaultPackAdoptions(tx: TenantTx, tenantId: string) {
  const settings = await getFirmSettings(tx, tenantId);
  const adoptions = await acceptedAdoptions(tx, tenantId);
  const plan = planDefaultAdoptions({
    enabled: enabledPracticeAreas(settings),
    accepted: adoptions,
    published: readPublishedPacks(settings),
    available: availablePracticeAreaIds(),
  });
  if (!plan.republish) return { adopted: [], republished: false };
  const system: Actor = { type: "system" };
  for (const id of plan.adopt) {
    const row = await insertAdoption(tx, tenantId, id, system, "Accepted automatically: practice area switched on by default.");
    adoptions.set(id, row);
    await logAccessChange(tx, tenantId, { area: "packs", action: "pack.accepted", by: system, practiceArea: id, after: { version: row.version, contentHash: row.contentHash }, reason: "Default practice area for a new firm." });
  }
  await updateFirmSettings(tx, tenantId, { engineSettings: withPublishedPacks(settings.engineSettings, publishedFrom(adoptions)) }, system);
  return { adopted: plan.adopt, republished: true };
}
