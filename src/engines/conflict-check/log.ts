// c63 — conflicts log and report. Pure record shaping, visibility, waiting
// times, redaction and CSV. INTERNAL ONLY: nothing here is ever shown to a
// client or prospect.

import { businessHoursBetween, type BusinessCalendar } from "@/core";
import type { ConflictCapability } from "./access";
import { interestOwners } from "./decisions";
import type { ConflictHit, SearchedName } from "./types";

export interface LogDecision {
  id: string;
  decision: string;
  reasonCode: string;
  reasonText: string | null;
  ruleTableRefs: string[];
  overrideFlag: boolean;
  decidedByUserId: string;
  decidedAt: string;
  supersedesDecisionId: string | null;
}

export interface LogWaiver {
  id: string;
  clientName: string;
  status: string;
  sentAt: string | null;
  signedAt: string | null;
  countersignedAt: string | null;
}

export interface LogScreen {
  id: string;
  screenedUserId: string;
  status: string;
  activatedAt: string | null;
  noticeSentAt: string | null;
}

export interface LogLetter {
  id: string;
  status: string;
  channel: string | null;
  sentAt: string | null;
}

export interface LogGateEvent {
  at: string;
  from: string | null;
  to: string;
  closedReason: string | null;
}

export interface LogRecord {
  checkId: string;
  trigger: string;
  triggeredByUserId: string | null;
  createdAt: string;
  matterId: string | null;
  intakeSessionId: string | null;
  searched: SearchedName[];
  hits: ConflictHit[];
  outcome: string;
  outcomeReasons: string[];
  status: string;
  assignedUserId: string | null;
  dueAt: string | null;
  decisions: LogDecision[];
  waivers: LogWaiver[];
  screens: LogScreen[];
  letters: LogLetter[];
  gateHistory: LogGateEvent[];
}

/** Does this record involve a lawyer's own interests (c97)? */
export function involvesInterests(record: Pick<LogRecord, "trigger" | "hits">): boolean {
  return record.trigger === "interest" || interestOwners(record.hits).length > 0;
}

/**
 * c63 rules 1, 3, 4: conflicts role and owner/admin only; interest hits
 * only for the conflicts role; a screened user never sees the matter's
 * records, whatever their role. Pure.
 */
export function canSeeRecord(
  record: Pick<LogRecord, "trigger" | "hits" | "matterId" | "intakeSessionId">,
  caps: ReadonlySet<ConflictCapability>,
  screenedSubjectIds: ReadonlySet<string>
): boolean {
  if (!caps.has("log.view")) return false;
  if (involvesInterests(record) && !caps.has("log.view_interests")) return false;
  if (record.matterId && screenedSubjectIds.has(record.matterId)) return false;
  if (record.intakeSessionId && screenedSubjectIds.has(record.intakeSessionId)) return false;
  return true;
}

/** c63 rule 7: waiting time in firm business hours (matches the c59 timer) and real-clock age. Pure. */
export function waitingTimes(createdAt: Date, now: Date, calendar: BusinessCalendar): { businessHours: number; realHours: number } {
  return {
    businessHours: Math.round(Math.max(0, businessHoursBetween(createdAt, now, calendar)) * 10) / 10,
    realHours: Math.round(Math.max(0, (now.getTime() - createdAt.getTime()) / 3_600_000) * 10) / 10,
  };
}

export type RedactionLevel = "full" | "summary";

/** Summary redaction: counts and process only, no party names or free-text reasons (c63 §4.3.2). Pure. */
export function redactRecord(record: LogRecord, level: RedactionLevel): LogRecord {
  if (level === "full") return record;
  return {
    ...record,
    searched: record.searched.map((s) => ({ name: "[redacted]", role: s.role, nameUnknown: s.nameUnknown })),
    hits: record.hits.map((h) => ({
      ...h,
      searchedName: "[redacted]",
      displayName: "[redacted]",
      matchedName: "[redacted]",
      reasons: [],
      note: null,
      partyId: null,
      sourceId: "[redacted]",
      ownerUserId: null,
      involvements: h.involvements.map((i) => ({ ...i, id: "[redacted]" })),
    })),
    decisions: record.decisions.map((d) => ({ ...d, reasonText: d.reasonText ? "[redacted]" : null })),
    waivers: record.waivers.map((w) => ({ ...w, clientName: "[redacted]" })),
    screens: record.screens.map((s) => ({ ...s, screenedUserId: "[redacted]" })),
  };
}

