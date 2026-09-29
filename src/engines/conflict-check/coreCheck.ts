// c3 — the core check: clear / possible / definite, role-sensitive. Pure.
//
// Interface: `conflict_rules` in docs/product/spec/intake-flow.yaml, with
// parameters `conflict_sources` and `role_matrix` from
// docs/product/spec/firm-config.example.yaml. The caller AND the opposing
// party are screened against client records, matter records and
// prior-consultation records; a prior consultation counts even when no
// engagement followed. Matches are evaluated against the ROLE BEING SOUGHT:
// a prior meeting that is harmless for representation can bar the firm from
// mediating between the same people.
//
// Three states, never a boolean:
//   clear    → intake proceeds (the conflict gate still has to be open);
//   possible → intake pauses, the caller hears that research is needed, an
//              attorney decides (the engine never resolves it);
//   definite → intake stops, scheduling is blocked, a neutral referral.
//
// LEGAL-RULE LOGIC IS GATED. The role matrix is firm configuration, but only
// an APPLIED evaluation — i.e. once the shared gate `rules.conflicts` is
// approved — can turn a result into 'definite'. Until then every hit is
// 'possible' and goes to the conflicts attorney. Nothing here clears anything.

import type { ConflictHit, ConflictOutcome, Involvement } from "./types";

export const CONFLICT_SOURCES = ["clients", "matters", "prior_consultations"] as const;
export type ConflictSource = (typeof CONFLICT_SOURCES)[number];

export const BARRING_CONDITIONS = [
  "prior_representation_of_opposing_party",
  "prior_consultation_with_opposing_party",
  "prior_initial_meeting_with_either_party",
  "prior_representation_of_either_party",
  "prior_consultation_with_either_party",
] as const;
export type BarringCondition = (typeof BARRING_CONDITIONS)[number];

export type RoleMatrix = Record<string, { barred_by: BarringCondition[] }>;

/** The spec's example matrix (firm-config.example.yaml). A firm setting, applied only under `rules.conflicts`. */
export const DEFAULT_ROLE_MATRIX: Readonly<RoleMatrix> = Object.freeze({
  representation: { barred_by: ["prior_representation_of_opposing_party", "prior_consultation_with_opposing_party"] },
  mediation: {
    barred_by: ["prior_initial_meeting_with_either_party", "prior_representation_of_either_party", "prior_consultation_with_either_party"],
  },
});

export const DEFAULT_CONFLICT_SOURCES: readonly ConflictSource[] = Object.freeze(["clients", "matters", "prior_consultations"]);

/** Which side of the NEW matter a searched name is on. */
export type Side = "caller" | "opposing" | "other";

const CALLER_ROLES = new Set(["caller", "prospective_client", "client", "co_party"]);
const OPPOSING_ROLES = new Set(["opposing_party", "co_defendant", "insurer", "respondent"]);

export function sideOf(searchedRole: string): Side {
  if (CALLER_ROLES.has(searchedRole)) return "caller";
  if (OPPOSING_ROLES.has(searchedRole)) return "opposing";
  return "other";
}

/** Map what intake says the caller wants onto a role-matrix key. Unknown roles are evaluated against EVERY row (over-flag). Pure. */
export function resolveRoleSought(roleSought: string | null | undefined, matrix: RoleMatrix): { key: string | null; known: boolean } {
  const raw = (roleSought ?? "").trim().toLowerCase();
  const aliases: Record<string, string> = {
    "": "representation",
    representation: "representation",
    represent: "representation",
    petitioner: "representation",
    respondent: "representation",
    client: "representation",
    mediation: "mediation",
    mediator: "mediation",
    mediate: "mediation",
  };
  const key = matrix[raw] ? raw : aliases[raw];
  if (key && matrix[key]) return { key, known: true };
  return { key: null, known: false };
}

const REPRESENTATION_ROLES = new Set(["client", "former_client", "caller", "co_party"]);

/** What kind of prior contact an involvement is, restricted to the firm's conflict sources. Pure. */
export function contactKinds(inv: Involvement, sources: readonly ConflictSource[]): Array<"representation" | "consultation"> {
  const out: Array<"representation" | "consultation"> = [];
  const useClients = sources.includes("clients");
  const useMatters = sources.includes("matters");
  const useConsults = sources.includes("prior_consultations");
  if (inv.kind === "matter" && inv.status !== "prospective" && REPRESENTATION_ROLES.has(inv.role) && (useClients || useMatters)) {
    out.push("representation");
  }
  const consult =
    (inv.kind === "inquiry" && (inv.role === "prospective_client" || inv.role === "client")) ||
    (inv.kind === "matter" && inv.status === "prospective" && (inv.role === "client" || inv.role === "prospective_client"));
  if (consult && useConsults) out.push("consultation");
  return out;
}

/** Barring conditions one involvement meets for a searched name on `side`. Pure. */
export function conditionsFor(side: Side, inv: Involvement, sources: readonly ConflictSource[]): BarringCondition[] {
  if (side === "other") return [];
  const kinds = contactKinds(inv, sources);
  const out: BarringCondition[] = [];
  if (kinds.includes("representation")) {
    out.push("prior_representation_of_either_party");
    if (side === "opposing") out.push("prior_representation_of_opposing_party");
  }
  if (kinds.includes("consultation")) {
    // A consultation is always an initial meeting too.
    out.push("prior_consultation_with_either_party", "prior_initial_meeting_with_either_party");
    if (side === "opposing") out.push("prior_consultation_with_opposing_party");
  }
  return out;
}

