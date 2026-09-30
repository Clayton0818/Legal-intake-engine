// c35 — the classifier contract (llm-triage-classifier.md §2). ClassifyOutput
// is the only thing that crosses the adapter boundary. Deliberately no
// free-text rationale field (spec §7).

// question-bank.yaml's practice_area enum, minus the `unknown` sentinel.
export const PRACTICE_AREAS = [
  "family_divorce",
  "family_custody",
  "family_modification",
  "family_enforcement",
  "family_other",
  "expunction",
  "personal_injury",
  "mediation",
] as const;
export type PracticeArea = (typeof PRACTICE_AREAS)[number];

export const QUEUE_PRIORITIES = ["routine", "elevated", "urgent"] as const;
export type QueuePriority = (typeof QUEUE_PRIORITIES)[number];

export type ChatTurn = { role: "caller" | "system"; text: string };

export interface ClassifyInput {
  /** The caller's own words, unmodified. Data, never instructions (spec §7). */
  freeText: string;
  turnHistory?: ChatTurn[];
  localeHint?: "en" | "es";
}

export interface ClassifyOutput {
  /** `unknown` is a valid, expected output (spec §3). */
  practiceArea: PracticeArea | "unknown";
  /** 0-1; a ranking signal, never a probability taken at face value (spec §5). */
  practiceAreaConfidence: number;
  /** Advisory only — out_of_scope_gate decides (spec §4). */
  outOfScopeSignal: boolean;
  /** Staff-queue sort signal only; never caller-facing, never skips urgency_gate (spec §6). */
  queuePriority: QueuePriority;
  queuePriorityConfidence: number;
  /** Model signal OR the reviewed keyword triggers. Escalate to a human when true (spec §6). */
  safetyFlag: boolean;
  modelVersion: string;
  promptVersion: string;
}

/** Internal-only trace for logs/audit (spec §9). Never shown to callers. */
export interface ClassifyTrace {
  source: "model" | "rules";
  /** Why the model path was not used (or its reply was discarded). */
  fallbackReason?:
    | "vendor_gate_pending"
    | "prompt_gate_pending"
    | "model_not_configured"
    | "model_error"
    | "model_timeout"
    | "invalid_model_output"
    | "empty_input";
  safetyCategories: string[];
  safetyRulesVersion: string;
  safetyRulesApproved: boolean;
  modelSafetyFlag?: boolean;
  /** Model's raw label before per-class thresholds were applied. */
  modelPracticeArea?: PracticeArea | "unknown";
  latencyMs?: number;
}

export function isPracticeArea(v: unknown): v is PracticeArea {
  return typeof v === "string" && (PRACTICE_AREAS as readonly string[]).includes(v);
}
export function isQueuePriority(v: unknown): v is QueuePriority {
  return typeof v === "string" && (QUEUE_PRIORITIES as readonly string[]).includes(v);
}
