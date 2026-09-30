// c35 — what we send to the model and how strictly we read its reply
// (llm-triage-classifier.md §7, OWASP LLM01/LLM05). Pure.

import { isPracticeArea, isQueuePriority, type PracticeArea, type QueuePriority } from "./types";

export const MAX_INPUT_CHARS = 4000;

/**
 * Pure: the user message. Caller text is wrapped in <caller_text> tags; any
 * tag-like sequence inside it is neutralised so the text can't close the
 * wrapper and pose as instructions. Long input is truncated.
 */
export function buildUserMessage(callerText: string, localeHint?: string): string {
  const cleaned = callerText
    .slice(0, MAX_INPUT_CHARS)
    .replace(/<\s*\/?\s*caller_text\s*>/gi, "[tag removed]")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ");
  const locale = localeHint === "es" ? "es" : "en";
  return `Language hint: ${locale}\n<caller_text>\n${cleaned}\n</caller_text>`;
}

export interface ModelLabels {
  practiceArea: PracticeArea | "unknown";
  practiceAreaConfidence: number;
  outOfScopeSignal: boolean;
  queuePriority: QueuePriority;
  queuePriorityConfidence: number;
  safetyFlag: boolean;
}

const EXPECTED_KEYS = [
  "practiceArea",
  "practiceAreaConfidence",
  "outOfScopeSignal",
  "queuePriority",
  "queuePriorityConfidence",
  "safetyFlag",
] as const;

function isConfidence(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
}

/**
 * Pure: parse the reply as exactly one JSON object with exactly the expected
 * keys and in-enum values. Anything else — prose, extra keys (e.g. a
 * "rationale"), out-of-enum labels, confidences outside 0-1 — is a hard
 * failure (null), and the caller falls back to rules.
 */
export function parseModelOutput(text: string): ModelLabels | null {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  let v: unknown;
  try {
    v = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length !== EXPECTED_KEYS.length || !EXPECTED_KEYS.every((k) => keys.includes(k))) return null;
  const pa = o.practiceArea;
  if (!(pa === "unknown" || isPracticeArea(pa))) return null;
  if (!isQueuePriority(o.queuePriority)) return null;
  if (!isConfidence(o.practiceAreaConfidence) || !isConfidence(o.queuePriorityConfidence)) return null;
  if (typeof o.outOfScopeSignal !== "boolean" || typeof o.safetyFlag !== "boolean") return null;
  return {
    practiceArea: pa,
    practiceAreaConfidence: o.practiceAreaConfidence,
    outOfScopeSignal: o.outOfScopeSignal,
    queuePriority: o.queuePriority,
    queuePriorityConfidence: o.queuePriorityConfidence,
    safetyFlag: o.safetyFlag,
  };
}

/**
 * Per-class acceptance thresholds (spec §5). PROVISIONAL: there is no labelled
 * data yet, so every class starts at the same conservative bar, with rarer
 * classes set higher. Re-derive from reliability diagrams on the synthetic
 * set (./eval.ts) and later from sampled production traces.
 */
export const DEFAULT_PRACTICE_AREA_THRESHOLDS: Readonly<Record<PracticeArea, number>> = {
  family_divorce: 0.6,
  family_custody: 0.6,
  family_modification: 0.7,
  family_enforcement: 0.7,
  family_other: 0.75,
  expunction: 0.75,
  personal_injury: 0.7,
  mediation: 0.8,
};

export const DEFAULT_PRIORITY_THRESHOLD = 0.6;

/** Pure: below its class threshold, a label becomes `unknown` (the caller is simply asked). */
export function applyThreshold(
  area: PracticeArea | "unknown",
  confidence: number,
  thresholds: Readonly<Record<PracticeArea, number>> = DEFAULT_PRACTICE_AREA_THRESHOLDS
): PracticeArea | "unknown" {
  if (area === "unknown") return "unknown";
  return confidence >= thresholds[area] ? area : "unknown";
}
