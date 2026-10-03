// Reference behaviour for pack intake questions: which questions apply, in
// what order, how they render (gated wording only), and which answers are
// safety/urgent signals. Pure apart from legalCopy() reading the approval
// snapshot. The intake engine reproduces this from the published pack data.

import { legalCopyStatus } from "@/compliance/approvals";
import type { IntakeQuestion, PracticeAreaPack } from "./types";

export type Answers = Readonly<Record<string, string | readonly string[] | null | undefined>>;

function answerValues(a: Answers[string]): string[] {
  if (a === null || a === undefined) return [];
  return Array.isArray(a) ? [...a] : [a as string];
}

function appliesTo(q: IntakeQuestion, matterType: string | null): boolean {
  if (q.matterTypes.includes("*")) return true;
  return matterType !== null && q.matterTypes.includes(matterType);
}

/**
 * Questions to ask now, in order. Before the matter type is known only
 * questions for every type ('*') apply — which is why safety, party and
 * existing-order questions are written for all types.
 */
export function applicableQuestions(pack: PracticeAreaPack, matterType: string | null, answers: Answers = {}): IntakeQuestion[] {
  return [...pack.intake.questions]
    .sort((a, b) => a.order - b.order)
    .filter((q) => appliesTo(q, matterType))
    .filter((q) => {
      if (!q.askWhen) return true;
      const got = answerValues(answers[q.askWhen.questionId]);
      return got.some((v) => q.askWhen!.answers.includes(v));
    });
}

/** The client-facing text: approved wording, or the visible pending-review placeholder. */
export function renderQuestion(q: IntakeQuestion): { id: string; text: string; approved: boolean } {
  const { text, approved } = legalCopyStatus(q.prompt.copyKey);
  return { id: q.id, text, approved };
}

export interface SignalResult {
  /** Route to the safety track (c66) now. */
  safety: boolean;
  /** Route to the urgent-legal track (c66). */
  urgent: boolean;
  /** Set parties.dv_sensitive and apply the pack's safe-contact defaults. */
  markDvSensitive: boolean;
  safetyQuestionIds: string[];
  urgentQuestionIds: string[];
  emergencyCategory: string | null;
}

/** Which answers are safety or urgent signals. Fails towards alerting. Pure. */
export function evaluateSignals(pack: PracticeAreaPack, answers: Answers): SignalResult {
  const safetyQuestionIds: string[] = [];
  const urgentQuestionIds: string[] = [];
  for (const q of pack.intake.questions) {
    const got = answerValues(answers[q.id]);
    if (got.length === 0) continue;
    if (q.safetySignalAnswers?.some((v) => got.includes(v))) safetyQuestionIds.push(q.id);
    if (q.urgentSignalAnswers?.some((v) => got.includes(v))) urgentQuestionIds.push(q.id);
  }
  const safety = safetyQuestionIds.length > 0;
  return {
    safety,
    urgent: urgentQuestionIds.length > 0,
    markDvSensitive: safety && pack.intake.safety.markClientDvSensitive,
    safetyQuestionIds,
    urgentQuestionIds,
    emergencyCategory: safety ? pack.intake.safety.routeTo.emergencyCategory : null,
  };
}

/** Unanswered required questions among those that apply. Pure. */
export function missingRequired(pack: PracticeAreaPack, matterType: string | null, answers: Answers): string[] {
  return applicableQuestions(pack, matterType, answers)
    .filter((q) => q.required && answerValues(answers[q.id]).filter((v) => v.trim() !== "").length === 0)
    .map((q) => q.id);
}
