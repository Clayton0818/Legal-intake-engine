// c44 — deterministic tagging of client messages. Pure, no I/O.
//
//   classifyDeadlineQuestion(text)   is this message about a deadline? (rules)
//   detectUrgentSafety(text)         conservative safety words → urgent (c43 rule 8)
//   extractClientStatedDates(...)    dates the CLIENT mentions ("my hearing is
//                                    tomorrow") — shown to the lawyer as
//                                    "client-stated, not verified", never
//                                    written to the calendar (c44 rule 7)
//
// These rules are the fallback that always runs; the AI (./model.ts, behind
// vendor.ai_model) can only ADD the deadline tag, never remove it. When the
// rules are unsure they apply the stricter clock (c44 rule 3: a false alarm
// costs little, a missed deadline question costs a lot).
//
// The safety words here are NOT the c35 triage classifier; callers that have
// the classifier's safety flag pass it in, and both are OR-ed.

import { fromLocal, toLocal } from "@/core/businessHours";

export type TagCertainty = "clear" | "uncertain" | "none";

export interface RuleTag {
  deadlineRelated: boolean;
  certainty: TagCertainty;
  matched: string[];
}

interface Rule {
  name: string;
  re: RegExp;
}

const STRONG: readonly Rule[] = [
  { name: "deadline", re: /\bdead\s?lines?\b/i },
  { name: "court_date", re: /\b(court|hearing|trial|mediation|deposition)\s+(date|day|time|setting)s?\b/i },
  { name: "hearing", re: /\bhearings?\b/i },
  { name: "trial", re: /\btrials?\b/i },
  { name: "mediation", re: /\bmediations?\b/i },
  { name: "deposition", re: /\bdepositions?\b/i },
  { name: "file_by", re: /\b(file|filed|filing|submit|sign|respond|answer)\s+(it\s+|this\s+|them\s+)?(by|before)\b/i },
  { name: "is_due", re: /\b(answer|response|reply|paperwork|papers|documents?|forms?|payment)\s+(is\s+|are\s+)?due\b/i },
  { name: "due_date", re: /\bdue\s+(date|by|on|back)\b/i },
  {
    name: "when_do_i_have_to",
    re: /\bwhen\s+(do|must|should|will)\s+(i|we)\s+(have\s+to|need\s+to|file|respond|answer|appear|show\s+up|go\s+to\s+court|sign|submit)\b/i,
  },
  { name: "how_long_do_i_have", re: /\bhow\s+(long|much\s+time|many\s+days)\s+(do|does)\s+(i|we|he|she|they)\s+have\b/i },
  {
    name: "when_is_my",
    re: /\bwhen\s+(is|are|was)\s+(my|the|our)\s+(next\s+)?(court|hearing|trial|deadline|mediation|deposition|answer|response|filing|appearance)\b/i,
  },
  { name: "served_papers", re: /\b(served|summons|citation|subpoena)\b/i },
  { name: "appear_in_court", re: /\b(appear|appearance|show\s+up)\s+(in|at|for)\s+court\b/i },
  { name: "by_when", re: /\bby\s+when\b/i },
  { name: "limitations", re: /\bstatute\s+of\s+limitations?\b/i },
  // Spanish (c36 bilingual pilot): conservative equivalents.
  { name: "es_audiencia", re: /\baudiencias?\b/i },
  { name: "es_fecha_limite", re: /\bfecha\s+(l[ií]mite|de\s+(la\s+)?corte|de\s+audiencia)\b/i },
  { name: "es_plazo", re: /\bplazos?\b/i },
  { name: "es_juicio", re: /\bjuicio\b/i },
  { name: "es_cuando_tengo_que", re: /\bcu[aá]ndo\s+(tengo|tenemos|debo|hay)\s+que\b/i },
  { name: "es_citatorio", re: /\b(citatorio|emplazamiento|notificaci[oó]n\s+de\s+la\s+corte)\b/i },
];

const WEAK: readonly Rule[] = [
  { name: "court", re: /\bcourt(house|room)?\b/i },
  { name: "judge", re: /\bjudge\b/i },
  { name: "filing", re: /\bfil(e|ed|ing)\b/i },
  { name: "due", re: /\bdue\b/i },
  { name: "schedule", re: /\bschedul(e|ed|ing)\b/i },
  { name: "papers", re: /\b(papers|petition|motion|order)\b/i },
  { name: "es_corte", re: /\b(corte|tribunal|juez|jueza)\b/i },
];

