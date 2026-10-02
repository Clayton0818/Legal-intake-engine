// Shared builders for this engine's unit tests. Pure; no database.

import { DEFAULT_WEEKLY_HOURS } from "@/db/tables/foundation";
import type { BusinessCalendar } from "@/core";
import type { ConflictHit, IndexEntry, Involvement } from "./types";

export const CAL: BusinessCalendar = { timeZone: "America/Chicago", weekly: DEFAULT_WEEKLY_HOURS, holidays: [] };

export function entry(over: Partial<IndexEntry> & { displayName: string; names?: IndexEntry["names"] }): IndexEntry {
  const normalized = over.displayName.toLowerCase();
  return {
    sourceType: "party",
    sourceId: over.sourceId ?? `party-${normalized.replace(/\s+/g, "-")}`,
    partyId: over.partyId ?? over.sourceId ?? `party-${normalized.replace(/\s+/g, "-")}`,
    names: over.names ?? [{ normalized, type: "legal" }],
    involvements: over.involvements ?? [matterInv("m-old", "client", "former")],
    ...over,
  } as IndexEntry;
}

export function matterInv(id: string, role: string, status: Involvement["status"] = "current", extra: Partial<Involvement> = {}): Involvement {
  return { kind: "matter", id, role, status, ...extra };
}

export function inquiryInv(id: string, role = "prospective_client"): Involvement {
  return { kind: "inquiry", id, role, status: "prospective" };
}

export function hit(over: Partial<ConflictHit> = {}): ConflictHit {
  return {
    searchedIndex: 0,
    searchedName: "Jane Doe",
    searchedRole: "opposing_party",
    sourceType: "party",
    sourceId: "p1",
    partyId: "p1",
    displayName: "Jane Doe",
    matchedName: "jane doe",
    matchKind: "exact",
    strength: 1,
    reasons: ["Same name"],
    involvements: [matterInv("m1", "client", "current")],
    ownerUserId: null,
    note: null,
    ...over,
  };
}
