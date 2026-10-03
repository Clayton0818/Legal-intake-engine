// Document retention (c84 foundation for c90). Retention periods are legal /
// policy rules: the product ships NO values. The firm enters its own periods
// (document_retention_rules, with the basis it relied on); APPLYING them —
// proposing when a closed matter's documents become eligible for a
// destruction review — runs only through the shared rules.retention_periods
// gate. Nothing here ever deletes anything: c90 adds the destruction review,
// and only a lawyer can approve destruction.

import { requireApproval } from "@/compliance/approvals";
import { RULE_GATES } from "@/compliance/gates";

export const RETENTION_GATE = RULE_GATES.retentionPeriods.key;

export interface RetentionRule {
  id: string;
  practiceArea: string | null;
  documentType: string | null;
  retainYearsAfterClose: number;
  basis: string;
}

export interface NewRetentionRule {
  practiceArea: string | null;
  documentType: string | null;
  retainYearsAfterClose: number;
  basis: string;
}

/** Problems with a firm-entered rule (empty = OK). Pure. */
export function validateRetentionRule(r: NewRetentionRule): string[] {
  const errors: string[] = [];
  if (!Number.isInteger(r.retainYearsAfterClose) || r.retainYearsAfterClose < 0 || r.retainYearsAfterClose > 100) {
    errors.push("Retention must be a whole number of years between 0 and 100.");
  }
  if (!r.basis?.trim()) errors.push("Record the basis for this period (firm policy, ethics opinion, insurer requirement …).");
  if (r.documentType !== null && !/^[a-z0-9_.-]{1,64}$/.test(r.documentType)) errors.push("Document type must be a short lowercase code.");
  return errors;
}

/**
 * The most specific live rule for a document: practice area + type, then
 * type only, then practice area only, then the firm-wide rule. Pure.
 */
export function resolveRetentionRule(
  rules: readonly RetentionRule[],
  doc: { practiceArea: string | null; documentType: string }
): RetentionRule | null {
  const tiers: ((r: RetentionRule) => boolean)[] = [
    (r) => r.practiceArea !== null && r.practiceArea === doc.practiceArea && r.documentType === doc.documentType,
    (r) => r.practiceArea === null && r.documentType === doc.documentType,
    (r) => r.practiceArea !== null && r.practiceArea === doc.practiceArea && r.documentType === null,
    (r) => r.practiceArea === null && r.documentType === null,
  ];
  for (const tier of tiers) {
    const hit = rules.find(tier);
    if (hit) return hit;
  }
  return null;
}

export type RetentionProposal =
  | { state: "matter_open" }
  | { state: "no_rule" }
  | { state: "legal_hold"; reason: string }
  | { state: "eligible_for_review_at"; at: Date; ruleId: string; years: number; basis: string };

/** Add whole calendar years in UTC (Feb 29 → Feb 28 in non-leap years). Pure. */
export function addYearsUtc(d: Date, years: number): Date {
  const out = new Date(d.getTime());
  const month = out.getUTCMonth();
  out.setUTCFullYear(out.getUTCFullYear() + years);
  if (out.getUTCMonth() !== month) out.setUTCDate(0);
  return out;
}

/**
 * Pure computation, NOT gated — callers must go through proposeRetention()
 * below. A legal hold always wins; an open matter has no clock yet.
 */
export function computeRetention(input: {
  matterClosedAt: Date | null;
  legalHold: boolean;
  legalHoldReason: string | null;
  rule: RetentionRule | null;
}): RetentionProposal {
  if (input.legalHold) return { state: "legal_hold", reason: input.legalHoldReason ?? "Legal hold" };
  if (!input.matterClosedAt) return { state: "matter_open" };
  if (!input.rule) return { state: "no_rule" };
  return {
    state: "eligible_for_review_at",
    at: addYearsUtc(input.matterClosedAt, input.rule.retainYearsAfterClose),
    ruleId: input.rule.id,
    years: input.rule.retainYearsAfterClose,
    basis: input.rule.basis,
  };
}

/**
 * The gated entry point: applying a retention period is a legal-rule action.
 * Throws PendingApprovalError (logged) until rules.retention_periods is approved.
 * The date is a PROPOSAL for a lawyer's destruction review, never an automatic deletion.
 */
export function proposeRetention(
  tenantId: string,
  input: Omit<Parameters<typeof computeRetention>[0], "rule"> & { practiceArea: string | null; documentType: string; rules: readonly RetentionRule[] }
): RetentionProposal {
  requireApproval(RETENTION_GATE, { action: "document.retention.propose", tenantId });
  const rule = resolveRetentionRule(input.rules, { practiceArea: input.practiceArea, documentType: input.documentType });
  return computeRetention({ ...input, rule });
}
