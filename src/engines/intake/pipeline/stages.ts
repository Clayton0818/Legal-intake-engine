// c14 — configurable pipeline stages (pure rules).
//
// Every firm stage maps to exactly one fixed SYSTEM stage (the matter_stage
// enum), so gates, reports and the other engines keep working whatever the
// firm calls things. Firms relabel, reorder, recolour, hide optional stages
// and split a system stage into several firm stages.

import { matterStageEnum } from "@/db/schema";
import type { PipelineStageDef } from "@/db/tables/intake";

export type { PipelineStageDef };

export type SystemStage = (typeof matterStageEnum.enumValues)[number];
export const SYSTEM_STAGES: readonly SystemStage[] = matterStageEnum.enumValues;

/** c14 rule 3: these system stages can never be hidden. */
export const REQUIRED_SYSTEM_STAGES: readonly SystemStage[] = [
  "prospective",
  "consultation_scheduled",
  "pending_review",
  "declined_conflict",
  "retained",
  "closed",
];

/** c14 rule 5: system stages reachable only through a specific product step. */
export const PROTECTED_STAGE_ROUTES: Readonly<Partial<Record<SystemStage, { via: MoveVia; message: string }>>> = {
  retained: { via: "open_matter", message: "A matter can only reach Retained through the Open matter step (c68)." },
  declined_conflict: { via: "conflict_decision", message: "A matter can only be declined for a conflict through a conflict decision (c59)." },
};

/** Stages whose client label may never be firm-authored text mentioning conflicts (c14 rule 8). */
export const CONFLICT_SENSITIVE_STAGES: readonly SystemStage[] = ["pending_review", "declined_conflict"];

export type MoveVia = "manual" | "system" | "open_matter" | "conflict_decision";

const DEFAULT_LABELS: Record<SystemStage, { label: string; colour: string; expected?: number }> = {
  prospective: { label: "Prospective", colour: "#64748b", expected: 8 },
  consultation_scheduled: { label: "Consultation scheduled", colour: "#2563eb" },
  consult_completed_manual_follow_up: { label: "Consult done — follow up", colour: "#7c3aed" },
  pending_review: { label: "Pending review", colour: "#d97706", expected: 24 },
  did_not_schedule: { label: "Did not schedule", colour: "#94a3b8" },
  did_not_hire_referred_out: { label: "Did not hire / referred out", colour: "#94a3b8" },
  declined_conflict: { label: "Declined (conflict)", colour: "#dc2626" },
  retained: { label: "Retained", colour: "#16a34a" },
  closed: { label: "Closed", colour: "#334155" },
};

/** The pipeline a firm has before it edits anything: one firm stage per system stage. */
export function defaultPipeline(): PipelineStageDef[] {
  return SYSTEM_STAGES.map((stage, i) => ({
    key: stage,
    label: DEFAULT_LABELS[stage].label,
    clientLabel: null,
    systemStage: stage,
    order: i,
    colour: DEFAULT_LABELS[stage].colour,
    isDefaultForSystemStage: true,
    hidden: false,
    expectedBusinessHours: DEFAULT_LABELS[stage].expected ?? null,
  }));
}

export function isSystemStage(v: unknown): v is SystemStage {
  return typeof v === "string" && (SYSTEM_STAGES as readonly string[]).includes(v);
}

const KEY_RE = /^[a-z][a-z0-9_]{0,47}$/;
const COLOUR_RE = /^#[0-9a-fA-F]{6}$/;

/** Validation errors for a pipeline (empty = valid). */
export function validatePipeline(stages: readonly PipelineStageDef[], maxStages = 20): string[] {
  const errors: string[] = [];
  if (stages.length === 0) errors.push("A pipeline needs at least one stage per system stage.");
  if (stages.length > maxStages) errors.push(`At most ${maxStages} stages are allowed.`);

  const keys = new Set<string>();
  const labels = new Set<string>();
  for (const s of stages) {
    if (!KEY_RE.test(s.key)) errors.push(`Stage key '${s.key}' must be lowercase letters, digits or _ (max 48).`);
    if (keys.has(s.key)) errors.push(`Stage key '${s.key}' is used twice.`);
    keys.add(s.key);
    const label = s.label?.trim() ?? "";
    if (!label) errors.push(`Stage '${s.key}' needs a label.`);
    if (label.length > 60) errors.push(`Stage '${s.key}': label is longer than 60 characters.`);
    const norm = label.toLowerCase();
    if (label && labels.has(norm)) errors.push(`Label '${label}' is used twice (labels are unique per firm, ignoring case).`);
    labels.add(norm);
    if (!isSystemStage(s.systemStage)) errors.push(`Stage '${s.key}' maps to unknown system stage '${s.systemStage}'.`);
    if (!COLOUR_RE.test(s.colour)) errors.push(`Stage '${s.key}': colour must be a #RRGGBB value.`);
    if (s.expectedBusinessHours != null && !(s.expectedBusinessHours > 0)) {
      errors.push(`Stage '${s.key}': expected duration must be a positive number of business hours.`);
    }
    if (s.clientLabel && CONFLICT_SENSITIVE_STAGES.includes(s.systemStage as SystemStage) && /conflict/i.test(s.clientLabel)) {
      errors.push(`Stage '${s.key}': a client-facing label may never mention conflicts (Rule 1.05).`);
    }
  }

  for (const system of SYSTEM_STAGES) {
    const mapped = stages.filter((s) => s.systemStage === system);
    const visible = mapped.filter((s) => !s.hidden);
    const defaults = mapped.filter((s) => s.isDefaultForSystemStage);
    if (visible.length === 0) {
      if (REQUIRED_SYSTEM_STAGES.includes(system)) {
        errors.push(`System stage '${system}' is required and cannot be hidden.`);
      } else if (mapped.length === 0) {
        errors.push(`System stage '${system}' needs at least one firm stage (it may be hidden).`);
      }
    }
    if (mapped.length > 0 && defaults.length !== 1) {
      errors.push(`System stage '${system}' needs exactly one default firm stage (has ${defaults.length}).`);
    }
    const def = defaults[0];
    if (def && def.hidden && visible.length > 0) {
      errors.push(`The default firm stage for '${system}' cannot be hidden while other stages for it are visible.`);
    }
  }
  return errors;
}

