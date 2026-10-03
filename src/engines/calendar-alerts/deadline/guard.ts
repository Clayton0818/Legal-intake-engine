// Guardrails on text that reaches a client. Pure, no I/O. Each check returns
// a list of findings (empty = OK); callers refuse to send when it is not empty.
//
//  - checkNoDeadlineStatement  c44 rule 5: an acknowledgement to a deadline
//    question never states, confirms or corrects a date and never describes
//    consequences. The promised reply-by time is the only date allowed, and
//    the caller passes it in `allowed`.
//  - checkNeutralWording       c42 rule 3 / c46 rule 3: reminders never state
//    legal consequences unless a lawyer approved that wording.
//  - checkUpdateDraft          c54 rule 4/6: AI/system drafts report facts and
//    dates only — no predictions, assessments, advice or internal data.

const DATE_PATTERNS: ReadonlyArray<[string, RegExp]> = [
  ["month_day", /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b/i],
  ["numeric_date", /\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/],
  ["iso_date", /\b\d{4}-\d{2}-\d{2}\b/],
  ["weekday", /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)\b/i],
  ["relative_day", /\b(today|tomorrow|tonight|yesterday|hoy|ma[ñn]ana|ayer)\b/i],
  ["day_count", /\b\d+\s+(business\s+|calendar\s+)?(days?|weeks?|d[ií]as?|semanas?)\b/i],
];

const DEADLINE_STATEMENTS: ReadonlyArray<[string, RegExp]> = [
  ["your_deadline_is", /\b(your|the)\s+(deadline|hearing|court\s+date|trial|answer|response)\s+(is|was|will\s+be)\b/i],
  ["is_due", /\b(is|are)\s+due\s+(on|by)\b/i],
  ["you_must_file", /\byou\s+(must|need\s+to|have\s+to)\s+(file|respond|answer|appear)\b/i],
];

const CONSEQUENCES: ReadonlyArray<[string, RegExp]> = [
  ["dismissal", /\bdismiss(ed|al)?\b/i],
  ["default", /\bdefault(\s+judg(e)?ment)?\b/i],
  ["lose_case", /\blose\s+(your|the)\s+(case|rights?|custody|claim)\b/i],
  ["warrant", /\bwarrant\b/i],
  ["contempt", /\bcontempt\b/i],
  ["withdraw", /\bwithdraw(al)?\b/i],
  ["sanctions", /\bsanctions?\b/i],
  ["too_late", /\b(too\s+late|time[- ]barred|barred)\b/i],
  ["es_consequence", /\b(desestim\w+|perder\s+(su|el)\s+caso|orden\s+de\s+arresto|desacato)\b/i],
];

const PREDICTIONS_AND_ADVICE: ReadonlyArray<[string, RegExp]> = [
  ["likelihood", /\b(likely|unlikely|probably|probable|chances?|odds)\b/i],
  ["outcome_prediction", /\b(will|should|expect\s+to)\s+(win|lose|get|be\s+granted|be\s+awarded|prevail)\b/i],
  ["assessment", /\b(strong|weak|good|bad|solid)\s+(case|position|claim|argument)\b/i],
  ["advice", /\b(we|i)\s+(recommend|advise|suggest)\b|\byou\s+should\b/i],
  ["guarantee", /\bguarantee(d|s)?\b/i],
  ["judge_expectation", /\b(the\s+)?(judge|court)\s+(will|is\s+going\s+to|should)\b/i],
];

const INTERNAL_LEAKS: ReadonlyArray<[string, RegExp]> = [
  ["overdue", /\boverdue\b/i],
  ["behind", /\b(we\s+are|we're|firm\s+is)\s+behind\b/i],
  ["flag", /\bflag(ged|s)?\b/i],
  ["health_score", /\bhealth\s+(score|meter)\b/i],
  ["internal_note", /\binternal\s+(note|task|flag)s?\b/i],
  ["escalated", /\bescalat\w*\b/i],
];

function scan(text: string, rules: ReadonlyArray<[string, RegExp]>): string[] {
  return rules.filter(([, re]) => re.test(text)).map(([name]) => name);
}

function stripAllowed(text: string, allowed: readonly string[]): string {
  let out = text;
  for (const a of allowed) if (a) out = out.split(a).join(" ");
  return out;
}

/** c44 rule 5. `allowed` = exact substrings that may contain a date (the reply-by promise). */
export function checkNoDeadlineStatement(text: string, allowed: readonly string[] = []): string[] {
  const t = stripAllowed(text, allowed);
  return [...scan(t, DATE_PATTERNS), ...scan(t, DEADLINE_STATEMENTS), ...scan(t, CONSEQUENCES)];
}

/** c42 rule 3 / c46 rule 3: consequence wording needs a lawyer's approval for that message. */
export function checkNeutralWording(text: string, opts: { consequenceApprovedByUserId?: string | null } = {}): string[] {
  const found = scan(text, CONSEQUENCES);
  return opts.consequenceApprovedByUserId ? [] : found;
}

/** c54 rules 4 + 6: facts and dates only; nothing internal. */
export function checkUpdateDraft(text: string): string[] {
  return [...scan(text, PREDICTIONS_AND_ADVICE), ...scan(text, INTERNAL_LEAKS), ...scan(text, CONSEQUENCES)];
}

/** Human-written client updates may state consequences (the lawyer wrote them) but never internal data. */
export function checkHumanUpdate(text: string): string[] {
  return scan(text, INTERNAL_LEAKS);
}
