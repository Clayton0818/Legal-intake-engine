// c67 — consultation booking (pure rules).
//
// Booking is offered only after the conflict check is clear (or a lawyer
// cleared a possible conflict), the fit outcome is not no_fit, and no safety
// flag is waiting for a confirmed safe contact. Availability is free/busy
// only, inside firm business hours, never against stale external data.

import type { BusinessCalendar } from "@/core/businessHours";
import type { ConflictState } from "../adapters/conflictStatus";
import { addMinutes, businessWindows, overlaps } from "../common/time";

export type BookingBlockReason =
  | "conflict_not_checked"
  | "conflict_not_clear"
  | "not_a_fit"
  | "safety_contact_unconfirmed"
  | "session_closed"
  | "emergency_pause";

/** c67 §4 "Offer booking" rule 1 and business rule 1. Pure. */
export function bookingBlockReasons(args: {
  conflict: ConflictState;
  fitOutcome: string | null;
  safetySuppressed: boolean;
  terminalState: string | null;
  status: string;
}): BookingBlockReason[] {
  const out: BookingBlockReason[] = [];
  if (args.conflict === "none") out.push("conflict_not_checked");
  else if (args.conflict !== "clear" && args.conflict !== "attorney_cleared") out.push("conflict_not_clear");
  if (args.fitOutcome === "no_fit") out.push("not_a_fit");
  if (args.safetySuppressed) out.push("safety_contact_unconfirmed");
  if (args.terminalState) out.push("session_closed");
  if (args.status === "paused_emergency") out.push("emergency_pause");
  return out;
}

export interface Interval {
  start: Date;
  end: Date;
}

export interface SlotRules {
  durationMinutes: number;
  bufferMinutes: number;
  stepMinutes: number;
  /** Earliest bookable start (now + same-day minimum lead). */
  earliest: Date;
  /** Latest bookable start. */
  horizonEnd: Date;
}

/**
 * Free slots for one lawyer: slot starts every `stepMinutes` inside business
 * windows, the whole meeting inside the window, and meeting ± buffer clear of
 * every busy interval. Pure.
 */
export function freeSlots(cal: BusinessCalendar, busy: readonly Interval[], rules: SlotRules): Interval[] {
  const out: Interval[] = [];
  const step = rules.stepMinutes * 60_000;
  // Windows are read from a day before `earliest` so each one starts at the
  // firm's real opening time: slots align to opening time + n × step.
  const from = new Date(rules.earliest.getTime() - 86_400_000);
  for (const w of businessWindows(cal, from, addMinutes(rules.horizonEnd, rules.durationMinutes))) {
    for (let t = w.start.getTime(); t + rules.durationMinutes * 60_000 <= w.end.getTime(); t += step) {
      const start = new Date(t);
      if (start.getTime() < rules.earliest.getTime() || start.getTime() > rules.horizonEnd.getTime()) continue;
      const end = addMinutes(start, rules.durationMinutes);
      const padStart = addMinutes(start, -rules.bufferMinutes);
      const padEnd = addMinutes(end, rules.bufferMinutes);
      if (busy.some((b) => overlaps(padStart, padEnd, b.start, b.end))) continue;
      out.push({ start, end });
    }
  }
  return out;
}

/** Round an instant up to the next multiple of `stepMinutes` (UTC-minute aligned). Pure. */
export function ceilToStep(at: Date, stepMinutes: number): Date {
  const step = stepMinutes * 60_000;
  return new Date(Math.ceil(at.getTime() / step) * step);
}

/**
 * Is this lawyer's availability trustworthy right now? A lawyer with an
 * external calendar connection needs a sync within `staleMinutes` (and the
 * sync vendor approved); a lawyer without one is booked against the
 * product's own calendar only. Pure.
 */
export function availabilitySource(args: {
  hasConnection: boolean;
  lastSyncedAt: Date | null;
  now: Date;
  staleMinutes: number;
  syncApproved: boolean;
}): { usable: boolean; source: "internal" | "external"; reason: string | null } {
  if (!args.hasConnection) return { usable: true, source: "internal", reason: null };
  if (!args.syncApproved) return { usable: false, source: "external", reason: "Calendar sync is pending vendor (DPA) approval." };
  if (!args.lastSyncedAt || args.now.getTime() - args.lastSyncedAt.getTime() > args.staleMinutes * 60_000) {
    return { usable: false, source: "external", reason: "Calendar data is stale; never book against it (c67 failure path)." };
  }
  return { usable: true, source: "external", reason: null };
}