export interface RoleFinding {
  hitIndex: number;
  searchedName: string;
  searchedRole: string;
  side: Side;
  displayName: string;
  condition: BarringCondition;
  involvementIds: string[];
  strength: number;
  /** Strong enough (≥ definiteMinStrength) for the finding to make the check 'definite'. */
  strongEnough: boolean;
}

export interface RoleEvaluation {
  roleSought: string | null;
  roleKnown: boolean;
  /** The barring conditions evaluated (the role's row, or every row when the role is unknown). */
  evaluated: BarringCondition[];
  findings: RoleFinding[];
  /** True when a strong finding meets a barring condition for the role sought. */
  barred: boolean;
  /** True only when the evaluation was allowed to decide 'definite' (rules.conflicts approved). */
  applied: boolean;
}

export interface EvaluateRoleInput {
  hits: readonly ConflictHit[];
  roleSought?: string | null;
  matrix?: RoleMatrix;
  sources?: readonly ConflictSource[];
  /** Only near-certain identity matches may make a check definite (default 0.9). */
  definiteMinStrength?: number;
  applied: boolean;
}

/** Evaluate hits against the role matrix (c3). Pure; never drops a hit. */
export function evaluateRoleMatrix(input: EvaluateRoleInput): RoleEvaluation {
  const matrix = input.matrix ?? DEFAULT_ROLE_MATRIX;
  const sources = input.sources ?? DEFAULT_CONFLICT_SOURCES;
  const min = input.definiteMinStrength ?? 0.9;
  const role = resolveRoleSought(input.roleSought, matrix);
  const evaluated = role.key
    ? [...matrix[role.key]!.barred_by]
    : [...new Set(Object.values(matrix).flatMap((r) => r.barred_by))];

  const findings: RoleFinding[] = [];
  input.hits.forEach((hit, hitIndex) => {
    // Lateral lists and lawyer interests are c61/c97 situations, decided by the rule table, not the matrix.
    if (hit.sourceType !== "party") return;
    const side = sideOf(hit.searchedRole);
    const byCondition = new Map<BarringCondition, string[]>();
    for (const inv of hit.involvements) {
      for (const c of conditionsFor(side, inv, sources)) {
        if (!evaluated.includes(c)) continue;
        byCondition.set(c, [...(byCondition.get(c) ?? []), inv.id]);
      }
    }
    for (const [condition, ids] of byCondition) {
      findings.push({
        hitIndex,
        searchedName: hit.searchedName,
        searchedRole: hit.searchedRole,
        side,
        displayName: hit.displayName,
        condition,
        involvementIds: [...new Set(ids)],
        strength: hit.strength,
        strongEnough: hit.strength >= min && hit.matchKind !== "org_link",
      });
    }
  });
  return {
    roleSought: role.key,
    roleKnown: role.known,
    evaluated,
    findings,
    barred: findings.some((f) => f.strongEnough),
    applied: input.applied,
  };
}

/** Human-readable label of a barring condition (internal screens only). */
export function conditionLabel(c: BarringCondition): string {
  return {
    prior_representation_of_opposing_party: "The firm represented the other party before",
    prior_consultation_with_opposing_party: "The other party consulted the firm before",
    prior_initial_meeting_with_either_party: "The firm met one of the parties before",
    prior_representation_of_either_party: "The firm represented one of the parties before",
    prior_consultation_with_either_party: "One of the parties consulted the firm before",
  }[c];
}

// ---------------------------------------------------------------------------
// What intake does with the outcome (intake-flow.yaml: conflict_check node)
// ---------------------------------------------------------------------------

export interface IntakeDirective {
  outcome: ConflictOutcome;
  /** intake-flow.yaml node to go to next. */
  next: "practice_area_router" | "escalate_conflict" | "declined_conflict";
  intake: "proceed" | "pause" | "stop";
  /** 'callback_only': a callback slot may be offered while research is done; nothing else is booked. */
  scheduling: "allowed" | "callback_only" | "blocked";
  requiresHuman: boolean;
  /** Approval-gated copy key for what the caller is told (null = nothing extra to say). */
  clientCopyKey: string | null;
  /** Neutral referral route for a definite result (never says why). */
  referral: { destination: string; name?: string; contact?: string } | null;
}

export interface DirectiveOptions {
  pendingCopyKey: string;
  definiteCopyKey: string;
  referral?: { name: string; contact: string } | null;
  /** firm-config: referral destination used after a definite conflict. */
  referralDestination?: string;
}

/** Pure mapping of a check outcome onto the intake flow. */
export function intakeDirective(outcome: ConflictOutcome, opts: DirectiveOptions): IntakeDirective {
  if (outcome === "clear") {
    return { outcome, next: "practice_area_router", intake: "proceed", scheduling: "allowed", requiresHuman: false, clientCopyKey: null, referral: null };
  }
  if (outcome === "possible") {
    return {
      outcome,
      next: "escalate_conflict",
      intake: "pause",
      scheduling: "callback_only",
      requiresHuman: true,
      clientCopyKey: opts.pendingCopyKey,
      referral: null,
    };
  }
  return {
    outcome,
    next: "declined_conflict",
    intake: "stop",
    scheduling: "blocked",
    requiresHuman: true,
    clientCopyKey: opts.definiteCopyKey,
    referral: {
      destination: opts.referralDestination ?? "state_bar_referral_service",
      ...(opts.referral ? { name: opts.referral.name, contact: opts.referral.contact } : {}),
    },
  };
}
