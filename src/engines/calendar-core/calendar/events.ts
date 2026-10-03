// c91 — the matter calendar: pure rules on top of the shared calendar_events
// table (src/db/tables/foundation.ts, vocabulary in src/core/calendarEvents.ts).
//
// Founder rules enforced here:
//  - court dates come from lawyer entry or CONFIRMED suggestions, never from
//    unconfirmed AI extraction: anything not typed in by a person starts
//    'proposed', and only a lawyer confirms a deadline or court date;
//  - a confirmed date is changed or cancelled only with a logged reason, and
//    a change by someone who cannot confirm sends it back to 'proposed';
//  - deadlines run on the REAL clock (the follow-up task is deadline-critical).

import { CALENDAR_EVENT_SOURCES, canConfirmEvent, localDateString, type CalendarEventSource } from "@/core";
import type { calendarEvents } from "@/db/tables/foundation";
import type { Staff } from "../actors";

export type CalendarEventRow = typeof calendarEvents.$inferSelect;

/** Event types that are deadlines (always is_deadline, real clock). */
export const DEADLINE_EVENT_TYPES = ["filing_deadline", "response_deadline", "limitation_date"] as const;
/** Court dates: hearings and trials. Confirming them is a lawyer's job, like deadlines. */
export const COURT_DATE_TYPES = ["hearing", "trial"] as const;
/** Sources a person can create through the calendar screen. */
export const MANUAL_SOURCES = ["lawyer_entry", "staff_entry"] as const;
/** Sources that never start confirmed, whoever creates them. */
export const ALWAYS_PROPOSED_SOURCES: readonly CalendarEventSource[] = [
  "ai_suggestion",
  "court_notice",
  "deadline_calculator",
  "external_sync",
  "import",
];

export interface EventDraft {
  matterId: string | null;
  eventType: string;
  title: string;
  description?: string | null;
  startsAt: Date;
  endsAt?: Date | null;
  allDay?: boolean;
  location?: string | null;
  courtName?: string | null;
  causeNumber?: string | null;
  isDeadline?: boolean;
  assignedUserIds?: string[];
  source: CalendarEventSource;
  sourceRef?: string | null;
}

export function isDeadlineType(eventType: string): boolean {
  return (DEADLINE_EVENT_TYPES as readonly string[]).includes(eventType);
}

/** Deadlines and court dates: only an attorney may confirm, change or cancel them once confirmed. */
export function isLawyerOnlyEvent(event: Pick<CalendarEventRow, "eventType" | "isDeadline">): boolean {
  return event.isDeadline || isDeadlineType(event.eventType) || (COURT_DATE_TYPES as readonly string[]).includes(event.eventType);
}

/** Normalise and validate a new event. Returns errors (empty = valid). Pure. */
export function validateEventDraft(draft: EventDraft): string[] {
  const errors: string[] = [];
  if (!draft.title?.trim()) errors.push("A title is required.");
  else if (draft.title.length > 200) errors.push("The title is too long (200 characters at most).");
  if (!/^[a-z][a-z_]{1,39}$/.test(draft.eventType)) errors.push(`Event type '${draft.eventType}' is not valid.`);
  if (!(CALENDAR_EVENT_SOURCES as readonly string[]).includes(draft.source)) errors.push(`Unknown source '${draft.source}'.`);
  if (Number.isNaN(draft.startsAt.getTime())) errors.push("The start time is not valid.");
  if (draft.endsAt && draft.endsAt.getTime() < draft.startsAt.getTime()) errors.push("The event must end after it starts.");
  const deadline = draft.isDeadline || isDeadlineType(draft.eventType);
  if (deadline && !draft.matterId) errors.push("A deadline must belong to a matter.");
  if (!draft.matterId && (COURT_DATE_TYPES as readonly string[]).includes(draft.eventType)) {
    errors.push("A court date must belong to a matter.");
  }
  if (draft.eventType === "limitation_date" && draft.source !== "lawyer_entry") {
    errors.push("Limitation dates are entered by a lawyer through the limitation tracker.");
  }
  if ((draft.assignedUserIds ?? []).length > 50) errors.push("Too many people assigned.");
  return errors;
}

/** The status a new event starts in. Pure. */
export function initialStatus(
  draft: Pick<EventDraft, "source" | "eventType" | "isDeadline">,
  creator: Pick<Staff, "role"> | null,
  confirmNow: boolean
): "proposed" | "confirmed" {
  if (!confirmNow || !creator) return "proposed";
  if (ALWAYS_PROPOSED_SOURCES.includes(draft.source)) return "proposed";
  // The limitation tracker confirms its own event after the independent verification.
  if (draft.eventType === "limitation_date") return "proposed";
  const ok = canConfirmAs(creator, { status: "proposed", eventType: draft.eventType, isDeadline: draft.isDeadline ?? isDeadlineType(draft.eventType) });
  return ok.ok ? "confirmed" : "proposed";
}

/**
 * May this person confirm this event? The shared rule (canConfirmEvent: a
 * human attorney or firm admin, never the AI or system), narrowed so that
 * deadlines and court dates need an attorney (rbac ATTORNEY_ONLY).
 */