function csvCell(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  // Guard against spreadsheet formula injection as well as quoting.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export const CSV_COLUMNS = [
  "check_id",
  "created_at",
  "trigger",
  "triggered_by",
  "outcome",
  "outcome_reasons",
  "searched",
  "hit_count",
  "hits",
  "status",
  "decision",
  "decided_at",
  "decided_by",
  "reason_code",
  "reason_text",
  "override",
  "waivers",
  "screens",
  "letters",
] as const;

/** One CSV row per check (latest decision shown; history is in JSON exports). Pure. */
export function toCsv(records: readonly LogRecord[], level: RedactionLevel): string {
  const lines = [CSV_COLUMNS.join(",")];
  for (const raw of records) {
    const r = redactRecord(raw, level);
    const d = r.decisions.at(-1);
    const row = [
      r.checkId,
      r.createdAt,
      r.trigger,
      r.triggeredByUserId ?? "system",
      r.outcome,
      r.outcomeReasons.join("; "),
      level === "full" ? r.searched.map((s) => `${s.name} (${s.role})`).join("; ") : String(r.searched.length),
      String(r.hits.length),
      level === "full"
        ? r.hits.map((h) => `${h.displayName} [${h.matchKind} ${h.strength}]`).join("; ")
        : r.hits.map((h) => h.matchKind).join("; "),
      r.status,
      d?.decision ?? "",
      d?.decidedAt ?? "",
      d?.decidedByUserId ?? "",
      d?.reasonCode ?? "",
      d?.reasonText ?? "",
      d ? String(d.overrideFlag) : "",
      r.waivers.map((w) => `${w.clientName}: ${w.status}${w.signedAt ? ` signed ${w.signedAt}` : ""}${w.countersignedAt ? ` countersigned ${w.countersignedAt}` : ""}`).join("; "),
      r.screens.map((s) => `${s.screenedUserId}: ${s.status}${s.noticeSentAt ? ` notice ${s.noticeSentAt}` : ""}`).join("; "),
      r.letters.map((l) => `${l.status}${l.sentAt ? ` ${l.sentAt}` : ""}`).join("; "),
    ];
    lines.push(row.map(csvCell).join(","));
  }
  return lines.join("\n") + "\n";
}

export interface LogSummary {
  total: number;
  byOutcome: Record<string, number>;
  byDecision: Record<string, number>;
  open: number;
  overrides: number;
  waiversSigned: number;
  screensActive: number;
}

/** Counts for the summary report (insurer applications). Pure. */
export function summarize(records: readonly LogRecord[]): LogSummary {
  const s: LogSummary = { total: records.length, byOutcome: {}, byDecision: {}, open: 0, overrides: 0, waiversSigned: 0, screensActive: 0 };
  for (const r of records) {
    s.byOutcome[r.outcome] = (s.byOutcome[r.outcome] ?? 0) + 1;
    const d = r.decisions.at(-1);
    if (d) s.byDecision[d.decision] = (s.byDecision[d.decision] ?? 0) + 1;
    if (r.status === "open") s.open++;
    if (r.decisions.some((x) => x.overrideFlag)) s.overrides++;
    s.waiversSigned += r.waivers.filter((w) => w.status === "signed").length;
    s.screensActive += r.screens.filter((x) => x.status === "active").length;
  }
  return s;
}

export interface LogFilter {
  from?: string;
  to?: string;
  outcome?: string;
  status?: string;
  trigger?: string;
  /** Name search across searched names and hits (full access only). */
  q?: string;
}

export function matchesFilter(record: LogRecord, filter: LogFilter, normalize: (s: string) => string): boolean {
  if (filter.from && record.createdAt < filter.from) return false;
  if (filter.to && record.createdAt > filter.to) return false;
  if (filter.outcome && record.outcome !== filter.outcome) return false;
  if (filter.status && record.status !== filter.status) return false;
  if (filter.trigger && record.trigger !== filter.trigger) return false;
  if (filter.q) {
    const q = normalize(filter.q);
    const hay = [...record.searched.map((s) => s.name), ...record.hits.map((h) => h.displayName)].map(normalize);
    if (!hay.some((h) => h.includes(q))) return false;
  }
  return true;
}