export type MeetingType = "initial_meeting" | "paid_consult";

/** Paid consult if the matter type is on the firm's always-paid list. Pure. */
export function meetingTypeFor(matterType: string | null, alwaysPaid: readonly string[]): MeetingType {
  return matterType && alwaysPaid.map((m) => m.toLowerCase()).includes(matterType.toLowerCase()) ? "paid_consult" : "initial_meeting";
}

export type FeeStep = "not_required" | "outside_system" | "blocked_pending_review";

/**
 * c67 business rule 7: consult fee collection stays OFF until the attorney +
 * CPA review (consult fee terms and trust accounting), the payment processor
 * DPA and a firm-chosen destination account all exist. Until then a paid
 * consult books with "fee to be handled outside the system" (open question 1
 * of the spec: the conservative choice) — nothing touches money here. Pure.
 */
export function feeStepFor(args: {
  meetingType: MeetingType;
  feeCents: number | null;
  destination: "operating" | "trust" | null;
  feeTermsApproved: boolean;
  processorApproved: boolean;
  trustRulesApproved: boolean;
}): { step: FeeStep; note: string | null } {
  if (args.meetingType !== "paid_consult" || !args.feeCents) return { step: "not_required", note: null };
  const pending: string[] = [];
  if (!args.feeTermsApproved) pending.push("consult fee terms (attorney + CPA)");
  if (!args.processorApproved) pending.push("payment processor DPA");
  if (!args.destination) pending.push("the firm's choice of operating vs trust account (with its CPA)");
  if (args.destination === "trust" && !args.trustRulesApproved) pending.push("trust-accounting rules (attorney + CPA)");
  if (pending.length > 0) {
    return { step: "outside_system", note: `Fee to be handled outside the system — in-product collection waits for: ${pending.join(", ")}.` };
  }
  // Even with every review done, collection itself belongs to the Billing & trust engine (c80);
  // intake never moves money. The booking records that the fee is due and hands over.
  return { step: "blocked_pending_review", note: "Fee collection is handed to the Billing & trust engine (c80)." };
}

/** Reminder send times (real clock), only those still in the future. Pure. */
export function reminderTimes(startsAt: Date, offsetsHours: readonly number[], now: Date): Array<{ offsetHours: number; at: Date }> {
  return [...new Set(offsetsHours)]
    .sort((a, b) => b - a)
    .map((h) => ({ offsetHours: h, at: new Date(startsAt.getTime() - h * 3_600_000) }))
    .filter((r) => r.at.getTime() > now.getTime());
}

/**
 * After a no-show: offer exactly one re-book (firm setting 0 or 1), unless
 * this consult was itself a re-book after a no-show — then flag intake staff
 * instead (c67 §4 No-show, acceptance 4). Pure.
 */
export function noShowAction(args: { rebookOffers: 0 | 1; previousWasNoShow: boolean }): "offer_rebook" | "flag_staff" {
  if (args.rebookOffers === 0 || args.previousWasNoShow) return "flag_staff";
  return "offer_rebook";
}

export const CONSULT_OUTCOMES = ["retain_offered", "needs_follow_up", "declined_by_firm", "client_declined"] as const;
export type ConsultOutcome = (typeof CONSULT_OUTCOMES)[number];

/** Matter system stage after a recorded consult outcome. Pure. */
export function stageForOutcome(outcome: ConsultOutcome): "consult_completed_manual_follow_up" | "did_not_hire_referred_out" {
  return outcome === "retain_offered" || outcome === "needs_follow_up" ? "consult_completed_manual_follow_up" : "did_not_hire_referred_out";
}

/** Consultation status transitions (pure). */
const TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  held: ["booked", "expired", "cancelled"],
  booked: ["rescheduled", "cancelled", "no_show", "completed", "on_hold"],
  on_hold: ["booked", "cancelled", "rescheduled"],
  rescheduled: [],
  cancelled: [],
  no_show: [],
  completed: [],
  expired: [],
};

export function canTransition(from: string, to: string): boolean {
  return (TRANSITIONS[from] ?? []).includes(to);
}

/** Minimal calendar title: never case facts (c67 acceptance 7). Pure. */
export function consultEventTitle(fullName: string | null): string {
  const initials = (fullName ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => p[0]!.toUpperCase())
    .slice(0, 3)
    .join("");
  return initials ? `Consult - ${initials}` : "Consult";
}
