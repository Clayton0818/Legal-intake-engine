// c53 — case health meter. Pure, no I/O.
//
// Two explainable sub-scores (0–100) from signals the other cards already
// record; overall = the LOWER of the two (proposed, open question 1) so a
// problem on either side shows. Unmeasured signals are excluded and their
// weight redistributed (§4.5). Every score carries its top reasons in plain,
// factual words (rule 2, rule 5: never labels about people). INTERNAL ONLY;
// the score only prompts a person to look — it never triggers any action
// beyond an internal flag (rule 6).

import type { HealthSettings } from "../settings";

export type Band = "green" | "amber" | "red" | "insufficient_data";

export interface HealthSignals {
  // Firm responsiveness
  /** Reply clocks (last 30 days) whose internal target passed / whose client promise was missed. */
  replyTargetsMissed: number;
  replyPromisesMissed: number;
  overdueFirmTasks: number;
  overdueCriticalFirmTasks: number;
  openStalls: number;
  /** Business days since the last meaningful update to the client (sent update or human reply). */
  businessDaysSinceUpdate: number;
  // Client engagement
  /** Open c42 non-response chases (messages). */
  openNonResponses: number;
  overdueClientTasks: number;
  /** null = not measured (signal source not available). */
  missingDocuments: number | null;
  delayedSignOffs: number | null;
  retainerIssues: number | null;
  /** null = not measured (e.g. excluded for DV-sensitive matters). */
  businessDaysSinceClientActivity: number | null;
}

export interface Component {
  key: string;
  weight: number;
  /** 0..100, null = not measured. */
  score: number | null;
  /** Plain-words reason when the component costs points. */
  reason: string | null;
}

export interface HealthResult {
  score: number | null;
  firmSubscore: number | null;
  clientSubscore: number | null;
  band: Band;
  firmReasons: string[];
  clientReasons: string[];
  notMeasured: string[];
}

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** 100 up to `okDays`, falling linearly to 0 at `zeroDays`. */
export function silenceScore(days: number, okDays = 5, zeroDays = 20): number {
  if (days <= okDays) return 100;
  if (days >= zeroDays) return 0;
  return clamp(100 - ((days - okDays) / (zeroDays - okDays)) * 100);
}

export function firmComponents(s: HealthSignals, w: HealthSettings["weights"]["firm"]): Component[] {
  const replyPenalty = s.replyTargetsMissed * 25 + s.replyPromisesMissed * 50;
  const taskScore = s.overdueCriticalFirmTasks > 0 ? 0 : clamp(100 - s.overdueFirmTasks * 25);
  return [
    {
      key: "replyTimes",
      weight: w.replyTimes,
      score: clamp(100 - replyPenalty),
      reason:
        replyPenalty > 0
          ? [s.replyPromisesMissed ? `${plural(s.replyPromisesMissed, "reply promise")} to the client missed` : null, s.replyTargetsMissed ? `${plural(s.replyTargetsMissed, "internal reply target")} missed` : null]
              .filter(Boolean)
              .join("; ") + " in the last 30 days"
          : null,
    },
    {
      key: "overdueFirmTasks",
      weight: w.overdueFirmTasks,
      score: taskScore,
      reason: s.overdueFirmTasks > 0 ? `${plural(s.overdueFirmTasks, "firm task")} overdue${s.overdueCriticalFirmTasks ? ` (${s.overdueCriticalFirmTasks} tied to a court deadline)` : ""}` : null,
    },
    { key: "stalls", weight: w.stalls, score: clamp(100 - s.openStalls * 40), reason: s.openStalls > 0 ? `${plural(s.openStalls, "workflow step")} stalled` : null },
    {
      key: "sinceLastUpdate",
      weight: w.sinceLastUpdate,
      score: silenceScore(s.businessDaysSinceUpdate),
      reason: s.businessDaysSinceUpdate > 5 ? `last update to client ${Math.floor(s.businessDaysSinceUpdate)} business days ago` : null,
    },
  ];
}

