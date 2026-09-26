// c77 — Time tracking: timers and manual entries per matter, in firm-set
// increments, billable/non-billable with activity codes. The AI may SUGGEST
// entries from work already in the system; nothing is billed until the
// lawyer reviews and approves each entry. A screened lawyer (c60) can never
// record or bill time on that matter.

import { assertNonNegativeCents, type Cents } from "./money";
import type { RoundingMode } from "./settings";

export type TimeEntryStatus =
  | "suggested" // created by the AI, not yet looked at
  | "draft" // created or accepted by a person, editable
  | "approved" // lawyer approved; eligible for an invoice
  | "billed" // on a sent invoice; locked
  | "rejected"; // AI suggestion dismissed, or entry withdrawn

export type TimeEntrySource = "timer" | "manual" | "ai_suggestion";

export type SuggestionOrigin = "email_sent" | "document_drafted" | "call_logged" | "court_appearance" | "calendar_event";

export interface TimeEntry {
  id: string;
  tenantId: string;
  matterId: string;
  userId: string; // timekeeper
  workDate: string; // YYYY-MM-DD
  /** Raw minutes as recorded, before rounding. */
  rawMinutes: number;
  /** Minutes after rounding to the firm increment; what is billed. */
  billedMinutes: number;
  billable: boolean;
  activityCode: string;
  description: string;
  rateCents: Cents; // hourly rate in force for this timekeeper/matter
  source: TimeEntrySource;
  suggestionOrigin: { type: SuggestionOrigin; refId: string } | null;
  status: TimeEntryStatus;
  approvedByUserId: string | null;
  approvedAt: string | null;
  invoiceId: string | null;
}

export interface Actor {
  userId: string;
  role: "firm_admin" | "attorney" | "intake_staff" | "read_only" | "integration_service" | "ai";
}

export class ScreenedMatterError extends Error {
  constructor(userId: string, matterId: string) {
    super(`User ${userId} is screened from matter ${matterId} (c60) and cannot record or bill time on it.`);
    this.name = "ScreenedMatterError";
  }
}

export class InvalidTransitionError extends Error {
  constructor(from: string, to: string, why?: string) {
    super(`Cannot move from "${from}" to "${to}"${why ? `: ${why}` : ""}`);
    this.name = "InvalidTransitionError";
  }
}

/** Round minutes to the firm increment. Zero stays zero. */
export function roundToIncrement(minutes: number, incrementMinutes: number, mode: RoundingMode): number {
  if (!Number.isFinite(minutes) || minutes < 0) throw new Error("minutes must be a non-negative number");
  if (!Number.isInteger(incrementMinutes) || incrementMinutes < 1) throw new Error("increment must be a positive integer");
  if (minutes === 0) return 0;
  const units = minutes / incrementMinutes;
  const rounded = mode === "up" ? Math.ceil(units - 1e-9) : Math.max(1, Math.round(units));
  return rounded * incrementMinutes;
}

/** Hours shown to users, e.g. 0.1 / 1.5, derived from billed minutes. */
export function billedHours(entry: Pick<TimeEntry, "billedMinutes">): number {
  return Math.round((entry.billedMinutes / 60) * 100) / 100;
}

/** Amount for an entry, rounded to the cent. Non-billable entries are 0. */
export function entryAmountCents(entry: Pick<TimeEntry, "billedMinutes" | "rateCents" | "billable">): Cents {
  assertNonNegativeCents(entry.rateCents, "rateCents");
  if (!entry.billable) return 0;
  return Math.round((entry.billedMinutes * entry.rateCents) / 60);
}

// ---------------------------------------------------------------------------
// Timers: at most one running timer per user.
// ---------------------------------------------------------------------------

export interface RunningTimer {
  userId: string;
  matterId: string;
  startedAt: string; // ISO timestamp
  /** Accumulated minutes from earlier pause/resume cycles. */
  accumulatedMinutes: number;
}

export function startTimer(
  existing: RunningTimer | null,
  params: { userId: string; matterId: string; now: Date; isScreened: boolean }
): RunningTimer {
  if (params.isScreened) throw new ScreenedMatterError(params.userId, params.matterId);
  if (existing) {
    throw new Error(`A timer is already running on matter ${existing.matterId}; stop it first.`);
  }
  return { userId: params.userId, matterId: params.matterId, startedAt: params.now.toISOString(), accumulatedMinutes: 0 };
}

export function stopTimer(timer: RunningTimer, now: Date): number {
  const elapsedMs = now.getTime() - new Date(timer.startedAt).getTime();
  if (elapsedMs < 0) throw new Error("Timer stop time is before its start time");
  return timer.accumulatedMinutes + elapsedMs / 60_000;
}

