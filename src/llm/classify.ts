// c35 — the real triage classifier (llm-triage-classifier.md).
//
//   const out = await classifyTriage({ freeText, localeHint });
//
// Path:
//   1. rules: deterministic pre-filter + reviewed safety triggers (always run);
//   2. model: only when BOTH vendor.ai_model (DPA, ADR-0001 D9) and the
//      attorney-approved system prompt gate are approved. A pending gate is
//      logged through the blocked-action sink and the rules result is used —
//      the "existing mock" is the fallback, never a silent model call;
//   3. the model's reply is schema-validated in code; anything malformed is
//      discarded (fallback to rules);
//   4. combine: safetyFlag = model OR rules (never false because one side
//      missed it); practice area subject to per-class thresholds; an
//      uncertain priority defaults to routine; a safety hit is always urgent.
//
// Nothing here is caller-facing, and nothing here decides eligibility,
// urgency_gate or any deadline.

import { gateStatus, hashDraft, requireApproval, PendingApprovalError } from "@/compliance/approvals";
import { VENDOR_GATES } from "@/compliance/gates";
import { PLATFORM_GATES } from "@/engines/platform/gates";
import { callerText, classifyWithRules } from "./classifier";
import { getTriageModel, ModelNotConfiguredError, ModelTimeoutError, type TriageModel } from "./model";
import { applyThreshold, buildUserMessage, DEFAULT_PRACTICE_AREA_THRESHOLDS, DEFAULT_PRIORITY_THRESHOLD, parseModelOutput } from "./protocol";
import type { ClassifyInput, ClassifyOutput, ClassifyTrace, PracticeArea } from "./types";

export interface ClassifyOptions {
  model?: TriageModel;
  thresholds?: Readonly<Record<PracticeArea, number>>;
  priorityThreshold?: number;
  timeoutMs?: number;
  /** For the blocked-action log. */
  tenantId?: string;
  /** Skip the model when the pre-filter is decisive AND no safety rule fired. Default false: the model also contributes safety and priority signals. */
  shortCircuitDecisive?: boolean;
}

export interface ClassifyResult {
  output: ClassifyOutput;
  trace: ClassifyTrace;
}

/** Returns the prompt text to use, or a fallback reason. Logs blocked attempts. */
function modelPermission(tenantId?: string): { ok: true; prompt: string } | { ok: false; reason: ClassifyTrace["fallbackReason"] } {
  try {
    requireApproval(VENDOR_GATES.aiModel.key, { action: "llm.triage_classify", tenantId });
    requireApproval(PLATFORM_GATES.triagePrompt.key, { action: "llm.triage_classify", tenantId });
  } catch (err) {
    if (err instanceof PendingApprovalError) {
      return { ok: false, reason: err.gateKey === VENDOR_GATES.aiModel.key ? "vendor_gate_pending" : "prompt_gate_pending" };
    }
    throw err;
  }
  const prompt = gateStatus(PLATFORM_GATES.triagePrompt.key).approvedText;
  if (!prompt) return { ok: false, reason: "prompt_gate_pending" };
  return { ok: true, prompt };
}

export async function classifyTriageDetailed(input: ClassifyInput, opts: ClassifyOptions = {}): Promise<ClassifyResult> {
  const rules = classifyWithRules(input);
  if (!input.freeText.trim()) return { ...rules, trace: { ...rules.trace, fallbackReason: "empty_input" } };

  const pre = rules.output;
  if (opts.shortCircuitDecisive && !pre.safetyFlag && pre.practiceArea !== "unknown" && pre.practiceAreaConfidence >= 0.8) {
    return rules;
  }

  const permission = modelPermission(opts.tenantId);
  if (!permission.ok) return { ...rules, trace: { ...rules.trace, fallbackReason: permission.reason } };

  const model = opts.model ?? getTriageModel();
  const started = Date.now();
  let reply;
  try {
    reply = await model.complete({
      system: permission.prompt,
      user: buildUserMessage(callerText(input), input.localeHint),
      maxTokens: 200,
      timeoutMs: opts.timeoutMs ?? 8000,
    });
  } catch (err) {
    const reason: ClassifyTrace["fallbackReason"] =
      err instanceof ModelNotConfiguredError ? "model_not_configured" : err instanceof ModelTimeoutError ? "model_timeout" : "model_error";
    return { ...rules, trace: { ...rules.trace, fallbackReason: reason, latencyMs: Date.now() - started } };
  }
  const latencyMs = Date.now() - started;
  const labels = parseModelOutput(reply.text);
  if (!labels) return { ...rules, trace: { ...rules.trace, fallbackReason: "invalid_model_output", latencyMs } };

  const safetyFlag = labels.safetyFlag || rules.output.safetyFlag;
  const practiceArea = applyThreshold(labels.practiceArea, labels.practiceAreaConfidence, opts.thresholds ?? DEFAULT_PRACTICE_AREA_THRESHOLDS);
  const priorityConfident = labels.queuePriorityConfidence >= (opts.priorityThreshold ?? DEFAULT_PRIORITY_THRESHOLD);

  return {
    output: {
      practiceArea,
      practiceAreaConfidence: labels.practiceAreaConfidence,
      outOfScopeSignal: labels.outOfScopeSignal || rules.output.outOfScopeSignal,
      queuePriority: safetyFlag ? "urgent" : priorityConfident ? labels.queuePriority : "routine",
      queuePriorityConfidence: labels.queuePriorityConfidence,
      safetyFlag,
      modelVersion: `${model.name}:${reply.model}`,
      promptVersion: `prompt:${hashDraft(permission.prompt)};safety:${rules.trace.safetyRulesVersion}`,
    },
    trace: {
      ...rules.trace,
      source: "model",
      modelSafetyFlag: labels.safetyFlag,
      modelPracticeArea: labels.practiceArea,
      latencyMs,
    },
  };
}

export async function classifyTriage(input: ClassifyInput, opts: ClassifyOptions = {}): Promise<ClassifyOutput> {
  return (await classifyTriageDetailed(input, opts)).output;
}
