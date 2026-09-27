// Shared vocabulary for `calendar_events` (src/db/tables/foundation.ts). The
// calendar-core engine owns the behaviour; these constants mirror the CHECK
// constraints, plus the one rule every engine must respect: the AI never
// decides a date — only a lawyer confirms an event, and deadlines run on the
// REAL clock.

export const CALENDAR_EVENT_SOURCES = [
  "lawyer_entry",
  "staff_entry",
  "ai_suggestion",
  "court_notice",
  "deadline_calculator",
  "consult_booking",
  "external_sync",
  "import",
] as const;
export type CalendarEventSource = (typeof CALENDAR_EVENT_SOURCES)[number];

export const CALENDAR_EVENT_STATUSES = ["proposed", "confirmed", "cancelled"] as const;
export type CalendarEventStatus = (typeof CALENDAR_EVENT_STATUSES)[number];

/** Suggested event types (free text in the table; engines may add their own). */
export const CALENDAR_EVENT_TYPES = [
  "hearing",
  "trial",
  "deposition",
  "mediation",
  "filing_deadline",
  "response_deadline",
  "limitation_date",
  "consultation",
  "client_meeting",
  "internal",
  "other",
] as const;

/** Roles that may confirm a date (a lawyer approves). */
export const CONFIRMING_ROLES = ["attorney", "firm_admin"] as const;

/**
 * Can this person confirm a proposed event? Only a human lawyer/admin, never
 * the AI or a system process, and only while the event is still proposed.
 * `firm_admin` is allowed because firm owners are typically lawyers; c99's
 * detailed permissions may narrow this.
 */
export function canConfirmEvent(
  actor: { type: "user"; role: string } | { type: "system" } | { type: "ai" } | { type: "client" },
  event: { status: string }
): { ok: true } | { ok: false; reason: string } {
  if (event.status !== "proposed") return { ok: false, reason: `Event is already ${event.status}.` };
  if (actor.type !== "user") return { ok: false, reason: "Only a lawyer can confirm a date — never the AI or the system." };
  if (!(CONFIRMING_ROLES as readonly string[]).includes(actor.role)) {
    return { ok: false, reason: `Role '${actor.role}' cannot confirm dates; a lawyer must.` };
  }
  return { ok: true };
}
