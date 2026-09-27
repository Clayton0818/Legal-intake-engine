// Practice areas (c102): the firm-settings switch every engine reads. Each
// area is a "pack" that plugs into all five engines; the pilot ships with
// Family Law only (c103, founder decision 2026-09-25).

import { and, eq } from "drizzle-orm";
import { firmSettings } from "@/db/tables/foundation";
import type { TenantTx } from "@/tenancy/withTenant";

export type PracticeAreaId = "family" | "immigration" | "personal_injury";

export interface PracticeAreaInfo {
  id: PracticeAreaId;
  label: string;
  /** Board card for the pack. */
  cardId: string;
  /** True for the pilot pack (switched on by default). */
  pilot: boolean;
}

export const PRACTICE_AREAS: readonly PracticeAreaInfo[] = [
  { id: "family", label: "Family Law", cardId: "c103", pilot: true },
  { id: "immigration", label: "Immigration", cardId: "c104", pilot: false },
  { id: "personal_injury", label: "Personal Injury", cardId: "c105", pilot: false },
] as const;

export const PRACTICE_AREA_IDS: readonly PracticeAreaId[] = PRACTICE_AREAS.map((a) => a.id);

/** Default for a new firm: Family Law only. */
export const DEFAULT_PRACTICE_AREAS: readonly PracticeAreaId[] = ["family"];

export function isPracticeAreaId(value: unknown): value is PracticeAreaId {
  return typeof value === "string" && (PRACTICE_AREA_IDS as readonly string[]).includes(value);
}

export function practiceAreaLabel(id: PracticeAreaId): string {
  return PRACTICE_AREAS.find((a) => a.id === id)?.label ?? id;
}

/**
 * The firm's enabled areas in canonical order, ignoring unknown values
 * (so an area removed from the product never crashes a firm's settings).
 */
export function enabledPracticeAreas(settings: { enabledPracticeAreas: readonly string[] }): PracticeAreaId[] {
  const set = new Set(settings.enabledPracticeAreas);
  return PRACTICE_AREA_IDS.filter((id) => set.has(id));
}

export function isPracticeAreaEnabled(
  settings: { enabledPracticeAreas: readonly string[] },
  id: PracticeAreaId
): boolean {
  return enabledPracticeAreas(settings).includes(id);
}

/** Validate a list from a settings form. Throws on unknown ids; returns canonical order without duplicates. */
export function validatePracticeAreas(values: readonly string[]): PracticeAreaId[] {
  const unknown = values.filter((v) => !isPracticeAreaId(v));
  if (unknown.length > 0) throw new Error(`Unknown practice area(s): ${unknown.join(", ")}.`);
  return enabledPracticeAreas({ enabledPracticeAreas: values });
}

/**
 * Map the intake classifier's finer labels (src/llm/classifier.ts, e.g.
 * 'family_divorce') onto a practice-area pack. Returns null for labels that
 * belong to no pack (e.g. 'expunction', 'mediation', 'unknown').
 */
export function practiceAreaForClassifierLabel(label: string | null | undefined): PracticeAreaId | null {
  if (!label) return null;
  if (label === "family" || label.startsWith("family_")) return "family";
  if (label === "immigration" || label.startsWith("immigration_")) return "immigration";
  if (label === "personal_injury" || label.startsWith("personal_injury_")) return "personal_injury";
  return null;
}

/** Read the firm's enabled areas (Family Law only when the firm has no settings row yet). */
export async function getEnabledPracticeAreas(tx: TenantTx, tenantId: string): Promise<PracticeAreaId[]> {
  const [row] = await tx
    .select({ enabledPracticeAreas: firmSettings.enabledPracticeAreas })
    .from(firmSettings)
    .where(and(eq(firmSettings.tenantId, tenantId)))
    .limit(1);
  return enabledPracticeAreas({ enabledPracticeAreas: row?.enabledPracticeAreas ?? DEFAULT_PRACTICE_AREAS });
}
