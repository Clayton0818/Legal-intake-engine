// c68 — turn a prospect into an open matter (pure rules).
//
// A matter opens only when every applicable gate is met: conflict cleared,
// engagement agreement signed (and countersigned), fee arrangement set, and
// the first payment received where the fee type needs one. There is no
// override. Only an attorney can open. The list of gates itself is legal-rule
// logic, so the open action also waits for 'rules.intake.matter_open_gates'.

import type { ConflictState } from "../adapters/conflictStatus";

export const OPEN_GATES = ["conflict_cleared", "engagement_signed", "fee_arrangement", "first_payment"] as const;
export type OpenGate = (typeof OPEN_GATES)[number];
export type GateStatus = "met" | "missing" | "not_applicable";

export type FeeType = "fixed_fee" | "retainer";
export const FEE_TYPES: readonly FeeType[] = ["fixed_fee", "retainer"];

export interface FeeArrangement {
  feeType: FeeType;
  /** Total fixed fee, or the retainer deposit the agreement asks for. */
  amountCents: number;
  /** Fixed-fee matters: amount due before work starts (0 = none). */
  upfrontCents?: number;
}

/** Evidence recorded for a gate (the newest non-superseded row per gate). */
export interface GateEvidence {
  gate: "engagement_signed" | "fee_arrangement" | "first_payment";
  status: GateStatus;
  evidenceRef: string | null;
  details: Record<string, unknown>;
  recordedAt: Date;
}

export interface GatePanelItem {
  gate: OpenGate;
  status: GateStatus;
  owner: "conflicts_attorney" | "responsible_lawyer" | "client" | "billing_admin";
  /** What is outstanding, in words staff can act on. Internal only. */
  message: string;
  evidenceRef: string | null;
}

export interface GatePanel {
  items: GatePanelItem[];
  canOpen: boolean;
  outstanding: GatePanelItem[];
  warnings: string[];
}

/** Payment evidence kinds that count as "received" (c68 rule 5–6). */
export const PAYMENT_EVIDENCE_KINDS = ["processor_settled", "staff_attestation"] as const;
export type PaymentEvidenceKind = (typeof PAYMENT_EVIDENCE_KINDS)[number];

/** Pure: parse and validate a fee arrangement. */
export function parseFeeArrangement(details: Record<string, unknown>): { ok: true; value: FeeArrangement } | { ok: false; error: string } {
  const feeType = details.feeType;
  if (feeType !== "fixed_fee" && feeType !== "retainer") return { ok: false, error: "feeType must be 'fixed_fee' or 'retainer' (the firm's matters are fixed-fee or retainer)." };
  const amount = Number(details.amountCents);
  if (!Number.isInteger(amount) || amount <= 0) return { ok: false, error: "amountCents must be a positive whole number of cents." };
  const upfront = details.upfrontCents === undefined ? 0 : Number(details.upfrontCents);
  if (!Number.isInteger(upfront) || upfront < 0 || upfront > amount) return { ok: false, error: "upfrontCents must be between 0 and the amount." };
  return { ok: true, value: { feeType, amountCents: amount, upfrontCents: feeType === "fixed_fee" ? upfront : undefined } };
}

/** Does this fee arrangement need a first payment before opening? Pure. */
export function paymentRequired(fee: FeeArrangement): boolean {
  if (fee.feeType === "retainer") return true;
  return (fee.upfrontCents ?? 0) > 0;
}

