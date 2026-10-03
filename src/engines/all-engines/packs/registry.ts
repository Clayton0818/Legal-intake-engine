// c102 — the pack registry. Adding a practice area (c104 Immigration, c105
// Personal Injury) = author its pack as data in ./<area>.ts and add ONE line
// here; registry.test.ts then validates it like every other pack.

import { hashDraft } from "@/compliance/approvals";
import { PRACTICE_AREAS, type PracticeAreaId } from "@/core/practiceAreas";
import { FAMILY_LAW_PACK } from "./family";
import type { PracticeAreaPack } from "./types";
import { stableStringify } from "./validate";

export const PACK_REGISTRY: Readonly<Partial<Record<PracticeAreaId, PracticeAreaPack>>> = Object.freeze({
  family: FAMILY_LAW_PACK,
  // immigration: IMMIGRATION_PACK,      // c104
  // personal_injury: PERSONAL_INJURY_PACK, // c105
});

export function getPack(id: string): PracticeAreaPack | null {
  return (PACK_REGISTRY as Record<string, PracticeAreaPack | undefined>)[id] ?? null;
}

export function listPacks(): PracticeAreaPack[] {
  return PRACTICE_AREAS.map((a) => PACK_REGISTRY[a.id]).filter((p): p is PracticeAreaPack => Boolean(p));
}

/** Areas a firm can switch on today (a pack exists for them). */
export function availablePracticeAreaIds(): PracticeAreaId[] {
  return listPacks().map((p) => p.id);
}

/** Content hash of a pack version (what a firm reviewed and accepted). */
export function packContentHash(pack: PracticeAreaPack): string {
  return hashDraft(stableStringify(pack));
}
