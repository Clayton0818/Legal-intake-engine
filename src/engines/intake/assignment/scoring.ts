// c48 — automatic assignment (pure rules).
//
// Step 1: hard eligibility filters (yes/no, with a reason code per exclusion).
// Step 2: rank the eligible by cadence, workload and other factors; each
// factor is normalised to 0–100 across the eligible set, multiplied by the
// firm weight and summed. Deterministic tie-breaks, so a re-run gives the
// same answer. The full breakdown is stored with every assignment.
//
// Assignment is NOT acceptance of representation (c48 rule 8) and never
// runs before a clear conflict result (the service checks that first).

import type { IntakeSettings } from "../settings";

export type ExclusionCode =
  | "not_attorney"
  | "inactive"
  | "restricted_to_unassigned"
  | "screened"
  | "blocked"
  | "no_profile"
  | "not_accepting"
  | "practice_area"
  | "language"
  | "jurisdiction"
  | "out_of_office"
  | "over_weekly_cap"
  | "min_gap";

/** Codes that mean "over capacity this round" rather than "never eligible". */
export const CAPACITY_CODES: readonly ExclusionCode[] = ["over_weekly_cap", "min_gap"];
/** Codes that can never be overridden by a supervisor (c48 rule 2). */
export const NEVER_ASSIGNABLE_CODES: readonly ExclusionCode[] = ["screened", "restricted_to_unassigned", "blocked", "inactive"];

export interface AssignmentMatter {
  practiceArea: string | null;
  /** Practice sub-type / matter type from the confirmed classification (e.g. 'family_custody'). */
  matterType: string | null;
  language: string;
  county: string | null;
}

export interface Candidate {
  userId: string;
  displayName: string;
  role: string;
  status: string;
  restrictedToUnassignedMatters: boolean;
  /** 'screened' | 'restricted' | 'other' block on this matter or its parties. */
  block: "screened" | "restricted" | "other" | null;
  hasProfile: boolean;
  acceptsNewMatters: boolean;
  practiceAreas: string[];
  languages: string[];
  counties: string[];
  seniority: number;
  weeklyCap: number | null;
  outOfOffice: boolean;
  /** Business hours since the last new assignment (null = never assigned). */
  businessHoursSinceLastAssignment: number | null;
  newMattersLast7Days: number;
  /** Open matters weighted by complexity. */
  weightedOpenMatters: number;
  openMatterCount: number;
  openTasks: number;
  overdueTasks: number;
  upcomingDeadlines: number;
  /** An existing/former client's previous lawyer. */
  isContinuityLawyer: boolean;
}

export interface FactorScores {
  cadence: number;
  workload: number;
  other: number;
}

export interface RankedCandidate {
  userId: string;
  displayName: string;
  raw: {
    businessHoursSinceLastAssignment: number | null;
    weightedOpenMatters: number;
    openTasks: number;
    overdueTasks: number;
    upcomingDeadlines: number;
    continuity: boolean;
    seniority: number;
    priorityBonus: number;
  };
  /** Each factor normalised 0–100 across the eligible set. */
  normalized: FactorScores;
  /** normalized × weight / 100. */
  weighted: FactorScores;
  total: number;
}

export interface AssignmentDecision {
  winner: RankedCandidate | null;
  /** 'no_eligible' | 'all_over_capacity' when nobody could be picked. */
  unassignedReason: "no_eligible" | "all_over_capacity" | null;
  ranked: RankedCandidate[];
  excluded: { userId: string; displayName: string; codes: ExclusionCode[] }[];
  weights: FactorScores;
  notes: string[];
}

const norm = (v: string) => v.trim().toLowerCase();

