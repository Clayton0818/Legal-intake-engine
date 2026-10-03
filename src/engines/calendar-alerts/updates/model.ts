// c54 — client updates. Pure helpers, no I/O.
//
//  - draftFromConfirmedEvent(): a SYSTEM draft built only from a CONFIRMED
//    calendar record — facts and dates, never predictions or advice (rule 4).
//    It always waits for a lawyer's approval (rule 3).
//  - reviewUpdateText(): the checks a body must pass before it can be sent.
//  - toClientHistory(): the client's own history: sent updates addressed to
//    them, newest first, searchable, with "corrected on" links (rules 1, 5).

import { checkHumanUpdate, checkUpdateDraft } from "../deadline/guard";

export type UpdateAuthorType = "user" | "ai" | "system_draft";

const EVENT_LABELS: Record<string, string> = {
  hearing: "A hearing",
  trial: "A trial setting",
  deposition: "A deposition",
  mediation: "A mediation",
  client_meeting: "A meeting with your legal team",
  consultation: "A consultation",
};

/** Event types an automatic draft may describe. Deadlines are left to the lawyer to explain (c44 rule 5 spirit). */
export const DRAFTABLE_EVENT_TYPES: readonly string[] = Object.keys(EVENT_LABELS);

export function draftFromConfirmedEvent(
  event: { eventType: string; status: string; startsAt: Date; allDay: boolean; location: string | null; courtName: string | null; cancelledAt: Date | null },
  timeZone: string
): { body: string } | { refused: string } {
  if (event.status !== "confirmed" || event.cancelledAt) return { refused: "Only a confirmed, live calendar entry can be the source of an update draft." };
  const label = EVENT_LABELS[event.eventType];
  if (!label) return { refused: `Automatic drafts are not offered for '${event.eventType}' entries; the lawyer writes those updates.` };
  const date = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(event.startsAt);
  const time = event.allDay ? "" : ` at ${new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(event.startsAt)}`;
  const where = event.courtName ? ` (${event.courtName}${event.location ? `, ${event.location}` : ""})` : event.location ? ` (${event.location})` : "";
  return { body: `${label} has been scheduled for ${date}${time}${where}. Your legal team will contact you about any preparation needed.` };
}

/** Problems that stop an update from being sent. Human authors: no internal data. AI/system drafts: facts only. */
export function reviewUpdateText(body: string, author: UpdateAuthorType, editedByLawyer = false): string[] {
  if (!body.trim()) return ["empty"];
  if (author === "user" || editedByLawyer) return checkHumanUpdate(body);
  return checkUpdateDraft(body);
}

export interface UpdateRowLike {
  id: string;
  matterId: string;
  recipientPartyIds: string[];
  body: string;
  status: string;
  sentAt: Date | null;
  correctsUpdateId: string | null;
  authorType: string;
  language: string;
}

export interface ClientUpdateView {
  id: string;
  matterId: string;
  sentAt: Date;
  body: string;
  language: string;
  /** This update corrects an earlier one. */
  correctsUpdateId: string | null;
  /** Set when a later update corrects this one (the original stays visible). */
  correctedBy: { id: string; sentAt: Date } | null;
}

/** The client's history: only SENT updates addressed to this party; newest first; optional text search. */
export function toClientHistory(rows: readonly UpdateRowLike[], partyId: string, search?: string | null): ClientUpdateView[] {
  const mine = rows.filter((u) => u.status === "sent" && u.sentAt && u.recipientPartyIds.includes(partyId));
  const correctedBy = new Map<string, { id: string; sentAt: Date }>();
  for (const u of mine) {
    if (!u.correctsUpdateId) continue;
    const prev = correctedBy.get(u.correctsUpdateId);
    if (!prev || prev.sentAt.getTime() < (u.sentAt as Date).getTime()) correctedBy.set(u.correctsUpdateId, { id: u.id, sentAt: u.sentAt as Date });
  }
  const q = search?.trim().toLowerCase();
  return mine
    .filter((u) => !q || u.body.toLowerCase().includes(q))
    .sort((a, b) => (b.sentAt as Date).getTime() - (a.sentAt as Date).getTime())
    .map((u) => ({
      id: u.id,
      matterId: u.matterId,
      sentAt: u.sentAt as Date,
      body: u.body,
      language: u.language,
      correctsUpdateId: u.correctsUpdateId,
      correctedBy: correctedBy.get(u.id) ?? null,
    }));
}

/** Firm-side delivery status of one update from its outbox rows (c54 §4.5). */
export function summariseDelivery(rows: ReadonlyArray<{ channel: string; status: string; recipientPartyId: string | null; lastError: string | null }>): Array<{ partyId: string; inApp: string | null; email: string | null; emailNote: string | null }> {
  const by = new Map<string, { partyId: string; inApp: string | null; email: string | null; emailNote: string | null }>();
  for (const r of rows) {
    if (!r.recipientPartyId) continue;
    const cur = by.get(r.recipientPartyId) ?? { partyId: r.recipientPartyId, inApp: null, email: null, emailNote: null };
    if (r.channel === "in_app") cur.inApp = r.status;
    if (r.channel === "email") {
      cur.email = r.status;
      cur.emailNote = r.lastError;
    }
    by.set(r.recipientPartyId, cur);
  }
  return [...by.values()];
}
