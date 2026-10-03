// c64 — court-email detection. Pure, no I/O.
//
//   classifyCourtEmail()  'court_verified' only when the sender domain is on
//                         the firm's trusted list AND authentication passes
//                         (DMARC pass plus an aligned DKIM pass or SPF pass).
//                         Look-alikes and trusted-but-unauthenticated mail are
//                         'possible_phishing' (metadata only, never treated as
//                         a notice). Everything else is 'ignore' and is never
//                         stored (least privilege: privileged mail stays put).
//   findCauseNumbers()    for matching a notice to a matter.
//   mentionsName()        party-name matching on normalised text.
//   extractDateSuggestions()  explicit dates → SUGGESTIONS a lawyer confirms;
//                         relative periods ("within 20 days") are kept as text
//                         and NEVER turned into a date. The system never
//                         calculates or decides a legal deadline.
//   ackDueAt() / escalation timing — REAL clock.
//
// Attorney/IT review: the detection rules and the no-calculation rule
// (gate rules.calendar-alerts.court_notice_suggestions).

import { fromLocal, isBusinessTime, nextBusinessStart, toLocal, type BusinessCalendar } from "@/core/businessHours";
import { normalizeName } from "@/core/contacts";
import type { TrustedCourtSender } from "../settings";

export type AuthVerdict = "pass" | "fail" | "softfail" | "neutral" | "none" | "temperror" | "permerror";

export interface EmailAuthResults {
  spf?: AuthVerdict | null;
  dkim?: AuthVerdict | null;
  /** The d= domain of the passing DKIM signature. */
  dkimDomain?: string | null;
  dmarc?: AuthVerdict | null;
}

export interface InboundCourtEmail {
  /** Provider message id (dedupe). */
  externalId: string;
  source: "mailbox" | "efiling" | "manual";
  sourceAccount: string | null;
  fromAddress: string;
  fromDisplayName: string | null;
  subject: string;
  bodyText: string;
  receivedAt: Date;
  auth: EmailAuthResults;
  attachments: Array<{ filename: string; mimeType: string | null; sizeBytes: number | null; sha256: string | null }>;
}

export type CourtClassification = "court_verified" | "possible_phishing" | "ignore";

export interface ClassifyResult {
  classification: CourtClassification;
  trustedSender: TrustedCourtSender | null;
  reasons: string[];
}

export function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  return (at >= 0 ? address.slice(at + 1) : address).trim().toLowerCase().replace(/[>\s]+$/, "");
}

/** Exact domain or a sub-domain of it ('notices.efiletexas.gov' matches 'efiletexas.gov'). */
export function isSameOrSubdomain(domain: string, of: string): boolean {
  const d = domain.toLowerCase();
  const o = of.toLowerCase();
  return d === o || d.endsWith(`.${o}`);
}

export function matchTrustedSender(domain: string, senders: readonly TrustedCourtSender[]): TrustedCourtSender | null {
  return senders.find((s) => isSameOrSubdomain(domain, s.domain)) ?? null;
}

/** DMARC pass plus an aligned DKIM pass or an SPF pass. Anything missing fails safe. */
export function authenticationPasses(auth: EmailAuthResults, trustedDomain: string): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (auth.dmarc !== "pass") reasons.push(`DMARC ${auth.dmarc ?? "missing"}`);
  const dkimAligned = auth.dkim === "pass" && Boolean(auth.dkimDomain) && isSameOrSubdomain(String(auth.dkimDomain), trustedDomain);
  if (!dkimAligned && auth.spf !== "pass") reasons.push(`no aligned DKIM pass (dkim ${auth.dkim ?? "missing"}${auth.dkimDomain ? ` d=${auth.dkimDomain}` : ""}) and SPF ${auth.spf ?? "missing"}`);
  return { ok: reasons.length === 0, reasons };
}

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length]![b.length]!;
}

const COURT_WORDS = /\b(court|courts|clerk|judicial|judiciary|efile|e-file|efiling|e-filing|txcourts|uscourts|pacer|cm\/?ecf|tribunal|juzgado)\b/i;
const COURT_WORDS_IN_DOMAIN = /(court|clerk|judicial|efile|txcourts|uscourts|pacer|ecf)/i;