/** Step 1: why a candidate is not eligible (empty = eligible). Pure. */
export function eligibilityCodes(c: Candidate, m: AssignmentMatter, s: IntakeSettings["assignment"]): ExclusionCode[] {
  const codes: ExclusionCode[] = [];
  if (c.role !== "attorney") codes.push("not_attorney");
  if (c.status !== "active") codes.push("inactive");
  if (c.restrictedToUnassignedMatters) codes.push("restricted_to_unassigned");
  if (c.block === "screened") codes.push("screened");
  else if (c.block) codes.push("blocked");
  if (!c.hasProfile) codes.push("no_profile");
  else {
    if (!c.acceptsNewMatters) codes.push("not_accepting");
    const areas = c.practiceAreas.map(norm);
    const area = m.practiceArea === null ? null : norm(m.practiceArea);
    const areaOk =
      area !== null &&
      areas.includes(area) &&
      // A sub-type is required only when the lawyer lists sub-types for that area.
      (m.matterType === null || !areas.some((a) => a.startsWith(`${area}_`)) || areas.includes(norm(m.matterType)));
    if (!areaOk) codes.push("practice_area");
    if (norm(m.language) !== "en" && !c.languages.map(norm).includes(norm(m.language))) codes.push("language");
    if (c.counties.length > 0 && (m.county === null || !c.counties.map(norm).includes(norm(m.county)))) codes.push("jurisdiction");
  }
  if (c.outOfOffice) codes.push("out_of_office");
  const cap = c.weeklyCap ?? s.weeklyNewMatterCap;
  if (c.newMattersLast7Days >= cap) codes.push("over_weekly_cap");
  if (c.businessHoursSinceLastAssignment !== null && c.businessHoursSinceLastAssignment < s.minGapBusinessHours) codes.push("min_gap");
  return codes;
}