/** Stages sorted for display (order, then key for stability). */
export function sortStages(stages: readonly PipelineStageDef[]): PipelineStageDef[] {
  return [...stages].sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
}

/** The default firm stage for a system stage. */
export function defaultFirmStage(stages: readonly PipelineStageDef[], system: string): PipelineStageDef | undefined {
  return stages.find((s) => s.systemStage === system && s.isDefaultForSystemStage) ?? stages.find((s) => s.systemStage === system);
}

/**
 * Which firm stage a matter is shown in. A stored key that no longer maps to
 * the matter's system stage (or no longer exists) falls back to the default.
 */
export function resolveFirmStage(
  stages: readonly PipelineStageDef[],
  systemStage: string,
  storedKey?: string | null
): PipelineStageDef | undefined {
  if (storedKey) {
    const hit = stages.find((s) => s.key === storedKey && s.systemStage === systemStage);
    if (hit) return hit;
  }
  return defaultFirmStage(stages, systemStage);
}

export type MoveCheck = { ok: true; target: PipelineStageDef } | { ok: false; reason: string };

/** c14 rules 4–5: validate moving a matter to a firm stage. Pure. */
export function validateMove(stages: readonly PipelineStageDef[], toKey: string, via: MoveVia): MoveCheck {
  const target = stages.find((s) => s.key === toKey);
  if (!target) return { ok: false, reason: `Stage '${toKey}' does not exist in the current pipeline.` };
  if (target.hidden && via === "manual") return { ok: false, reason: `Stage '${target.label}' is hidden.` };
  const protectedRoute = PROTECTED_STAGE_ROUTES[target.systemStage as SystemStage];
  if (protectedRoute && via !== protectedRoute.via) return { ok: false, reason: protectedRoute.message };
  return { ok: true, target };
}

export interface HidePlanError {
  key: string;
  reason: string;
}

/**
 * c14 §4.3: hiding a stage that has matters in it needs a target stage in the
 * same system stage. Returns the errors for the proposed pipeline given the
 * current matter counts and the chosen moves. Pure.
 */
export function validateHideMoves(
  previous: readonly PipelineStageDef[],
  next: readonly PipelineStageDef[],
  matterCounts: Readonly<Record<string, number>>,
  moves: Readonly<Record<string, string>>
): HidePlanError[] {
  const errors: HidePlanError[] = [];
  for (const old of previous) {
    const now = next.find((s) => s.key === old.key);
    const disappearing = !now || now.hidden;
    if (!disappearing || (matterCounts[old.key] ?? 0) === 0) continue;
    const targetKey = moves[old.key];
    const target = targetKey ? next.find((s) => s.key === targetKey) : undefined;
    if (!target) {
      errors.push({ key: old.key, reason: `Stage '${old.label}' has matters in it; choose where they move.` });
    } else if (target.hidden) {
      errors.push({ key: old.key, reason: `Target stage '${target.label}' is hidden.` });
    } else if (target.systemStage !== old.systemStage) {
      errors.push({ key: old.key, reason: `Matters in '${old.label}' can only move to a stage in the same system stage (${old.systemStage}).` });
    }
  }
  return errors;
}

/** Label that applied at a point in time, given pipeline versions (newest effective first). Pure. */
export function labelAt(
  versions: readonly { effectiveFrom: Date; stages: readonly PipelineStageDef[] }[],
  at: Date,
  key: string
): string | null {
  const applicable = [...versions]
    .filter((v) => v.effectiveFrom.getTime() <= at.getTime())
    .sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime())[0];
  const stages = applicable?.stages ?? defaultPipeline();
  return stages.find((s) => s.key === key)?.label ?? null;
}

/** Gate key for the attorney-reviewed generic client status of a system stage. */
export function clientStatusGateKey(systemStage: string): string {
  return `copy.intake.client_status.${systemStage}`;
}
