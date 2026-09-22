// PLACEHOLDER — mock practice-area / triage classifier for board card c23.
//
// This is NOT the real c13 implementation. `docs/product/spec/
// llm-triage-classifier.md` is the design document for that; `src/llm/
// README.md` says every model call belongs behind this directory's
// adapter, and this file is that adapter's CURRENT, TEMPORARY body. It
// does simple keyword/rule-based matching against
// `docs/product/spec/question-bank.yaml`'s `practice_area` enum — there is
// no model call here, no vendor SDK, and no accuracy guarantee. Nothing
// calling this function should assume its output is more reliable than a
// rough first guess. That is exactly why `intake-flow.yaml`'s
// `classify_practice_area` node requires a caller-confirmed classification
// rather than trusting any classifier silently (see the design doc's §3).
//
// Replace the body of `classify()` with a real model call, behind this
// same exported function signature, when c13 is implemented. Nothing
// outside this file should need to change when that happens — that is the
// point of ADR-0001 §D9's adapter boundary.

// question-bank.yaml's practice_area enum, minus the `unknown` sentinel
// (see ClassifyOutput.practiceArea below).
export type PracticeArea =
  | "family_divorce"
  | "family_custody"
  | "family_modification"
  | "family_enforcement"
  | "family_other"
  | "expunction"
  | "personal_injury"
  | "mediation";

export type ChatTurn = { role: "caller" | "system"; text: string };

export interface ClassifyInput {
  /** The caller's own words, unmodified. Treated as data, never as
   *  instructions — see the design doc §7's prompt-injection guardrails,
   *  which this mock doesn't need to worry about (no prompt exists) but a
   *  real implementation absolutely must. */
  freeText: string;
  turnHistory?: ChatTurn[];
  localeHint?: "en" | "es";
}

export interface ClassifyOutput {
  /** `unknown` is a valid, expected output (design doc §3), not a failure
   *  — this mock returns it whenever it isn't confident, which is often. */
  practiceArea: PracticeArea | "unknown";
  /** 0-1. A crude heuristic score (keyword hits), NOT a calibrated model
   *  confidence. Do not wire this to any real per-class threshold (design
   *  doc §5) without replacing this whole function first. */
  practiceAreaConfidence: number;
  /** Advisory only. `out_of_scope_gate` (unbuilt, downstream of this
   *  card's scope) is the deterministic decision-maker regardless of this
   *  signal — design doc §4. */
  outOfScopeSignal: boolean;
  /** Advisory only, staff-queue-sort signal. Must never skip
   *  urgency_gate/escalate_urgency and never appear in caller-facing text
   *  (design doc §6). This build doesn't act on it at all — it's here so
   *  the shape matches the real classifier's eventual interface. */
  queuePriority: "routine" | "elevated" | "urgent";
  queuePriorityConfidence: number;
  /**
   * Hard-coded false. A real safety-flag detector needs an attorney- and
   * domain-expert-reviewed keyword/pattern list (design doc §6, open
   * question #2) — building even a placeholder list here, unreviewed,
   * is exactly the kind of confident-sounding-but-unvetted behavior
   * CLAUDE.md's compliance guardrails warn against for this project.
   * DO NOT add ad hoc safety-keyword matching to this file; that work
   * belongs to the c1/c26 attorney-reviewed process, not this mock.
   */
  safetyFlag: boolean;
  modelVersion: string;
  promptVersion: string;
}

// Keyword lists are illustrative, not exhaustive, and NOT attorney-reviewed
// — they only need to be good enough to demo the "classify, then let the
// caller confirm or correct" UX this card is actually responsible for.
// Checked in listed order; the first category with a strictly-higher score
// than every other wins, so an exact tie falls through to `unknown`.
const KEYWORD_RULES: { area: PracticeArea; keywords: string[] }[] = [
  {
    area: "expunction",
    keywords: ["expunge", "expunction", "expunged", "clear my record", "criminal record", "arrest record", "seal my record"],
  },
  {
    area: "personal_injury",
    keywords: ["car accident", "crash", "injured", "injury", "hurt in", "hit by a car", "insurance company", "slip and fall"],
  },
  {
    area: "mediation",
    keywords: ["mediation", "mediator", "mediate"],
  },
  {
    area: "family_enforcement",
    keywords: ["not following the order", "not paying child support", "contempt", "enforce the order", "violating our order", "won't comply", "wont comply"],
  },
  {
    area: "family_modification",
    keywords: ["modify", "modification", "change the custody", "change our order", "change child support"],
  },
  {
    area: "family_custody",
    keywords: ["custody", "visitation", "parenting time", "see my kids", "see my children"],
  },
  {
    area: "family_divorce",
    keywords: ["divorce", "dissolution of marriage", "separating from my spouse", "leave my husband", "leave my wife", "file for divorce", "getting a divorce"],
  },
  {
    area: "family_other",
    keywords: ["adoption", "prenup", "prenuptial", "postnuptial", "name change", "paternity"],
  },
];

// Advisory-only signal per design doc §4 — never a decision. Illustrative,
// not the firm's actual not-served list (that's firm-config, per-firm).
const OUT_OF_SCOPE_KEYWORDS = [
  "just need someone to fill out",
  "just need help with paperwork",
  "fill out the forms",
  "pro se",
  "representing myself",
  "child protective services",
  "cps case",
  "against cps",
];

export function classify(input: ClassifyInput): ClassifyOutput {
  const text = input.freeText.toLowerCase();

  let bestArea: PracticeArea | null = null;
  let bestScore = 0;
  let tie = false;

  for (const rule of KEYWORD_RULES) {
    const score = rule.keywords.filter((kw) => text.includes(kw)).length;
    if (score > bestScore) {
      bestScore = score;
      bestArea = rule.area;
      tie = false;
    } else if (score > 0 && score === bestScore) {
      tie = true;
    }
  }

  const practiceArea: PracticeArea | "unknown" = bestArea && !tie ? bestArea : "unknown";
  // Deliberately crude: a keyword hit with no competing category is
  // "fairly confident" by this mock's own low bar, anything else defaults
  // low. Nowhere near the calibrated, per-class, reliability-diagram-based
  // thresholds the design doc (§5) requires of the real implementation.
  const practiceAreaConfidence = practiceArea !== "unknown" ? Math.min(0.5 + bestScore * 0.15, 0.9) : 0.2;

  const outOfScopeSignal = OUT_OF_SCOPE_KEYWORDS.some((kw) => text.includes(kw));

  return {
    practiceArea,
    practiceAreaConfidence,
    outOfScopeSignal,
    // Not computed at all in this mock — always the safe default. Nothing
    // in this card's scope reads this field for anything load-bearing.
    queuePriority: "routine",
    queuePriorityConfidence: 0.2,
    safetyFlag: false,
    modelVersion: "mock-keyword-v0",
    promptVersion: "n/a-mock",
  };
}
