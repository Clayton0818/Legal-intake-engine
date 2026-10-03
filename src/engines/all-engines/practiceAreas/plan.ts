// c102 — pure rules for switching practice areas and accepting pack updates.

import { PRACTICE_AREA_IDS, isPracticeAreaId, practiceAreaLabel, type PracticeAreaId } from "@/core/practiceAreas";
import type { PracticeAreaPack } from "../packs/types";

export interface AreaChangePlan {
  ok: boolean;
  errors: string[];
  /** Canonical order, de-duplicated. */
  next: PracticeAreaId[];
  enabled: PracticeAreaId[];
  disabled: PracticeAreaId[];
}

/**
 * Validate a requested set of switched-on areas:
 *  - at least one area stays on;
 *  - only known area ids;
 *  - an area can only be switched ON when its pack exists (Immigration and
 *    Personal Injury until c104/c105 ship). An area that is already on stays
 *    allowed even if its pack were withdrawn, so a firm is never broken.
 */
export function planAreaChange(input: {
  current: readonly string[];
  requested: readonly unknown[];
  available: readonly PracticeAreaId[];
}): AreaChangePlan {
  const errors: string[] = [];
  const unknown = input.requested.filter((v) => !isPracticeAreaId(v));
  if (unknown.length > 0) errors.push(`Unknown practice area(s): ${unknown.map(String).join(", ")}.`);
  const requested = new Set(input.requested.filter(isPracticeAreaId));
  const current = new Set(input.current.filter(isPracticeAreaId));
  const next = PRACTICE_AREA_IDS.filter((id) => requested.has(id));
  if (unknown.length === 0 && next.length === 0) errors.push("At least one practice area must stay switched on.");
  const enabled = next.filter((id) => !current.has(id));
  const disabled = PRACTICE_AREA_IDS.filter((id) => current.has(id) && !requested.has(id));
  for (const id of enabled) {
    if (!input.available.includes(id)) errors.push(`${practiceAreaLabel(id)} is not available yet (its practice-area pack has not shipped).`);
  }
  return { ok: errors.length === 0, errors, next, enabled, disabled };
}

export type PackState = "no_pack" | "not_accepted" | "current" | "update_available";

export function packState(latest: { version: string; contentHash: string } | null, accepted: { version: string; contentHash: string } | null): PackState {
  if (!latest) return "no_pack";
  if (!accepted) return "not_accepted";
  return accepted.version === latest.version && accepted.contentHash === latest.contentHash ? "current" : "update_available";
}

/** Validate an "accept this update" request against what the product ships now. */
export function validateAcceptance(input: {
  latest: { version: string; contentHash: string } | null;
  accepted: { version: string; contentHash: string } | null;
  version: string;
  contentHash: string;
}): string[] {
  if (!input.latest) return ["There is no pack for this practice area."];
  const errors: string[] = [];
  if (input.version !== input.latest.version || input.contentHash !== input.latest.contentHash) {
    errors.push("The pack changed since you reviewed it. Reload, review the changes again, then accept.");
  }
  if (packState(input.latest, input.accepted) === "current") errors.push("This version is already accepted.");
  return errors;
}

export interface PackDiffSection {
  section: string;
  added: string[];
  removed: string[];
  changed: string[];
}

function diffById<T extends { id: string }>(section: string, before: readonly T[], after: readonly T[]): PackDiffSection {
  const b = new Map(before.map((x) => [x.id, JSON.stringify(x)]));
  const a = new Map(after.map((x) => [x.id, JSON.stringify(x)]));
  return {
    section,
    added: [...a.keys()].filter((k) => !b.has(k)),
    removed: [...b.keys()].filter((k) => !a.has(k)),
    changed: [...a.keys()].filter((k) => b.has(k) && b.get(k) !== a.get(k)),
  };
}

/** What changed between the accepted version and the new one, for the firm's review. Pure. */
export function diffPacks(before: PracticeAreaPack, after: PracticeAreaPack): PackDiffSection[] {
  const items = (p: PracticeAreaPack) => p.documents.checklists.flatMap((c) => c.items.map((i) => ({ ...i, id: `${c.id}/${i.id}` })));
  const stages = (p: PracticeAreaPack) => p.stages.tracks.flatMap((t) => t.stages.map((s) => ({ ...s, id: `${t.id}/${s.id}` })));
  const tasks = (p: PracticeAreaPack) => p.tasks.lists.flatMap((l) => l.tasks.map((t) => ({ ...t, trigger: l.trigger, id: `${l.id}/${t.id}` })));
  const sections = [
    diffById("Matter types", before.intake.matterTypes, after.intake.matterTypes),
    diffById("Intake questions", before.intake.questions, after.intake.questions),
    diffById("Safety handling", [{ id: "safety", ...before.intake.safety }], [{ id: "safety", ...after.intake.safety }]),
    diffById("Conflict party roles", before.conflicts.partyRoles, after.conflicts.partyRoles),
    diffById("Document folders", before.documents.folderTemplate, after.documents.folderTemplate),
    diffById("Required documents", items(before), items(after)),
    diffById("Templates", before.documents.templates, after.documents.templates),
    diffById("Stages", stages(before), stages(after)),
    diffById("Tasks", tasks(before), tasks(after)),
    diffById("Rule references", before.deadlines.rules, after.deadlines.rules),
    diffById("Billing defaults", [{ id: "billing", ...before.billing }], [{ id: "billing", ...after.billing }]),
  ];
  return sections.filter((s) => s.added.length + s.removed.length + s.changed.length > 0);
}
