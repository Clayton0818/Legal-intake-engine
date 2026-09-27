// c65 — one intake record from every channel (pure rules).
//
// Every channel produces the same intake_sessions row and runs the same
// pipeline: identity → disclosures → conflict-minimum → conflict check →
// case details → triage / fit / speed-to-lead / assignment / booking.
// Emergency detection runs on every inbound message from the first one.

import type { ConflictState } from "../adapters/conflictStatus";

export const INTAKE_CHANNELS = [
  "web_chat",
  "web_form",
  "phone_ai",
  "phone_staff",
  "email",
  "sms",
  "referral",
  "walk_in",
  "phone_manual",
] as const;
export type IntakeChannel = (typeof INTAKE_CHANNELS)[number];

/** Channels a staff member enters by hand (disclosures read aloud and ticked). */
export const STAFF_ENTERED_CHANNELS: readonly IntakeChannel[] = ["walk_in", "phone_manual", "phone_staff"];

export function isIntakeChannel(v: unknown): v is IntakeChannel {
  return typeof v === "string" && (INTAKE_CHANNELS as readonly string[]).includes(v);
}

/** Digits only, keeping a leading '+'; US 10-digit numbers get +1. Pure. */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const digits = trimmed.replace(/[^0-9]/g, "");
  if (digits.length < 7) return null;
  if (trimmed.startsWith("+")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return `+${digits}`;
}

export function normalizeEmail(raw: string | null | undefined): string | null {
  const e = raw?.trim().toLowerCase();
  return e && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}

/** "Usable contact details" start the speed-to-lead clock (c69 §4.1). Pure. */
export function hasUsableContact(from: { email?: string | null; phone?: string | null }): boolean {
  return Boolean(normalizeEmail(from.email) || normalizePhone(from.phone));
}

export type LockReason =
  | "disclosures_not_acknowledged"
  | "conflict_minimum_missing"
  | "conflict_check_not_run"
  | "conflict_not_clear"
  | "emergency_pause";

/**
 * c65 rules 3–4: case-detail questions are locked until the disclosures are
 * acknowledged, the conflict-minimum data is in, and the conflict check has
 * run and come back clear (or a lawyer cleared it). Pure.
 */
export function caseDetailsLock(args: {
  disclosuresAcknowledgedAt: Date | null;
  conflictMinimum: { fullName?: string; otherPartyNames?: string[] };
  conflictState: ConflictState;
  status: string;
}): { locked: boolean; reasons: LockReason[] } {
  const reasons: LockReason[] = [];
  if (!args.disclosuresAcknowledgedAt) reasons.push("disclosures_not_acknowledged");
  if (!args.conflictMinimum.fullName?.trim() || !Array.isArray(args.conflictMinimum.otherPartyNames)) {
    reasons.push("conflict_minimum_missing");
  }
  if (args.conflictState === "none") reasons.push("conflict_check_not_run");
  else if (args.conflictState !== "clear" && args.conflictState !== "attorney_cleared") reasons.push("conflict_not_clear");
  if (args.status === "paused_emergency") reasons.push("emergency_pause");
  return { locked: reasons.length > 0, reasons };
}

export type ReplyKind =
  | "safety_911"
  | "safe_contact_question"
  | "urgent_acknowledgement"
  | "person_alerted"
  | "recording_prompt"
  | "sms_first_reply"
  | "email_auto_reply"
  | "channel_disclosure"
  | "ai_acknowledgement";

/**
 * Which replies the assistant gives to one inbound message, in order (pure):
 *  1. safety message first when a safety emergency is detected (c66 rule 3),
 *     then the one DV-safe question (once per session);
 *  2. neutral acknowledgement for an urgent legal matter;
 *  3. while paused for an emergency: only "a person has been alerted";
 *  4. on a new session: the channel's opening (recording prompt for AI
 *     calls, SMS first reply, email auto-reply, or the on-screen disclosure),
 *     then the AI acknowledgement (which never stops the c69 clock).
 * STOP messages get no reply here (c70 handles the one optional confirmation).
 */
export function planReplies(args: {
  channel: IntakeChannel;
  isNewSession: boolean;
  safetyDetected: boolean;
  urgentDetected: boolean;
  pausedForEmergency: boolean;
  safeContactAsked: boolean;
  isStop: boolean;
}): ReplyKind[] {
  if (args.isStop) return [];
  const out: ReplyKind[] = [];
  if (args.safetyDetected) {
    out.push("safety_911");
    if (!args.safeContactAsked) out.push("safe_contact_question");
  }
  if (args.urgentDetected) out.push("urgent_acknowledgement");
  const emergencyNow = args.safetyDetected || args.urgentDetected;
  if (args.pausedForEmergency && !emergencyNow) {
    out.push("person_alerted");
    return out;
  }
  if (args.isNewSession && !STAFF_ENTERED_CHANNELS.includes(args.channel) && args.channel !== "referral") {
    if (args.channel === "phone_ai") out.push("recording_prompt");
    else if (args.channel === "sms") out.push("sms_first_reply");
    else if (args.channel === "email") out.push("email_auto_reply");
    else out.push("channel_disclosure");
    if (!emergencyNow) out.push("ai_acknowledgement");
  }
  return out;
}

export interface ContactCandidate {
  id: string;
  normalizedName: string;
  email: string | null;
  phone: string | null;
}

/**
 * c71 (suggest, never auto-merge): existing contacts that look like the same
 * person, strongest match first. Staff confirm any link. Pure.
 */
export function suggestDuplicates(
  incoming: { normalizedName: string | null; email: string | null; phone: string | null },
  existing: readonly ContactCandidate[]
): Array<{ id: string; score: number; matchedOn: string[] }> {
  const email = normalizeEmail(incoming.email);
  const phone = normalizePhone(incoming.phone);
  const out: Array<{ id: string; score: number; matchedOn: string[] }> = [];
  for (const c of existing) {
    const matchedOn: string[] = [];
    if (email && normalizeEmail(c.email) === email) matchedOn.push("email");
    if (phone && normalizePhone(c.phone) === phone) matchedOn.push("phone");
    if (incoming.normalizedName && c.normalizedName === incoming.normalizedName) matchedOn.push("name");
    if (matchedOn.length === 0) continue;
    const score = (matchedOn.includes("email") ? 50 : 0) + (matchedOn.includes("phone") ? 40 : 0) + (matchedOn.includes("name") ? 20 : 0);
    out.push({ id: c.id, score, matchedOn });
  }
  return out.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

/** Recording may start only after consent from the caller (all-party default, c65 rule 5). Pure. */
export function canRecord(recordingState: string): boolean {
  return recordingState === "consented";
}
