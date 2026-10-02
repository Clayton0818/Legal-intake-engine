// c70 — follow-up on unfinished chats and prospects who never booked (pure).
//
// Short, capped, consent-based; one STOP on any channel ends it everywhere.
// Only people who contacted the firm first; never conflicted-out, declined,
// safety-flagged-without-safe-contact, represented, or personal-injury
// inquiries (until attorney review). Automated follow-up as a whole is behind
// the attorney gate 'rules.intake.follow_up_outreach' (barratry review).

import { isBusinessTime, nextBusinessStart, type BusinessCalendar } from "@/core/businessHours";
import type { ConflictState } from "../adapters/conflictStatus";
import type { FollowUpTrigger } from "../settings";

/** Honouring a stop is always safe, so this list works without approval; firms can add words. */
export const DEFAULT_STOP_WORDS: readonly string[] = [
  "stop",
  "stopall",
  "unsubscribe",
  "cancel",
  "end",
  "quit",
  "alto",
  "parar",
  "para",
  "cancelar",
  "detener",
  "basta",
];

const NATURAL_LANGUAGE_STOPS: readonly RegExp[] = [
  /\b(please\s+)?(don'?t|do not|stop)\s+(contact|contacting|text|texting|message|messaging|email|emailing|call|calling)\s+me\b/i,
  /\bleave me alone\b/i,
  /\bremove me\b/i,
  /\bno (more|further) (messages|texts|emails)\b/i,
  /\bno me (contacten|escriban|llamen|manden)\b/i,
  /\bdejen de (escribirme|llamarme|contactarme)\b/i,
];

function normalizeWord(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
}

/** Is this inbound message an opt-out? Keyword (whole message) or natural language. Pure. */
export function detectStop(text: string, extraWords: readonly string[] = []): { stop: boolean; kind: "keyword" | "natural_language" | null } {
  const word = normalizeWord(text.trim());
  const words = [...DEFAULT_STOP_WORDS, ...extraWords.map(normalizeWord)];
  if (word && words.includes(word)) return { stop: true, kind: "keyword" };
  if (NATURAL_LANGUAGE_STOPS.some((re) => re.test(text))) return { stop: true, kind: "natural_language" };
  return { stop: false, kind: null };
}

export type SkipReason =
  | "disabled"
  | "outreach_pending_review"
  | "template_pending_review"
  | "not_inbound_first"
  | "stopped"
  | "declined"
  | "conflict"
  | "conflict_pending"
  | "safety"
  | "represented"
  | "personal_injury"
  | "booked"
  | "signed"
  | "continued"
  | "human_replied"
  | "no_channel";

export interface FollowUpContext {
  trigger: FollowUpTrigger;
  enabled: boolean;
  outreachApproved: boolean;
  templateApproved: boolean;
  inboundFirst: boolean;
  stopped: boolean;
  declined: boolean;
  conflict: ConflictState;
  safetySuppressed: boolean;
  represented: boolean;
  practiceArea: string | null;
  personalInjuryApproved: boolean;
  booked: boolean;
  signed: boolean;
  /** For abandoned chats: the person has continued since the trigger. */
  continued: boolean;
  humanReplied: boolean;
  hasChannel: boolean;
}

/** Eligibility for a send (checked at start AND before every step, c70 §4.2). Pure. */
export function followUpEligibility(c: FollowUpContext): { eligible: true } | { eligible: false; reason: SkipReason } {
  const no = (reason: SkipReason) => ({ eligible: false as const, reason });
  if (!c.enabled) return no("disabled");
  if (!c.outreachApproved) return no("outreach_pending_review");
  if (!c.templateApproved) return no("template_pending_review");
  if (!c.inboundFirst) return no("not_inbound_first");
  if (c.stopped) return no("stopped");
  if (c.declined) return no("declined");
  if (c.conflict === "definite" || c.conflict === "declined") return no("conflict");
  if (c.conflict === "possible_pending") return no("conflict_pending");
  if (c.safetySuppressed) return no("safety");
  if (c.represented) return no("represented");
  if (c.practiceArea === "personal_injury" && !c.personalInjuryApproved) return no("personal_injury");
  if (c.trigger !== "not_signed" && c.booked) return no("booked");
  if (c.signed) return no("signed");
  if (c.trigger === "abandoned_chat" && c.continued) return no("continued");
  if (c.humanReplied && c.trigger !== "not_signed") return no("human_replied");
  if (!c.hasChannel) return no("no_channel");
  return { eligible: true };
}

/**
 * When step `index` is due: trigger time + dayOffsets[index] days, moved to
 * the next firm business time if it falls outside hours (c70 §4.4). Pure.
 */
export function stepDueAt(triggeredAt: Date, dayOffsets: readonly number[], index: number, cal: BusinessCalendar): Date | null {
  const days = dayOffsets[index];
  if (days === undefined) return null;
  const raw = new Date(triggeredAt.getTime() + days * 86_400_000);
  return isBusinessTime(raw, cal) ? raw : nextBusinessStart(raw, cal);
}

/** How a finished sequence closes the lead (c70 §4.6). Pure. */
export function closingFor(trigger: FollowUpTrigger): { terminalState: string | null; lawyerDecision: boolean } {
  if (trigger === "not_signed") return { terminalState: null, lawyerDecision: true };
  if (trigger === "not_booked") return { terminalState: "did_not_schedule", lawyerDecision: false };
  return { terminalState: "abandoned", lawyerDecision: false };
}