/** Looks like a court or e-filing sender without being a trusted one. */
export function looksLikeCourt(domain: string, displayName: string | null, subject: string, senders: readonly TrustedCourtSender[]): string[] {
  const reasons: string[] = [];
  const base = (d: string) => d.split(".").slice(-2, -1)[0] ?? d;
  for (const s of senders) {
    const near = levenshtein(domain, s.domain.toLowerCase());
    if (near > 0 && near <= 2) reasons.push(`domain '${domain}' is one or two characters away from trusted '${s.domain}'`);
    else if (domain.includes(base(s.domain.toLowerCase())) && !isSameOrSubdomain(domain, s.domain)) reasons.push(`domain '${domain}' contains the trusted name '${base(s.domain)}'`);
  }
  if (COURT_WORDS_IN_DOMAIN.test(domain)) reasons.push(`domain '${domain}' uses court words but is not on the trusted list`);
  if (displayName && COURT_WORDS.test(displayName)) reasons.push(`display name '${displayName}' claims to be a court or e-filing service`);
  if (COURT_WORDS.test(subject) && /\b(notice|order|hearing|served|service|filing|envelope)\b/i.test(subject)) reasons.push("subject reads like a court notice");
  return [...new Set(reasons)];
}

export function classifyCourtEmail(email: Pick<InboundCourtEmail, "fromAddress" | "fromDisplayName" | "subject" | "auth">, senders: readonly TrustedCourtSender[]): ClassifyResult {
  const domain = domainOf(email.fromAddress);
  const trusted = matchTrustedSender(domain, senders);
  if (trusted) {
    const auth = authenticationPasses(email.auth, trusted.domain);
    if (auth.ok) return { classification: "court_verified", trustedSender: trusted, reasons: [`trusted sender ${trusted.label} (${trusted.domain}); authentication passed`] };
    return { classification: "possible_phishing", trustedSender: null, reasons: [`claims trusted sender ${trusted.domain} but authentication failed: ${auth.reasons.join("; ")}`] };
  }
  const lookalike = looksLikeCourt(domain, email.fromDisplayName, email.subject, senders);
  if (lookalike.length > 0) return { classification: "possible_phishing", trustedSender: null, reasons: lookalike };
  return { classification: "ignore", trustedSender: null, reasons: [] };
}

// ---------------------------------------------------------------------------
// Matching inputs
// ---------------------------------------------------------------------------

/** Upper case, no spaces, single dashes, no trailing punctuation. */
export function normalizeCauseNumber(raw: string): string {
  return raw.toUpperCase().replace(/\s+/g, "").replace(/[–—]/g, "-").replace(/-+/g, "-").replace(/[.,;:]+$/, "");
}

const CAUSE_RE = /\b(?:cause|case|docket)\s*(?:no\.?|number|num\.?|#)\s*:?\s*([A-Z0-9][A-Z0-9\-./]{2,30}[A-Z0-9])/gi;

export function findCauseNumbers(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(CAUSE_RE)) if (m[1] && /\d/.test(m[1])) out.add(normalizeCauseNumber(m[1]));
  return [...out];
}

/** Does the (normalised) text contain this full name? Single-word names are too weak to match on. */
export function mentionsName(normalizedText: string, normalizedName: string): boolean {
  if (normalizedName.split(" ").length < 2) return false;
  return ` ${normalizedText} `.includes(` ${normalizedName} `);
}

export function normalizedNoticeText(subject: string, body: string): string {
  return normalizeName(`${subject} ${body}`);
}

// ---------------------------------------------------------------------------
// Date suggestions (never a calculation)
// ---------------------------------------------------------------------------

export interface DateSuggestion {
  kind: "explicit_date" | "relative_period";
  label: "hearing" | "trial" | "deadline" | "other";
  snippet: string;
  /** Explicit dates only. Never computed from a relative period. */
  proposedAt: Date | null;
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function labelFor(context: string): DateSuggestion["label"] {
  if (/\btrial\b/i.test(context)) return "trial";
  if (/\bhearing|docket call|setting\b/i.test(context)) return "hearing";
  if (/\b(due|deadline|answer|respond|response|file|filed|no later than|on or before)\b/i.test(context)) return "deadline";
  return "other";
}

/** The words of the match's own sentence (before it, the match, a little after) — labels never leak across sentences. */
function sentenceContext(text: string, index: number, length: number, includeAfter: boolean): string {
  const start = Math.max(text.lastIndexOf(". ", index - 1), text.lastIndexOf("\n", index - 1)) + 1;
  const tail = text.slice(index + length, index + length + 30);
  const stop = tail.search(/\.\s|\n/);
  return text.slice(start, index + length) + (includeAfter ? (stop >= 0 ? tail.slice(0, stop) : tail) : "");
}

function snippetAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 60);
  const end = Math.min(text.length, index + length + 40);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

