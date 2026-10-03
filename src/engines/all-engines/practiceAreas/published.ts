// c102 — THE consumption contract. Engines never import a pack: the firm's
// ACCEPTED pack versions are published into the shared firm settings, at
//
//   firm_settings.engine_settings["all-engines"].practiceAreaPacks[<areaId>]
//     = { practiceArea, version, contentHash, acceptedAt, pack }
//
// and an engine reads them like any other setting:
//
//   const s = await getFirmSettings(tx, tenantId);
//   const bag = engineSetting(s, "all-engines", "practiceAreaPacks", {});
//   const family = enabledPracticeAreas(s).includes("family") ? bag.family?.pack : undefined;
//
// Only switched-on areas count (c102: "only switched-on areas appear to
// clients and staff"); a switched-off area keeps its snapshot so existing
// matters still find their stages, checklists and task lists. Until the
// Foundation moves the PracticeAreaPack type into src/core (Foundation
// request), engines treat `pack` as JSON of that documented shape.
//
// Pure: no database.

import { engineSetting, type FirmSettingsValues } from "@/core/firmSettings";
import { enabledPracticeAreas, isPracticeAreaId, type PracticeAreaId } from "@/core/practiceAreas";
import { ENGINE } from "../common/errors";
import type { PracticeAreaPack } from "../packs/types";

export const PUBLISHED_PACKS_KEY = "practiceAreaPacks";

export interface PublishedPack {
  practiceArea: PracticeAreaId;
  version: string;
  contentHash: string;
  /** ISO timestamp of the acceptance this snapshot comes from. */
  acceptedAt: string;
  pack: PracticeAreaPack;
}

export type PublishedPacks = Partial<Record<PracticeAreaId, PublishedPack>>;

type SettingsLike = Pick<FirmSettingsValues, "engineSettings" | "enabledPracticeAreas">;

/** Every published snapshot (switched on or not). */
export function readPublishedPacks(settings: Pick<FirmSettingsValues, "engineSettings">): PublishedPacks {
  const raw = engineSetting<unknown>(settings, ENGINE, PUBLISHED_PACKS_KEY, {});
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: PublishedPacks = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!isPracticeAreaId(k) || !v || typeof v !== "object") continue;
    const p = v as Partial<PublishedPack>;
    if (typeof p.version === "string" && typeof p.contentHash === "string" && p.pack && typeof p.pack === "object") {
      out[k] = p as PublishedPack;
    }
  }
  return out;
}

/** The accepted pack for a switched-ON area, or null (switched off, or not published yet). */
export function activePack(settings: SettingsLike, id: PracticeAreaId): PublishedPack | null {
  if (!enabledPracticeAreas(settings).includes(id)) return null;
  return readPublishedPacks(settings)[id] ?? null;
}

/** Accepted packs for every switched-on area, in canonical order. */
export function activePacks(settings: SettingsLike): PublishedPack[] {
  const published = readPublishedPacks(settings);
  return enabledPracticeAreas(settings)
    .map((id) => published[id])
    .filter((p): p is PublishedPack => Boolean(p));
}

/** The engine_settings value to write when publishing (other engines' bags untouched). */
export function withPublishedPacks(
  engineSettings: FirmSettingsValues["engineSettings"],
  packs: PublishedPacks
): FirmSettingsValues["engineSettings"] {
  return { ...engineSettings, [ENGINE]: { ...(engineSettings[ENGINE] ?? {}), [PUBLISHED_PACKS_KEY]: packs } };
}