// ---------------------------------------------------------------------------
// Creating entries
// ---------------------------------------------------------------------------

export interface NewEntryInput {
  id: string;
  tenantId: string;
  matterId: string;
  userId: string;
  workDate: string;
  rawMinutes: number;
  billable: boolean;
  activityCode: string;
  description: string;
  rateCents: Cents;
  source: TimeEntrySource;
  suggestionOrigin?: { type: SuggestionOrigin; refId: string } | null;
}

export function createEntry(
  input: NewEntryInput,
  ctx: { incrementMinutes: number; rounding: RoundingMode; isScreened: boolean; validActivityCodes: string[] }
): TimeEntry {
  if (ctx.isScreened) throw new ScreenedMatterError(input.userId, input.matterId);
  if (!ctx.validActivityCodes.includes(input.activityCode)) {
    throw new Error(`Unknown activity code "${input.activityCode}"`);
  }
  if (input.source === "ai_suggestion" && !input.suggestionOrigin) {
    throw new Error("AI-suggested entries must point to the work item they came from");
  }
  if (input.rawMinutes <= 0) throw new Error("Time entries must have a positive duration");
  return {
    ...input,
    suggestionOrigin: input.suggestionOrigin ?? null,
    billedMinutes: roundToIncrement(input.rawMinutes, ctx.incrementMinutes, ctx.rounding),
    status: input.source === "ai_suggestion" ? "suggested" : "draft",
    approvedByUserId: null,
    approvedAt: null,
    invoiceId: null,
  };
}

// ---------------------------------------------------------------------------
// Review and approval
// ---------------------------------------------------------------------------

/** A person accepts an AI suggestion into their drafts (they may then edit it). */
export function acceptSuggestion(entry: TimeEntry, actor: Actor): TimeEntry {
  if (actor.role === "ai") throw new InvalidTransitionError(entry.status, "draft", "the AI cannot accept its own suggestion");
  if (entry.status !== "suggested") throw new InvalidTransitionError(entry.status, "draft");
  if (actor.userId !== entry.userId && actor.role !== "attorney") {
    throw new InvalidTransitionError(entry.status, "draft", "only the timekeeper or a lawyer can accept a suggestion");
  }
  return { ...entry, status: "draft" };
}

export function rejectEntry(entry: TimeEntry, actor: Actor): TimeEntry {
  if (actor.role === "ai") throw new InvalidTransitionError(entry.status, "rejected", "the AI cannot reject entries");
  if (entry.status !== "suggested" && entry.status !== "draft") throw new InvalidTransitionError(entry.status, "rejected");
  return { ...entry, status: "rejected" };
}

/**
 * Lawyer approval. Only an `attorney` who is not screened from the matter can
 * approve, and an AI suggestion must first be accepted by a person.
 */
export function approveEntry(entry: TimeEntry, actor: Actor, ctx: { approverIsScreened: boolean; now: Date }): TimeEntry {
  if (actor.role !== "attorney") throw new InvalidTransitionError(entry.status, "approved", "only a lawyer can approve time");
  if (ctx.approverIsScreened) throw new ScreenedMatterError(actor.userId, entry.matterId);
  if (entry.status !== "draft") {
    throw new InvalidTransitionError(entry.status, "approved", entry.status === "suggested" ? "accept the AI suggestion first" : undefined);
  }
  return { ...entry, status: "approved", approvedByUserId: actor.userId, approvedAt: ctx.now.toISOString() };
}

/** Edits are allowed only before approval; editing re-rounds the duration. */
export function editEntry(
  entry: TimeEntry,
  changes: Partial<Pick<TimeEntry, "rawMinutes" | "billable" | "activityCode" | "description" | "workDate">>,
  ctx: { incrementMinutes: number; rounding: RoundingMode }
): TimeEntry {
  if (entry.status !== "draft" && entry.status !== "suggested") {
    throw new InvalidTransitionError(entry.status, "edited", "approved or billed entries are locked; unapprove first or correct on the draft invoice");
  }
  const next = { ...entry, ...changes };
  if (changes.rawMinutes !== undefined) {
    next.billedMinutes = roundToIncrement(changes.rawMinutes, ctx.incrementMinutes, ctx.rounding);
  }
  // An edited AI suggestion becomes a person's draft.
  if (entry.status === "suggested") next.status = "draft";
  return next;
}

/** Entries an invoice may include (c79): approved, billable or not, not already billed. */
export function billableForInvoice(entries: TimeEntry[], matterId: string): TimeEntry[] {
  return entries.filter((e) => e.matterId === matterId && e.status === "approved" && e.invoiceId === null);
}