export function clientComponents(s: HealthSignals, w: HealthSettings["weights"]["client"]): Component[] {
  const opt = (n: number | null, per: number) => (n === null ? null : clamp(100 - n * per));
  return [
    { key: "clientReplies", weight: w.clientReplies, score: clamp(100 - s.openNonResponses * 35), reason: s.openNonResponses > 0 ? `${plural(s.openNonResponses, "message")} to the client unanswered past the response window` : null },
    { key: "overdueClientTasks", weight: w.overdueClientTasks, score: clamp(100 - s.overdueClientTasks * 25), reason: s.overdueClientTasks > 0 ? `${plural(s.overdueClientTasks, "client task")} past due` : null },
    { key: "missingDocuments", weight: w.missingDocuments, score: opt(s.missingDocuments, 30), reason: s.missingDocuments ? `${plural(s.missingDocuments, "document request")} outstanding` : null },
    { key: "signOffs", weight: w.signOffs, score: opt(s.delayedSignOffs, 40), reason: s.delayedSignOffs ? `${plural(s.delayedSignOffs, "sign-off")} delayed` : null },
    { key: "retainer", weight: w.retainer, score: opt(s.retainerIssues, 50), reason: s.retainerIssues ? `${plural(s.retainerIssues, "retainer or installment issue")}` : null },
    {
      key: "sinceClientActivity",
      weight: w.sinceClientActivity,
      score: s.businessDaysSinceClientActivity === null ? null : silenceScore(s.businessDaysSinceClientActivity),
      reason: s.businessDaysSinceClientActivity !== null && s.businessDaysSinceClientActivity > 5 ? `client hasn't replied in ${Math.floor(s.businessDaysSinceClientActivity)} business days` : null,
    },
  ];
}

/** Weighted average over MEASURED components (weights redistributed); null when nothing is measured. */
export function subscore(components: readonly Component[]): number | null {
  const measured = components.filter((c) => c.score !== null && c.weight > 0);
  const total = measured.reduce((a, c) => a + c.weight, 0);
  if (total === 0) return null;
  return clamp(measured.reduce((a, c) => a + (c.score as number) * c.weight, 0) / total);
}

/** Top reasons: components that cost the most weighted points first. */
export function topReasons(components: readonly Component[], n = 3): string[] {
  return components
    .filter((c) => c.reason && c.score !== null && c.score < 100)
    .sort((a, b) => (100 - (b.score as number)) * b.weight - (100 - (a.score as number)) * a.weight)
    .slice(0, n)
    .map((c) => c.reason as string);
}

export function bandFor(score: number | null, h: Pick<HealthSettings, "greenAt" | "amberAt">): Band {
  if (score === null) return "insufficient_data";
  if (score >= h.greenAt) return "green";
  if (score >= h.amberAt) return "amber";
  return "red";
}

export function computeHealth(signals: HealthSignals, h: HealthSettings, opts: { newMatter: boolean }): HealthResult {
  const firm = firmComponents(signals, h.weights.firm);
  const client = clientComponents(signals, h.weights.client);
  const notMeasured = [...firm, ...client].filter((c) => c.score === null).map((c) => c.key);
  if (opts.newMatter) {
    return { score: null, firmSubscore: null, clientSubscore: null, band: "insufficient_data", firmReasons: ["not enough history yet (new matter)"], clientReasons: [], notMeasured };
  }
  const f = subscore(firm);
  const c = subscore(client);
  const score = f === null ? c : c === null ? f : Math.min(f, c);
  return { score, firmSubscore: f, clientSubscore: c, band: bandFor(score, h), firmReasons: topReasons(firm), clientReasons: topReasons(client), notMeasured };
}

/** "Falling sharply": a drop of at least `trendDropPoints` against any snapshot inside the trend window. */
export function fallingSharply(score: number | null, recentScores: ReadonlyArray<number | null>, h: Pick<HealthSettings, "trendDropPoints">): boolean {
  if (score === null) return false;
  const best = Math.max(...recentScores.filter((s): s is number => s !== null), -Infinity);
  return Number.isFinite(best) && best - score >= h.trendDropPoints;
}

/** Ordering only (never the score): (100 − score) × multiplier, multiplier when a confirmed deadline is near. */
export function rankValue(score: number | null, deadlineNear: boolean, h: Pick<HealthSettings, "deadlineMultiplierPct">): { multiplierPct: number; rank: number } {
  const multiplierPct = deadlineNear ? h.deadlineMultiplierPct : 100;
  return { multiplierPct, rank: score === null ? 0 : Math.round(((100 - score) * multiplierPct) / 100) };
}

/**
 * Raise an internal health flag? Only on a TRANSITION to unhealthy (red or
 * falling sharply), never while one is open, never before an acknowledged
 * check-back date, and — after an earlier flag — only once the matter has
 * been healthy for the quiet period (c53 §4.9–4.10).
 */
export function shouldRaiseHealthFlag(input: {
  unhealthy: boolean;
  openFlag: boolean;
  checkBackAt: Date | null;
  everFlagged: boolean;
  /** Business days the matter was continuously NOT unhealthy just before now (0 if the previous snapshot was unhealthy). */
  healthyRunBusinessDays: number;
  quietBusinessDays: number;
  now: Date;
}): boolean {
  if (!input.unhealthy || input.openFlag) return false;
  if (input.checkBackAt && input.now.getTime() < input.checkBackAt.getTime()) return false;
  if (!input.everFlagged) return true;
  return input.healthyRunBusinessDays >= input.quietBusinessDays;
}