export function canConfirmAs(
  staff: Pick<Staff, "role">,
  event: Pick<CalendarEventRow, "status" | "eventType" | "isDeadline">
): { ok: true } | { ok: false; reason: string } {
  const shared = canConfirmEvent({ type: "user", role: staff.role }, event);
  if (!shared.ok) return shared;
  if (isLawyerOnlyEvent(event) && staff.role !== "attorney") {
    return { ok: false, reason: "Only a lawyer can confirm a deadline or court date." };
  }
  return { ok: true };
}

export interface ChangePlan {
  /** Status after the change. */
  status: "proposed" | "confirmed";
  /** Keep (or set) the person recorded as confirming. */
  confirmedByUserId: string | null;
  /** Human reason required (and logged). */
  reasonRequired: boolean;
}

/**
 * Moving an event's date/time. A confirmed deadline or court date needs a
 * reason; a lawyer moving it re-confirms it in their own name; anyone else
 * moving it sends it back to 'proposed' for a lawyer. Pure.
 */
export function planReschedule(event: Pick<CalendarEventRow, "status" | "eventType" | "isDeadline">, staff: Pick<Staff, "role" | "userId">): ChangePlan {
  if (event.status !== "confirmed") return { status: "proposed", confirmedByUserId: null, reasonRequired: isLawyerOnlyEvent(event) };
  const lawyerOnly = isLawyerOnlyEvent(event);
  const mayConfirm = lawyerOnly ? staff.role === "attorney" : staff.role === "attorney" || staff.role === "firm_admin";
  return mayConfirm
    ? { status: "confirmed", confirmedByUserId: staff.userId, reasonRequired: true }
    : { status: "proposed", confirmedByUserId: null, reasonRequired: true };
}

/** May this person cancel the event? Confirmed deadlines/court dates: a lawyer only. Pure. */
export function canCancelAs(staff: Pick<Staff, "role">, event: Pick<CalendarEventRow, "status" | "eventType" | "isDeadline">): { ok: true } | { ok: false; reason: string } {
  if (event.status === "cancelled") return { ok: false, reason: "The event is already cancelled." };
  if (event.status === "confirmed" && isLawyerOnlyEvent(event) && staff.role !== "attorney") {
    return { ok: false, reason: "Only a lawyer can cancel a confirmed deadline or court date." };
  }
  return { ok: true };
}

export type CalendarView =
  | { kind: "firm" }
  | { kind: "lawyer"; userId: string }
  | { kind: "matter"; matterId: string };

/** Does an event belong in a view? (Used to double-check SQL filtering and in tests.) Pure. */
export function inView(event: Pick<CalendarEventRow, "matterId" | "assignedUserIds">, view: CalendarView): boolean {
  if (view.kind === "firm") return true;
  if (view.kind === "matter") return event.matterId === view.matterId;
  return event.assignedUserIds.includes(view.userId);
}

export interface AgendaItem {
  id: string;
  matterId: string | null;
  eventType: string;
  title: string;
  startsAt: string;
  endsAt: string | null;
  allDay: boolean;
  location: string | null;
  courtName: string | null;
  causeNumber: string | null;
  isDeadline: boolean;
  status: string;
  source: string;
  /** True when a lawyer still has to confirm it (shown clearly — never treated as a real date). */
  needsConfirmation: boolean;
  assignedUserIds: string[];
}

export interface AgendaDay {
  date: string;
  items: AgendaItem[];
}

/** Group events into local days (firm zone), soonest first; deadlines before other items on the same day. Pure. */
export function agendaByDay(events: readonly CalendarEventRow[], timeZone: string): AgendaDay[] {
  const days = new Map<string, AgendaItem[]>();
  const sorted = [...events].sort(
    (a, b) => a.startsAt.getTime() - b.startsAt.getTime() || Number(b.isDeadline) - Number(a.isDeadline) || a.title.localeCompare(b.title)
  );
  for (const e of sorted) {
    const date = localDateString(e.startsAt, timeZone);
    const list = days.get(date) ?? [];
    list.push(toAgendaItem(e));
    days.set(date, list);
  }
  return [...days.entries()].map(([date, items]) => ({ date, items }));
}

export function toAgendaItem(e: CalendarEventRow): AgendaItem {
  return {
    id: e.id,
    matterId: e.matterId,
    eventType: e.eventType,
    title: e.title,
    startsAt: e.startsAt.toISOString(),
    endsAt: e.endsAt ? e.endsAt.toISOString() : null,
    allDay: e.allDay,
    location: e.location,
    courtName: e.courtName,
    causeNumber: e.causeNumber,
    isDeadline: e.isDeadline,
    status: e.status,
    source: e.source,
    needsConfirmation: e.status === "proposed",
    assignedUserIds: e.assignedUserIds,
  };
}

/** Owner of the deadline-critical follow-up task for a confirmed deadline. Pure. */
export function deadlineTaskOwner(
  event: Pick<CalendarEventRow, "assignedUserIds">,
  matterAssignedUserId: string | null
): { type: "user"; userId: string } | { type: "firm" } {
  const first = event.assignedUserIds[0] ?? matterAssignedUserId;
  return first ? { type: "user", userId: first } : { type: "firm" };
}
