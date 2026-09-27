// c66 — emergency and urgent-matter detection (pure).
//
// Two detectors, either one triggering counts (fail towards alerting):
//  - the classifier's safetyFlag / urgency categories (c35), when present;
//  - a phrase list backstop: the attorney-reviewed list from the gate
//    'rules.intake.emergency_detection' (its DRAFT is used while review is
//    pending — detection only ever pages staff) plus firm additions.
// Detection never produces client-facing wording and never states a
// deadline; the service decides what to do with the result.

import { gateStatus } from "@/compliance/approvals";
import { EMERGENCY_DETECTION_GATE } from "../gates";

export const EMERGENCY_CATEGORIES = [
  "safety_dv",
  "safety_threat",
  "safety_self_harm",
  "urgent_custody_or_arrest",
  "urgent_court_soon",
  "urgent_served",
  "urgent_lockout",
  "deadline_risk",
] as const;
export type EmergencyCategory = (typeof EMERGENCY_CATEGORIES)[number];

export type EmergencyTrack = "safety" | "urgent_legal" | "deadline_risk";

export function trackFor(category: EmergencyCategory): EmergencyTrack {
  if (category.startsWith("safety_")) return "safety";
  if (category === "deadline_risk") return "deadline_risk";
  return "urgent_legal";
}

export function isEmergencyCategory(v: unknown): v is EmergencyCategory {
  return typeof v === "string" && (EMERGENCY_CATEGORIES as readonly string[]).includes(v);
}

export interface Detection {
  category: EmergencyCategory;
  track: EmergencyTrack;
  detector: "keyword" | "classifier";
  matchedPhrase: string | null;
}

export type PhraseLists = Partial<Record<EmergencyCategory, string[]>>;

/** Lowercase, strip accents and punctuation, collapse whitespace. Pure. */
export function normalizeForMatch(text: string): string {
  return ` ${text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^a-z0-9'\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()} `;
}

/** Parse the gate text format `category: phrase | phrase` (one category per line). Unknown categories are ignored. Pure. */
export function parsePhraseList(text: string): PhraseLists {
  const out: PhraseLists = {};
  for (const line of text.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const cat = line.slice(0, idx).trim();
    if (!isEmergencyCategory(cat)) continue;
    const phrases = line
      .slice(idx + 1)
      .split("|")
      .map((p) => p.trim())
      .filter(Boolean);
    out[cat] = [...(out[cat] ?? []), ...phrases];
  }
  return out;
}

/** Merge firm additions into the base list (categories can be added to, never removed — c66 rule 10). Pure. */
export function mergePhraseLists(base: PhraseLists, extra: Record<string, string[]>): PhraseLists {
  const out: PhraseLists = { ...base };
  for (const [cat, phrases] of Object.entries(extra)) {
    if (!isEmergencyCategory(cat)) continue;
    out[cat] = [...(out[cat] ?? []), ...phrases.map((p) => p.trim()).filter(Boolean)];
  }
  return out;
}

/**
 * The phrase list in force: the approved text when approved, otherwise the
 * draft (flagged `approved: false` so every detection records it).
 */
export function activePhraseList(extra: Record<string, string[]> = {}): { lists: PhraseLists; approved: boolean } {
  const status = gateStatus(EMERGENCY_DETECTION_GATE.key);
  const text = status.approved && status.approvedText ? status.approvedText : EMERGENCY_DETECTION_GATE.draft ?? "";
  return { lists: mergePhraseLists(parsePhraseList(text), extra), approved: status.approved };
}

export interface ClassifierSignal {
  safetyFlag?: boolean;
  categories?: string[];
}

/** Run both detectors over one message. One detection per category (first match). Pure. */
export function detectEmergencies(text: string, lists: PhraseLists, classifier?: ClassifierSignal | null): Detection[] {
  const hay = normalizeForMatch(text);
  const found = new Map<EmergencyCategory, Detection>();
  for (const category of EMERGENCY_CATEGORIES) {
    for (const phrase of lists[category] ?? []) {
      const needle = normalizeForMatch(phrase);
      if (needle.trim() && hay.includes(needle)) {
        found.set(category, { category, track: trackFor(category), detector: "keyword", matchedPhrase: phrase });
        break;
      }
    }
  }
  for (const c of classifier?.categories ?? []) {
    if (isEmergencyCategory(c) && !found.has(c)) {
      found.set(c, { category: c, track: trackFor(c), detector: "classifier", matchedPhrase: null });
    }
  }
  if (classifier?.safetyFlag && ![...found.values()].some((d) => d.track === "safety")) {
    found.set("safety_threat", { category: "safety_threat", track: "safety", detector: "classifier", matchedPhrase: null });
  }
  return EMERGENCY_CATEGORIES.filter((c) => found.has(c)).map((c) => found.get(c)!);
}

/** Group detections by track, most serious first (safety, urgent legal, deadline risk). Pure. */
export function detectionsByTrack(detections: readonly Detection[]): Array<{ track: EmergencyTrack; detections: Detection[] }> {
  const order: EmergencyTrack[] = ["safety", "urgent_legal", "deadline_risk"];
  return order
    .map((track) => ({ track, detections: detections.filter((d) => d.track === track) }))
    .filter((g) => g.detections.length > 0);
}