function parseTime(after: string): { h: number; m: number } | null {
  const t = /^\s*(?:,\s*)?(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)/i.exec(after);
  if (!t) return null;
  let h = Number(t[1]) % 12;
  if (/p/i.test(t[3] ?? "")) h += 12;
  return { h, m: Number(t[2] ?? 0) };
}

export function extractDateSuggestions(text: string, timeZone: string): DateSuggestion[] {
  const out: DateSuggestion[] = [];
  const seen = new Set<string>();
  const push = (y: number, mo: number, d: number, index: number, len: number) => {
    const probe = new Date(Date.UTC(y, mo - 1, d));
    if (probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return;
    const time = parseTime(text.slice(index + len, index + len + 20));
    const at = fromLocal(y, mo, d, time?.h ?? 0, time?.m ?? 0, timeZone);
    const key = at.toISOString();
    if (seen.has(key)) return;
    seen.add(key);
    const snippet = snippetAround(text, index, len);
    out.push({ kind: "explicit_date", label: labelFor(sentenceContext(text, index, len, true)), snippet, proposedAt: at });
  };
  const monthRe = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/gi;
  for (const m of text.matchAll(monthRe)) push(Number(m[3]), MONTHS[(m[1] ?? "").slice(0, 3).toLowerCase()] ?? 0, Number(m[2]), m.index ?? 0, m[0].length);
  for (const m of text.matchAll(/(?<![\d/])(\d{1,2})\/(\d{1,2})\/(\d{4})(?![\d/])/g)) push(Number(m[3]), Number(m[1]), Number(m[2]), m.index ?? 0, m[0].length);

  const relRe = /\b(within|no later than|not later than)\s+(\d{1,3}|[a-z]+(?:-[a-z]+)?)\s+(business\s+|calendar\s+|court\s+)?days?\b[^.]{0,80}/gi;
  for (const m of text.matchAll(relRe)) {
    const snippet = snippetAround(text, m.index ?? 0, m[0].length);
    out.push({ kind: "relative_period", label: labelFor(sentenceContext(text, m.index ?? 0, m[0].length, false)), snippet, proposedAt: null });
  }
  for (const m of text.matchAll(/\b(\d{1,3})\s+days\s+(after|from)\b[^.]{0,80}/gi)) {
    const snippet = snippetAround(text, m.index ?? 0, m[0].length);
    if (!out.some((o) => o.kind === "relative_period" && o.snippet === snippet)) {
      out.push({ kind: "relative_period", label: labelFor(sentenceContext(text, m.index ?? 0, m[0].length, false)), snippet, proposedAt: null });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Acknowledgement and escalation (REAL clock)
// ---------------------------------------------------------------------------

/**
 * When a person must acknowledge the alert: `ackMinutes` real minutes when it
 * arrives in business hours; otherwise `afterHoursMinutes` after the next
 * business opening ("first thing next business morning").
 */
export function ackDueAt(arrivedAt: Date, calendar: BusinessCalendar, ackMinutes: number, afterHoursMinutes: number): Date {
  if (isBusinessTime(arrivedAt, calendar)) return new Date(arrivedAt.getTime() + ackMinutes * 60_000);
  return new Date(nextBusinessStart(arrivedAt, calendar).getTime() + afterHoursMinutes * 60_000);
}

/**
 * Escalation for an unacknowledged alert: step 1 at the ack deadline adds the
 * backup lawyer; step 2 one more ack window later adds the owner(s)/admin(s).
 * Returns the step due now (or null).
 */
export function escalationStepDue(input: { step: number; ackDueAt: Date; ackMinutes: number; acknowledged: boolean; now: Date }): 1 | 2 | null {
  if (input.acknowledged) return null;
  const t = input.now.getTime();
  if (input.step < 1 && t >= input.ackDueAt.getTime()) return 1;
  if (input.step < 2 && t >= input.ackDueAt.getTime() + input.ackMinutes * 60_000) return 2;
  return null;
}

/** Plain factual timing note for the alert (no legal conclusion about service dates). */
export function arrivalNote(receivedAt: Date, calendar: BusinessCalendar): string {
  const l = toLocal(receivedAt, calendar.timeZone);
  const when = new Intl.DateTimeFormat("en-US", { timeZone: calendar.timeZone, weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(receivedAt);
  const outside = !isBusinessTime(receivedAt, calendar);
  return `Received ${when}${outside ? " (outside business hours)" : ""}${l.hour >= 17 ? ", after 5:00 p.m. local time" : ""}. A lawyer must review any dates; none have been calendared or calculated.`;
}
