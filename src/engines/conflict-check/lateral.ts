// c61 — new hires' prior matters are checked before they start. Pure rules.

import { fromLocal, nextBusinessStart, localDateString, type BusinessCalendar } from "@/core";
import type { GateResult } from "./decisions";

/** General subject picklist (Family Law pilot first, c103). */
export const SUBJECT_CATEGORIES = [
  "divorce",
  "custody",
  "child_support",
  "modification",
  "paternity",
  "adoption",
  "protective_order",
  "property_division",
  "marital_agreement",
  "guardianship",
  "other_family",
  "other",
] as const;
export type SubjectCategory = (typeof SUBJECT_CATEGORIES)[number];

export interface PriorMatterEntry {
  formerFirmName?: string | null;
  clientNames: string[];
  adversePartyNames: string[];
  subjectCategory: string;
  subjectNote?: string | null;
  role: "lawyer" | "staff";
  fromYear?: number | null;
  toYear?: number | null;
  stillOpenKnown?: boolean | null;
}

// Words that suggest facts, strategy or confidential detail rather than a
// general subject. A deterministic stand-in for the AI screener in the spec
// (AI calls are vendor-gated: vendor.ai_model).
const DETAIL_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/[$€£]\s*\d|\b\d{1,3}(,\d{3})+\b|\b\d{4,}\b/, "looks like an amount or number"],
  [/\b(cause|case)\s*(no|number|#)\b|\b\d{2,}-[a-z]{0,3}-?\d{2,}\b/i, "looks like a case number"],
  [/@|\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/, "contains contact details"],
  [
    /\b(because|affair|abuse[ds]?|drugs?|alcohol|hid|hidden|cheat\w*|strategy|settle(d|ment)? for|admitted|confess\w*|diagnos\w*|arrest\w*|convict\w*|secret)\b/i,
    "describes facts or strategy",
  ],
];

export interface EntryScreening {
  ok: boolean;
  problems: string[];
}

/**
 * c61 §4.2.2 / rule 2: names, general subject, role and dates only. Returns
 * the problems so the hire can shorten the entry; the rejected text is never
 * stored. Pure.
 */
export function screenPriorMatterEntry(entry: PriorMatterEntry, maxChars: number, nowYear = new Date().getUTCFullYear()): EntryScreening {
  const problems: string[] = [];
  const names = [...entry.clientNames, ...entry.adversePartyNames].map((n) => n.trim()).filter(Boolean);
  if (entry.clientNames.filter((n) => n.trim()).length === 0) problems.push("Enter at least one client name.");
  for (const n of names) {
    if (n.length > maxChars) problems.push(`A name is longer than ${maxChars} characters.`);
    if (/\d{3,}/.test(n)) problems.push("Names should not contain numbers.");
  }
  if (!(SUBJECT_CATEGORIES as readonly string[]).includes(entry.subjectCategory)) problems.push("Choose a general subject from the list.");
  if (entry.role !== "lawyer" && entry.role !== "staff") problems.push("Role must be lawyer or staff.");
  const note = entry.subjectNote?.trim() ?? "";
  if (note.length > maxChars) problems.push(`The subject note is longer than ${maxChars} characters; keep it general.`);
  for (const text of [note, entry.formerFirmName?.trim() ?? ""]) {
    for (const [re, why] of DETAIL_PATTERNS) if (text && re.test(text)) problems.push(`The subject note ${why}; keep it to a general subject.`);
  }
  for (const y of [entry.fromYear, entry.toYear]) {
    if (y !== null && y !== undefined && (!Number.isInteger(y) || y < 1950 || y > nowYear + 1)) problems.push("Years must be four-digit years.");
  }
  if (entry.fromYear && entry.toYear && entry.fromYear > entry.toYear) problems.push("The start year is after the end year.");
  return { ok: problems.length === 0, problems: [...new Set(problems)] };
}

/** Does this local calendar day have any business time? */
function isBusinessDay(y: number, m: number, d: number, cal: BusinessCalendar): Date | null {
  const dayStart = fromLocal(y, m, d, 0, 0, cal.timeZone);
  const next = nextBusinessStart(dayStart, cal);
  return localDateString(next, cal.timeZone) === localDateString(dayStart, cal.timeZone) ? next : null;
}

/**
 * When the lateral list is due: the opening of the business day that is
 * `businessDays` business days before the start date (c61 rule 4). Pure.
 */
export function lateralDueAt(startDate: string, businessDays: number, cal: BusinessCalendar): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(startDate);
  if (!match) throw new Error("startDate must be YYYY-MM-DD.");
  let cursor = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  let counted = 0;
  let last: Date | null = null;
  for (let i = 0; i < 400 && counted < Math.max(1, businessDays); i++) {
    cursor = new Date(cursor.getTime() - 86_400_000);
    const open = isBusinessDay(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, cursor.getUTCDate(), cal);
    if (open) {
      counted++;
      last = open;
    }
  }
  if (!last) throw new Error("No business day found before the start date.");
  return last;
}

export type LateralStatus = "awaiting_list" | "checking" | "awaiting_decisions" | "complete" | "no_prior_employment";

/** c61 rule 3: until complete, no matter access except the firm's exception list. Pure. */
export function lateralMatterAccess(
  status: LateralStatus | null,
  exceptionMatterIds: readonly string[]
): { unrestricted: boolean; allowedMatterIds: string[] } {
  if (status === null || status === "complete" || status === "no_prior_employment") return { unrestricted: true, allowedMatterIds: [] };
  return { unrestricted: false, allowedMatterIds: [...exceptionMatterIds] };
}

/**
 * A lateral check is complete when every hit has a decision whose conditions
 * are met. 'Declined' here means "the hire may not work on that matter" — it
 * completes the check (the restriction is flagged to the owner). Pure.
 */
export function lateralChecksComplete(results: readonly GateResult[]): boolean {
  return results.every((r) => r.state === "open" || r.closedReason === "declined");
}

/** Start date reached without a complete check (c61 §4.4). Pure. */
export function startDatePassedIncomplete(status: LateralStatus, startDate: string, now: Date, timeZone: string): boolean {
  if (status === "complete" || status === "no_prior_employment") return false;
  return localDateString(now, timeZone) >= startDate;
}