/** Rule-based deadline tag. Strong hit → clear; weak hit only → uncertain (stricter clock applies). Pure. */
export function classifyDeadlineQuestion(text: string): RuleTag {
  const strong = STRONG.filter((r) => r.re.test(text)).map((r) => r.name);
  if (strong.length > 0) return { deadlineRelated: true, certainty: "clear", matched: strong };
  const weak = WEAK.filter((r) => r.re.test(text)).map((r) => r.name);
  if (weak.length > 0) return { deadlineRelated: true, certainty: "uncertain", matched: weak };
  return { deadlineRelated: false, certainty: "none", matched: [] };
}

const SAFETY: readonly Rule[] = [
  { name: "in_danger", re: /\b(in\s+danger|not\s+safe|unsafe|afraid\s+for\s+my\s+(life|safety))\b/i },
  { name: "violence", re: /\b(he|she|they)\s+(hit|hurt|beat|choked|attacked|threatened)\s+(me|my|us|the\s+kids)\b/i },
  { name: "threat_to_kill", re: /\b(kill|shoot|stab)\s+(me|us|him|her|myself|the\s+kids)\b/i },
  { name: "self_harm", re: /\b(suicid\w*|end\s+my\s+life|hurt\s+myself)\b/i },
  { name: "child_taken", re: /\b(took|taken|kidnapp?ed|won'?t\s+return)\s+(my|the|our)\s+(kids?|children|child|son|daughter)\b/i },
  { name: "order_violated", re: /\b(protective|restraining)\s+order\b.*\bviolat\w*/i },
  { name: "es_peligro", re: /\b(estoy\s+en\s+peligro|me\s+(peg[oó]|amenaz[oó]|golpe[oó]))\b/i },
];

/** Conservative safety words (NOT the c35 classifier). Any hit → urgent. Pure. */
export function detectUrgentSafety(text: string): { urgent: boolean; matched: string[] } {
  const matched = SAFETY.filter((r) => r.re.test(text)).map((r) => r.name);
  return { urgent: matched.length > 0, matched };
}

// ---------------------------------------------------------------------------
// Client-stated dates
// ---------------------------------------------------------------------------

export interface ClientStatedDate {
  /** Start of that local day in the firm's zone (time unknown → earliest moment, the conservative choice). */
  at: Date;
  /** 'YYYY-MM-DD' local. */
  localDate: string;
  snippet: string;
  kind: "relative_day" | "weekday" | "month_day" | "numeric" | "iso";
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9,
  octubre: 10, noviembre: 11, diciembre: 12,
};

const WEEKDAYS: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
  domingo: 0, lunes: 1, martes: 2, "miércoles": 3, miercoles: 3, jueves: 4, viernes: 5, "sábado": 6, sabado: 6,
};

interface Civil {
  y: number;
  m: number;
  d: number;
}

function addDays(c: Civil, n: number): Civil {
  const t = new Date(Date.UTC(c.y, c.m - 1, c.d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

function dayNumber(c: Civil): number {
  return Math.floor(Date.UTC(c.y, c.m - 1, c.d) / 86_400_000);
}

function validCivil(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

function civilString(c: Civil): string {
  return `${c.y}-${String(c.m).padStart(2, "0")}-${String(c.d).padStart(2, "0")}`;
}

/** A month/day without a year: this year, unless that is more than a week ago (then next year). */
function inferYear(m: number, d: number, today: Civil): Civil | null {
  for (const y of [today.y, today.y + 1]) {
    if (!validCivil(y, m, d)) continue;
    const c = { y, m, d };
    if (dayNumber(c) >= dayNumber(today) - 7) return c;
  }
  return null;
}

/**
 * Dates the client mentions, earliest first. Pure. Ambiguous phrases ("next
 * week", "soon") are ignored; a past date within a week is kept (a client
 * asking about yesterday's hearing must alert the lawyer, c44 §4 edge case).
 */
export function extractClientStatedDates(text: string, receivedAt: Date, timeZone: string): ClientStatedDate[] {
  const l = toLocal(receivedAt, timeZone);
  const today: Civil = { y: l.year, m: l.month, d: l.day };
  const todayDow = new Date(Date.UTC(today.y, today.m - 1, today.d)).getUTCDay();
  const found: Array<{ c: Civil; snippet: string; kind: ClientStatedDate["kind"] }> = [];
  const push = (c: Civil | null, snippet: string, kind: ClientStatedDate["kind"]) => {
    if (c) found.push({ c, snippet: snippet.trim(), kind });
  };

  for (const m of text.matchAll(/\b(today|tonight|this\s+(morning|afternoon|evening)|hoy|esta\s+(mañana|tarde|noche))\b/gi)) push(today, m[0], "relative_day");
  for (const m of text.matchAll(/\b(tomorrow|tmrw|pasado\s+ma[ñn]ana|(?<!esta\s)ma[ñn]ana(?!\s+(?:por|en)\b))/gi)) {
    push(addDays(today, /pasado/i.test(m[0]) ? 2 : 1), m[0], "relative_day");
  }
  for (const m of text.matchAll(/\b(yesterday|ayer)\b/gi)) push(addDays(today, -1), m[0], "relative_day");

  const weekdayRe = new RegExp(`\\b(this\\s+|next\\s+|on\\s+|el\\s+|este\\s+|pr[oó]ximo\\s+)?(${Object.keys(WEEKDAYS).join("|")})\\b`, "gi");
  for (const m of text.matchAll(weekdayRe)) {
    const target = WEEKDAYS[(m[2] ?? "").toLowerCase()];
    if (target === undefined) continue;
    let delta = (target - todayDow + 7) % 7;
    const qualifier = (m[1] ?? "").trim().toLowerCase();
    if (delta === 0 && (qualifier === "next" || qualifier.startsWith("pr"))) delta = 7;
    push(addDays(today, delta), m[0], "weekday");
  }

  const monthNames = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|");
  const monthDay = new RegExp(`\\b(${monthNames})\\.?\\s+(\\d{1,2})(st|nd|rd|th)?(,?\\s+(\\d{4}))?\\b`, "gi");
  for (const m of text.matchAll(monthDay)) {
    const month = MONTHS[(m[1] ?? "").toLowerCase()];
    const day = Number(m[2]);
    if (!month) continue;
    if (m[5]) push(validCivil(Number(m[5]), month, day) ? { y: Number(m[5]), m: month, d: day } : null, m[0], "month_day");
    else push(inferYear(month, day, today), m[0], "month_day");
  }
  const dayMonthEs = new RegExp(`\\b(\\d{1,2})\\s+de\\s+(${monthNames})\\b`, "gi");
  for (const m of text.matchAll(dayMonthEs)) {
    const month = MONTHS[(m[2] ?? "").toLowerCase()];
    if (month) push(inferYear(month, Number(m[1]), today), m[0], "month_day");
  }

  for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    push(validCivil(y, mo, d) ? { y, m: mo, d } : null, m[0], "iso");
  }
  // US numeric dates (m/d or m/d/yy[yy]); skips the ISO form above.
  for (const m of text.matchAll(/(?<![\d-])(\d{1,2})\/(\d{1,2})(\/(\d{2}|\d{4}))?(?![\d/])/g)) {
    const mo = Number(m[1]);
    const d = Number(m[2]);
    if (m[4]) {
      const y = m[4].length === 2 ? 2000 + Number(m[4]) : Number(m[4]);
      push(validCivil(y, mo, d) ? { y, m: mo, d } : null, m[0], "numeric");
    } else push(inferYear(mo, d, today), m[0], "numeric");
  }

  const seen = new Set<string>();
  return found
    .filter((f) => dayNumber(f.c) >= dayNumber(today) - 7) // older than a week: not an upcoming event
    .sort((a, b) => dayNumber(a.c) - dayNumber(b.c))
    .filter((f) => {
      const key = civilString(f.c);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((f) => ({ at: fromLocal(f.c.y, f.c.m, f.c.d, 0, 0, timeZone), localDate: civilString(f.c), snippet: f.snippet, kind: f.kind }));
}
