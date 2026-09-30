// c35 — the deterministic keyword pre-filter (llm-triage-classifier.md §5,
// "a deterministic floor"). It is also the whole classifier whenever the
// model path is unavailable (vendor.ai_model or the prompt gate pending, a
// model error, or an invalid model reply). These lists only choose which
// QUESTION BRANCH to offer; the caller always confirms (spec §3), and the
// deterministic out_of_scope_gate decides eligibility (spec §4). They are not
// legal rules.

import type { PracticeArea } from "./types";
import { normalizeText } from "./safetyRules";

// Checked in listed order; the first category with a strictly-higher score
// than every other wins, so an exact tie falls through to `unknown`.
export const KEYWORD_RULES: ReadonlyArray<{ area: PracticeArea; keywords: readonly string[] }> = [
  {
    area: "expunction",
    keywords: ["expunge", "expunction", "expunged", "clear my record", "criminal record", "arrest record", "seal my record"],
  },
  {
    area: "personal_injury",
    keywords: ["car accident", "crash", "injured", "injury", "hurt in", "hit by a car", "insurance company", "slip and fall"],
  },
  { area: "mediation", keywords: ["mediation", "mediator", "mediate"] },
  {
    area: "family_enforcement",
    keywords: ["not following the order", "not paying child support", "contempt", "enforce the order", "violating our order", "wont comply"],
  },
  {
    area: "family_modification",
    keywords: ["modify", "modification", "change the custody", "change our order", "change child support"],
  },
  { area: "family_custody", keywords: ["custody", "visitation", "parenting time", "see my kids", "see my children"] },
  {
    area: "family_divorce",
    keywords: ["divorce", "dissolution of marriage", "separating from my spouse", "leave my husband", "leave my wife", "file for divorce", "getting a divorce"],
  },
  { area: "family_other", keywords: ["adoption", "prenup", "prenuptial", "postnuptial", "name change", "paternity"] },
];

// Advisory-only signal per spec §4 — never a decision.
export const OUT_OF_SCOPE_KEYWORDS: readonly string[] = [
  "just need someone to fill out",
  "just need help with paperwork",
  "fill out the forms",
  "pro se",
  "representing myself",
  "child protective services",
  "cps case",
  "against cps",
];

export interface PrefilterResult {
  practiceArea: PracticeArea | "unknown";
  practiceAreaConfidence: number;
  score: number;
  tie: boolean;
  /** Strong enough that a model call would add little for the practice area. */
  decisive: boolean;
  outOfScopeSignal: boolean;
}

function includesPhrase(norm: string, phrase: string): boolean {
  return ` ${norm} `.includes(` ${normalizeText(phrase)} `);
}

/** Pure. */
export function prefilter(text: string): PrefilterResult {
  const norm = normalizeText(text);
  let bestArea: PracticeArea | null = null;
  let bestScore = 0;
  let tie = false;
  for (const rule of KEYWORD_RULES) {
    const score = rule.keywords.filter((kw) => includesPhrase(norm, kw)).length;
    if (score > bestScore) {
      bestScore = score;
      bestArea = rule.area;
      tie = false;
    } else if (score > 0 && score === bestScore) {
      tie = true;
    }
  }
  const practiceArea = bestArea && !tie ? bestArea : "unknown";
  return {
    practiceArea,
    // A ranking heuristic, not a calibrated probability (spec §5).
    practiceAreaConfidence: practiceArea !== "unknown" ? Math.min(0.5 + bestScore * 0.15, 0.9) : 0.2,
    score: bestScore,
    tie,
    decisive: practiceArea !== "unknown" && bestScore >= 2,
    outOfScopeSignal: OUT_OF_SCOPE_KEYWORDS.some((kw) => includesPhrase(norm, kw)),
  };
}