/** Normalise values to 0–100 across the set; all-equal → 100 for everyone. Pure. */
export function normalize(values: readonly number[], higherIsBetter: boolean): number[] {
  if (values.length === 0) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return values.map(() => 100);
  return values.map((v) => {
    const pct = ((v - min) / (max - min)) * 100;
    return round2(higherIsBetter ? pct : 100 - pct);
  });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Hours-since value used for "never assigned": beats any real value. */
const NEVER_ASSIGNED_HOURS = 1_000_000;

/** Step 2: rank eligible candidates. Pure. */
export function rankCandidates(eligible: readonly Candidate[], m: AssignmentMatter, s: IntakeSettings["assignment"]): RankedCandidate[] {
  if (eligible.length === 0) return [];
  const weights = s.weights;
  const cadenceRaw = eligible.map((c) => c.businessHoursSinceLastAssignment ?? NEVER_ASSIGNED_HOURS);
  const cadence = normalize(cadenceRaw, true);

  const mix = s.workloadMix;
  const wOpen = normalize(eligible.map((c) => c.weightedOpenMatters), false);
  const wTasks = normalize(eligible.map((c) => c.openTasks), false);
  const wOverdue = normalize(eligible.map((c) => c.overdueTasks), false);
  const wDeadlines = normalize(eligible.map((c) => c.upcomingDeadlines), false);
  const mixTotal = mix.openMatters + mix.openTasks + mix.overdueTasks + mix.upcomingDeadlines || 1;
  const workloadComposite = eligible.map(
    (_, i) =>
      ((wOpen[i] ?? 0) * mix.openMatters +
        (wTasks[i] ?? 0) * mix.openTasks +
        (wOverdue[i] ?? 0) * mix.overdueTasks +
        (wDeadlines[i] ?? 0) * mix.upcomingDeadlines) /
      mixTotal
  );
  const workload = normalize(workloadComposite, true);

  const omix = s.otherMix;
  const preferredSeniority = m.matterType ? s.seniorityFit[m.matterType] : undefined;
  const priorityBonus = (userId: string) =>
    Math.max(
      0,
      ...s.priorities
        .filter((p) => m.matterType !== null && norm(p.matterType) === norm(m.matterType) && p.userIds.includes(userId))
        .map((p) => Math.min(100, Math.max(0, p.bonus)))
    );
  const otherComposite = eligible.map((c) => {
    const continuity = c.isContinuityLawyer ? 100 : 0;
    const seniority = preferredSeniority === undefined ? 100 : Math.max(0, 100 - 25 * Math.abs(c.seniority - preferredSeniority));
    const otherTotal = omix.continuity + omix.seniority + omix.priority || 1;
    return (continuity * omix.continuity + seniority * omix.seniority + priorityBonus(c.userId) * omix.priority) / otherTotal;
  });
  const other = normalize(otherComposite, true);

  const ranked = eligible.map((c, i): RankedCandidate => {
    const normalized = { cadence: cadence[i] ?? 0, workload: workload[i] ?? 0, other: other[i] ?? 0 };
    const weighted = {
      cadence: round2((normalized.cadence * weights.cadence) / 100),
      workload: round2((normalized.workload * weights.workload) / 100),
      other: round2((normalized.other * weights.other) / 100),
    };
    return {
      userId: c.userId,
      displayName: c.displayName,
      raw: {
        businessHoursSinceLastAssignment: c.businessHoursSinceLastAssignment,
        weightedOpenMatters: c.weightedOpenMatters,
        openTasks: c.openTasks,
        overdueTasks: c.overdueTasks,
        upcomingDeadlines: c.upcomingDeadlines,
        continuity: c.isContinuityLawyer,
        seniority: c.seniority,
        priorityBonus: priorityBonus(c.userId),
      },
      normalized,
      weighted,
      total: round2(weighted.cadence + weighted.workload + weighted.other),
    };
  });

  const byId = new Map(eligible.map((c) => [c.userId, c]));
  return ranked.sort((a, b) => {
    if (b.total !== a.total) return b.total - a.total;
    const ca = byId.get(a.userId)!;
    const cb = byId.get(b.userId)!;
    const ha = ca.businessHoursSinceLastAssignment ?? NEVER_ASSIGNED_HOURS;
    const hb = cb.businessHoursSinceLastAssignment ?? NEVER_ASSIGNED_HOURS;
    if (hb !== ha) return hb - ha; // longest since last assignment first
    if (ca.openMatterCount !== cb.openMatterCount) return ca.openMatterCount - cb.openMatterCount;
    return a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0;
  });
}

/** Full decision: filter, rank, pick. Pure. */
export function decideAssignment(candidates: readonly Candidate[], m: AssignmentMatter, s: IntakeSettings["assignment"]): AssignmentDecision {
  const excluded: AssignmentDecision["excluded"] = [];
  const eligible: Candidate[] = [];
  const notes: string[] = [];
  for (const c of candidates) {
    const codes = eligibilityCodes(c, m, s);
    if (codes.length === 0) eligible.push(c);
    else excluded.push({ userId: c.userId, displayName: c.displayName, codes });
  }
  const continuityExcluded = candidates.find((c) => c.isContinuityLawyer && !eligible.includes(c));
  if (continuityExcluded) {
    const codes = excluded.find((e) => e.userId === continuityExcluded.userId)?.codes ?? [];
    notes.push(`Continuity ignored: the client's previous lawyer is not eligible (${codes.join(", ")}).`);
  }
  const ranked = rankCandidates(eligible, m, s);
  let unassignedReason: AssignmentDecision["unassignedReason"] = null;
  if (ranked.length === 0) {
    const onlyCapacity = excluded.some((e) => e.codes.length > 0 && e.codes.every((code) => CAPACITY_CODES.includes(code)));
    unassignedReason = onlyCapacity ? "all_over_capacity" : "no_eligible";
  }
  return { winner: ranked[0] ?? null, unassignedReason, ranked, excluded, weights: { ...s.weights }, notes };
}

/**
 * c48 override: may a supervisor pick this person? Screened / restricted /
 * blocked / inactive users can never be chosen; anyone else outside the
 * eligible list is allowed with a warning. Pure.
 */
export function overrideCheck(
  decision: Pick<AssignmentDecision, "ranked" | "excluded">,
  userId: string
): { allowed: boolean; warning: string | null; reason: string | null } {
  if (decision.ranked.some((r) => r.userId === userId)) return { allowed: true, warning: null, reason: null };
  const ex = decision.excluded.find((e) => e.userId === userId);
  if (!ex) return { allowed: false, warning: null, reason: "That person is not a lawyer at this firm." };
  const hard = ex.codes.filter((c) => NEVER_ASSIGNABLE_CODES.includes(c));
  if (hard.length > 0) return { allowed: false, warning: null, reason: `That person can never be assigned this matter (${hard.join(", ")}).` };
  return { allowed: true, warning: `Outside the eligible list: ${ex.codes.join(", ")}.`, reason: null };
}
