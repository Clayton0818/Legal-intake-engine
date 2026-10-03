// c44 — the AI side of deadline tagging (ADR-0001 D9). The model only TAGS a
// message as deadline-related; it never answers the client, never states or
// calculates a date. It is called only when BOTH vendor.ai_model and the
// attorney-reviewed prompt gate are approved and a real (non-stub) adapter is
// installed; otherwise the deterministic rules in ./classify.ts decide alone.
//
// Combination (pure, combineTags):
//   deadline = rules OR ai OR calendar proximity OR staff tag
//   an AI "not deadline-related" answer below the firm's confidence floor is
//   treated as unsure → stricter clock (c44 rule 3).
// The AI can add the stricter clock; it can never take it away.

import { gateStatus, PendingApprovalError, requireApproval } from "@/compliance/approvals";
import { VENDOR_GATES } from "@/compliance/gates";
import { ALERT_RULE_GATES } from "../gates";
import { classifyDeadlineQuestion, type RuleTag } from "./classify";

export interface ModelTag {
  deadlineRelated: boolean;
  /** 0..1 */
  confidence: number;
  model: string;
}

export interface DeadlineTagModel {
  readonly name: string;
  readonly isStub: boolean;
  tag(input: { systemPrompt: string; text: string }): Promise<ModelTag>;
}

export class ModelUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelUnavailableError";
  }
}

/** Stub adapter: records the request (length only), never calls a vendor. */
export class StubDeadlineTagModel implements DeadlineTagModel {
  readonly name = "stub";
  readonly isStub = true;
  readonly calls: Array<{ chars: number; at: Date }> = [];
  async tag(input: { systemPrompt: string; text: string }): Promise<ModelTag> {
    this.calls.push({ chars: input.text.length, at: new Date() });
    throw new ModelUnavailableError("No approved AI vendor adapter is installed (stub).");
  }
}

let installed: DeadlineTagModel = new StubDeadlineTagModel();

export function getDeadlineTagModel(): DeadlineTagModel {
  return installed;
}

/** Install a real adapter — only after vendor.ai_model and the prompt gate are approved. */
export function setDeadlineTagModel(model: DeadlineTagModel): void {
  installed = model;
}

/** Parse/validate a model reply in code; anything malformed is discarded. Pure. */
export function parseModelTag(raw: unknown, model: string): ModelTag | null {
  let v: unknown = raw;
  if (typeof raw === "string") {
    try {
      v = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const related = o.deadline_related ?? o.deadlineRelated;
  const confidence = o.confidence;
  if (typeof related !== "boolean" || typeof confidence !== "number" || !(confidence >= 0 && confidence <= 1)) return null;
  return { deadlineRelated: related, confidence, model };
}

export type TagSource = "rules" | "ai" | "calendar" | "staff";

export interface CombinedTag {
  deadlineRelated: boolean;
  /** The source that set the tag (most specific first: staff, ai, rules, calendar). */
  source: TagSource | null;
  /** True when the stricter clock applies only because something was unsure. */
  appliedBecauseUnsure: boolean;
  detail: Record<string, unknown>;
}

/** Pure combination of every signal. */
export function combineTags(input: {
  rules: RuleTag;
  ai: ModelTag | null;
  aiMinConfidence: number;
  calendarProximity: boolean;
  staff?: boolean | null;
}): CombinedTag {
  const detail: Record<string, unknown> = {
    ruleCertainty: input.rules.certainty,
    ruleMatches: input.rules.matched,
    calendarProximity: input.calendarProximity,
  };
  if (input.ai) detail.ai = { related: input.ai.deadlineRelated, confidence: input.ai.confidence, model: input.ai.model };
  if (input.staff !== undefined && input.staff !== null) {
    return { deadlineRelated: input.staff, source: "staff", appliedBecauseUnsure: false, detail };
  }
  const aiYes = input.ai?.deadlineRelated === true;
  const aiUnsure = input.ai !== null && input.ai.deadlineRelated === false && input.ai.confidence < input.aiMinConfidence;
  if (input.rules.certainty === "clear") return { deadlineRelated: true, source: "rules", appliedBecauseUnsure: false, detail };
  if (aiYes) return { deadlineRelated: true, source: "ai", appliedBecauseUnsure: false, detail };
  if (input.rules.certainty === "uncertain") return { deadlineRelated: true, source: "rules", appliedBecauseUnsure: true, detail };
  if (aiUnsure) return { deadlineRelated: true, source: "ai", appliedBecauseUnsure: true, detail };
  if (input.calendarProximity) return { deadlineRelated: true, source: "calendar", appliedBecauseUnsure: false, detail };
  return { deadlineRelated: false, source: null, appliedBecauseUnsure: false, detail };
}

export type AiAttempt =
  | { status: "used"; tag: ModelTag }
  | { status: "gate_pending"; gateKey: string }
  | { status: "stub" }
  | { status: "failed"; error: string };

/**
 * Ask the AI for a tag if (and only if) every gate is approved and a real
 * adapter is installed. Never throws for a pending gate (the blocked attempt
 * is logged through the approval sink). A malformed or failed reply returns
 * 'failed' and the rules decide.
 */
export async function tryAiTag(text: string, opts: { tenantId?: string; model?: DeadlineTagModel } = {}): Promise<AiAttempt> {
  const model = opts.model ?? installed;
  try {
    requireApproval(VENDOR_GATES.aiModel.key, { action: "calendar-alerts.deadline_tag", tenantId: opts.tenantId });
    requireApproval(ALERT_RULE_GATES.deadlineTagPrompt.key, { action: "calendar-alerts.deadline_tag", tenantId: opts.tenantId });
  } catch (err) {
    if (err instanceof PendingApprovalError) return { status: "gate_pending", gateKey: err.gateKey };
    throw err;
  }
  if (model.isStub) return { status: "stub" };
  const prompt = gateStatus(ALERT_RULE_GATES.deadlineTagPrompt.key).approvedText;
  if (!prompt) return { status: "gate_pending", gateKey: ALERT_RULE_GATES.deadlineTagPrompt.key };
  try {
    const raw = await model.tag({ systemPrompt: prompt, text });
    const parsed = parseModelTag(raw, raw?.model ?? model.name);
    return parsed ? { status: "used", tag: parsed } : { status: "failed", error: "Malformed model reply (discarded)." };
  } catch (err) {
    return { status: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}

/** Rules + (gated) AI, without calendar proximity (the service adds that). */
export async function tagMessage(
  text: string,
  opts: { tenantId?: string; model?: DeadlineTagModel; aiMinConfidence: number; calendarProximity: boolean }
): Promise<{ combined: CombinedTag; ai: AiAttempt; rules: RuleTag }> {
  const rules = classifyDeadlineQuestion(text);
  const ai = await tryAiTag(text, opts);
  const combined = combineTags({
    rules,
    ai: ai.status === "used" ? ai.tag : null,
    aiMinConfidence: opts.aiMinConfidence,
    calendarProximity: opts.calendarProximity,
  });
  return { combined, ai, rules };
}
