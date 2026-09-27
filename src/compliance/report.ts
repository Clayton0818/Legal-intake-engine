// Pure helpers behind the compliance CLI (./cli.ts) and any admin page that
// shows "what is still waiting for a reviewer". No database imports.

import { gateStatus, getGate, REVIEWER_KINDS, type Gate, type GateStatus, type ReviewerKind } from "./approvals";

/** One line per gate: status, reviewers still pending, cards, description. */
export function formatGateReport(gates: readonly Gate[]): string {
  const statuses: GateStatus[] = gates.map((g) => gateStatus(g.key));
  const pending = statuses.filter((s) => !s.approved);
  const lines: string[] = [
    `${statuses.length} approval gate(s): ${statuses.length - pending.length} approved, ${pending.length} pending.`,
    "",
  ];
  for (const s of statuses) {
    const state = s.approved ? "APPROVED" : `PENDING ${s.pendingReviewers.join(" + ")}`;
    lines.push(`${s.approved ? "[x]" : "[ ]"} ${s.gate.key}  (${state})`);
    lines.push(`      ${s.gate.description}`);
    lines.push(`      cards: ${s.gate.cardIds.join(", ") || "-"}; reviewers: ${s.gate.reviewers.join(", ")}`);
    if (s.gate.draft !== undefined) lines.push(`      draft hash: ${s.gate.draftHash}`);
  }
  return lines.join("\n");
}

export interface ApprovalInsert {
  gateKey: string;
  reviewerKind: ReviewerKind;
  approvedByName: string;
  notes: string | null;
  approvedText: string | null;
  draftHash: string | null;
}

/**
 * Validate a sign-off before it is written to `compliance_approvals`. The
 * current draft's hash is recorded so a later change to the draft
 * automatically re-closes the gate (see approvals.ts approvalCounts()).
 */
export function buildApprovalInsert(args: {
  gateKey: string;
  reviewerKind: string;
  approvedByName: string;
  notes?: string | null;
  approvedText?: string | null;
}): ApprovalInsert {
  const gate = getGate(args.gateKey);
  if (!(REVIEWER_KINDS as readonly string[]).includes(args.reviewerKind)) {
    throw new Error(`Unknown reviewer kind '${args.reviewerKind}'. Use one of: ${REVIEWER_KINDS.join(", ")}.`);
  }
  const reviewerKind = args.reviewerKind as ReviewerKind;
  if (!gate.reviewers.includes(reviewerKind)) {
    throw new Error(`Gate '${gate.key}' does not ask for a '${reviewerKind}' review (it needs: ${gate.reviewers.join(", ")}).`);
  }
  const name = args.approvedByName.trim();
  if (!name) throw new Error("approvedByName is required (the reviewer's real name and credential).");
  const approvedText = args.approvedText?.trim() ? args.approvedText : null;
  return {
    gateKey: gate.key,
    reviewerKind,
    approvedByName: name,
    notes: args.notes?.trim() || null,
    approvedText,
    draftHash: gate.draftHash,
  };
}
