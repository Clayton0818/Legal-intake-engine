// c35 — deterministic safety-trigger matching (llm-triage-classifier.md §6).
//
// The trigger LIST is not hard-coded here: it is the draft/approved text of
// the 'rules.platform.safety_triggers' gate (src/engines/platform/gates.ts),
// so an attorney (and a DV-experienced reviewer) owns it and can edit it via
// the approval's approvedText. While that gate is pending the DRAFT list is
// applied — see the gate's comment for why detection is the fail-safe
// direction — and results carry version "draft-unapproved".

import { gateStatus, getGate, hashDraft } from "@/compliance/approvals";
import { PLATFORM_GATES } from "@/engines/platform/gates";

export interface SafetyRule {
  category: string;
  patterns: string[];
}

export interface SafetyRuleSet {
  rules: SafetyRule[];
  approved: boolean;
  /** 'approved:<hash>' | 'draft-unapproved' | 'invalid-fallback' */
  version: string;
}

export interface SafetyMatch {
  safetyFlag: boolean;
  categories: string[];
  rulesVersion: string;
  rulesApproved: boolean;
}

/** Pure: parse the JSON rule list. Returns null when the text is not a valid list. */
export function parseSafetyRules(text: string | null | undefined): SafetyRule[] | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text) as unknown;
    if (!Array.isArray(v) || v.length === 0) return null;
    const out: SafetyRule[] = [];
    for (const item of v) {
      if (!item || typeof item !== "object") return null;
      const { category, patterns } = item as { category?: unknown; patterns?: unknown };
      if (typeof category !== "string" || !Array.isArray(patterns)) return null;
      const ps = patterns.filter((p): p is string => typeof p === "string" && p.trim().length > 0).map((p) => normalizeText(p));
      if (ps.length > 0) out.push({ category, patterns: ps });
    }
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/** The rule set currently in force. */
export function currentSafetyRules(): SafetyRuleSet {
  const status = gateStatus(PLATFORM_GATES.safetyTriggers.key);
  if (status.approved) {
    const approved = parseSafetyRules(status.approvedText);
    if (approved) return { rules: approved, approved: true, version: `approved:${hashDraft(status.approvedText ?? "")}` };
  }
  // Pending, or an approved text that doesn't parse: never run with NO list.
  const draft = parseSafetyRules(getGate(PLATFORM_GATES.safetyTriggers.key).draft) ?? [];
  return { rules: draft, approved: false, version: status.approved ? "invalid-fallback" : "draft-unapproved" };
}

/** Pure: lowercase, unify apostrophes, strip punctuation, collapse whitespace. */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[‘’ʼ`]/g, "'")
    .replace(/'/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Pure: match normalised text against a rule set on word boundaries. */
export function matchSafetyRules(text: string, set: SafetyRuleSet): SafetyMatch {
  const norm = ` ${normalizeText(text)} `;
  const categories: string[] = [];
  for (const rule of set.rules) {
    const hit = rule.patterns.some((p) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(p)}(?![\\p{L}\\p{N}])`, "u").test(norm));
    if (hit && !categories.includes(rule.category)) categories.push(rule.category);
  }
  return { safetyFlag: categories.length > 0, categories, rulesVersion: set.version, rulesApproved: set.approved };
}

export function detectSafety(text: string): SafetyMatch {
  return matchSafetyRules(text, currentSafetyRules());
}
