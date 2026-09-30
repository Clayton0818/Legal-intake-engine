// c35 — the synchronous, deterministic classifier (the "rules" path).
//
// `classify()` keeps the exact signature the intake flow engine
// (src/lib/intakeEntryFlow/engine.ts) calls today, so nothing outside this
// directory has to change. It is:
//   - the keyword pre-filter for practice area (./prefilter.ts), and
//   - the reviewed safety triggers (./safetyRules.ts) for safetyFlag — no
//     longer hard-coded false.
//
// The REAL model path is `classifyTriage()` in ./classify.ts (async, gated on
// vendor.ai_model + the attorney-approved prompt), which falls back to this
// function whenever the model can't or mustn't be used. The flow engine's
// switch from `classify()` to `await classifyTriage()` is a shared-file
// change requested in the PR, since the engine lives outside src/llm.

import { prefilter } from "./prefilter";
import { detectSafety } from "./safetyRules";
import type { ClassifyInput, ClassifyOutput, ClassifyTrace } from "./types";

export type { ChatTurn, ClassifyInput, ClassifyOutput, PracticeArea, QueuePriority } from "./types";

export const RULES_MODEL_VERSION = "rules-v1";

/** Combined caller text: the opening statement plus any earlier caller turns. */
export function callerText(input: ClassifyInput): string {
  const earlier = (input.turnHistory ?? []).filter((t) => t.role === "caller").map((t) => t.text);
  return [...earlier, input.freeText].join("\n");
}

/** Deterministic classification + its internal trace. Pure apart from reading gate state. */
export function classifyWithRules(input: ClassifyInput): { output: ClassifyOutput; trace: ClassifyTrace } {
  const text = callerText(input);
  const pre = prefilter(input.freeText);
  const safety = detectSafety(text);
  return {
    output: {
      practiceArea: pre.practiceArea,
      practiceAreaConfidence: pre.practiceAreaConfidence,
      outOfScopeSignal: pre.outOfScopeSignal,
      // Rules don't infer priority; a safety hit is always surfaced first.
      queuePriority: safety.safetyFlag ? "urgent" : "routine",
      queuePriorityConfidence: safety.safetyFlag ? 1 : 0.2,
      safetyFlag: safety.safetyFlag,
      modelVersion: RULES_MODEL_VERSION,
      promptVersion: `safety:${safety.rulesVersion}`,
    },
    trace: {
      source: "rules",
      safetyCategories: safety.categories,
      safetyRulesVersion: safety.rulesVersion,
      safetyRulesApproved: safety.rulesApproved,
    },
  };
}

export function classify(input: ClassifyInput): ClassifyOutput {
  return classifyWithRules(input).output;
}