/** Pure: newest non-superseded evidence per gate. */
export function latestEvidence(rows: readonly GateEvidence[]): Partial<Record<GateEvidence["gate"], GateEvidence>> {
  const out: Partial<Record<GateEvidence["gate"], GateEvidence>> = {};
  for (const r of [...rows].sort((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime())) out[r.gate] = r;
  return out;
}

/**
 * Build the gate panel (always visible on a prospective matter, c68 §4).
 * `conflictRecheckNeeded`: a party was added after the last clear result.
 */
export function computeGatePanel(args: {
  conflict: ConflictState;
  conflictRecheckNeeded: boolean;
  evidence: readonly GateEvidence[];
  retainerFloorCents: number;
  now?: Date;
}): GatePanel {
  const ev = latestEvidence(args.evidence);
  const items: GatePanelItem[] = [];
  const warnings: string[] = [];

  // Conflict
  let conflictItem: GatePanelItem;
  if ((args.conflict === "clear" || args.conflict === "attorney_cleared") && !args.conflictRecheckNeeded) {
    conflictItem = { gate: "conflict_cleared", status: "met", owner: "conflicts_attorney", message: "Conflict check cleared.", evidenceRef: null };
  } else if (args.conflictRecheckNeeded && (args.conflict === "clear" || args.conflict === "attorney_cleared")) {
    conflictItem = { gate: "conflict_cleared", status: "missing", owner: "conflicts_attorney", message: "A party was added after the last conflict check — re-check pending.", evidenceRef: null };
  } else if (args.conflict === "possible_pending") {
    conflictItem = { gate: "conflict_cleared", status: "missing", owner: "conflicts_attorney", message: "Conflict decision pending - owner: conflicts attorney.", evidenceRef: null };
  } else if (args.conflict === "none") {
    conflictItem = { gate: "conflict_cleared", status: "missing", owner: "conflicts_attorney", message: "No conflict check has run yet.", evidenceRef: null };
  } else {
    conflictItem = { gate: "conflict_cleared", status: "missing", owner: "conflicts_attorney", message: "A conflict prevents this matter from opening.", evidenceRef: null };
  }
  items.push(conflictItem);

  // Engagement agreement (signed by the client and countersigned by the firm)
  const eng = ev.engagement_signed;
  items.push(
    eng?.status === "met"
      ? { gate: "engagement_signed", status: "met", owner: "responsible_lawyer", message: "Engagement agreement signed and countersigned.", evidenceRef: eng.evidenceRef }
      : { gate: "engagement_signed", status: "missing", owner: "client", message: "Waiting for the signed engagement agreement (client signature and firm countersignature).", evidenceRef: null }
  );

  // Fee arrangement
  const feeEv = ev.fee_arrangement;
  const fee = feeEv?.status === "met" ? parseFeeArrangement(feeEv.details) : null;
  items.push(
    fee?.ok
      ? { gate: "fee_arrangement", status: "met", owner: "responsible_lawyer", message: `Fee arrangement set (${fee.value.feeType.replace("_", " ")}).`, evidenceRef: feeEv!.evidenceRef }
      : { gate: "fee_arrangement", status: "missing", owner: "responsible_lawyer", message: "Set the fee arrangement (fixed fee or retainer) from the signed agreement.", evidenceRef: null }
  );

  // First payment
  if (!fee?.ok) {
    items.push({ gate: "first_payment", status: "missing", owner: "responsible_lawyer", message: "Depends on the fee arrangement.", evidenceRef: null });
  } else if (!paymentRequired(fee.value)) {
    items.push({ gate: "first_payment", status: "not_applicable", owner: "billing_admin", message: "No upfront payment in this fee schedule.", evidenceRef: null });
  } else {
    const pay = ev.first_payment;
    const kind = pay?.details.kind;
    const received = pay?.status === "met" && (PAYMENT_EVIDENCE_KINDS as readonly unknown[]).includes(kind);
    items.push(
      received
        ? { gate: "first_payment", status: "met", owner: "billing_admin", message: kind === "staff_attestation" ? "Deposit attested by staff (made outside the product)." : "Payment settled.", evidenceRef: pay!.evidenceRef }
        : { gate: "first_payment", status: "missing", owner: "client", message: fee.value.feeType === "retainer" ? "Waiting for the retainer deposit." : "Waiting for the upfront payment.", evidenceRef: null }
    );
    if (fee.value.feeType === "retainer" && fee.value.amountCents < args.retainerFloorCents) {
      // Whether the first deposit must reach the floor is an open founder/CPA question: warn, never block.
      warnings.push(`The retainer in the agreement is below the firm's floor of $${(args.retainerFloorCents / 100).toFixed(2)}.`);
    }
  }

  const outstanding = items.filter((i) => i.status === "missing");
  return { items, canOpen: outstanding.length === 0, outstanding, warnings };
}

/**
 * Do the matter's parties need a conflict re-check before opening (c68 rule 4)?
 * A party added after the last result needs one unless it is a name the check
 * already covered (the caller and the other parties given at intake). Pure.
 */
export function partiesNeedRecheck(
  parties: ReadonlyArray<{ normalizedName: string; addedAt: Date }>,
  checkedNames: readonly string[],
  checkedAt: Date | null
): boolean {
  if (!checkedAt) return true;
  const covered = new Set(checkedNames.map((n) => n.trim().toLowerCase()).filter(Boolean));
  return parties.some((p) => p.addedAt.getTime() > checkedAt.getTime() && !covered.has(p.normalizedName.trim().toLowerCase()));
}

// ---------------------------------------------------------------------------
// Hand-offs to the other engines (c68 §4 Open 4)
// ---------------------------------------------------------------------------

export const HANDOFF_ITEMS = [
  "party_index",
  "document_checklist",
  "trust_ledger",
  "fee_schedule",
  "client_updates",
  "health_meter",
  "portal_invite",
  "team",
] as const;
export type HandoffItem = (typeof HANDOFF_ITEMS)[number];

export const HANDOFF_LABELS: Readonly<Record<HandoffItem, string>> = {
  party_index: "Parties added to the party index (c56)",
  document_checklist: "Document checklist started (c49)",
  trust_ledger: "Trust ledger and retainer floor (c50)",
  fee_schedule: "Fee and pay schedule (c52)",
  client_updates: "Client update rhythm started (c54)",
  health_meter: "Health meter started (c53)",
  portal_invite: "Portal invitation (c11)",
  team: "Team assignment confirmed (c48)",
};

export const MAX_HANDOFF_ATTEMPTS = 3;

/** Initial status of each hand-off for this fee type. Pure. */
export function initialHandoffStatus(item: HandoffItem, fee: FeeArrangement): "pending" | "not_applicable" {
  if (item === "trust_ledger" && fee.feeType !== "retainer") return "not_applicable";
  return "pending";
}

/** Should the worker (re)try this hand-off? Pure. */
export function shouldRunHandoff(h: { status: string; attempts: number }): boolean {
  return (h.status === "pending" || h.status === "failed") && h.attempts < MAX_HANDOFF_ATTEMPTS;
}

/** "Setup incomplete: …" lines for the matter page. Pure. */
export function setupIncomplete(handoffs: ReadonlyArray<{ item: string; status: string }>): string[] {
  return handoffs
    .filter((h) => h.status === "failed" || h.status === "blocked_pending_approval")
    .map((h) => `Setup incomplete: ${HANDOFF_LABELS[h.item as HandoffItem] ?? h.item}${h.status === "blocked_pending_approval" ? " (waiting for review sign-off)" : ""}`);
}
