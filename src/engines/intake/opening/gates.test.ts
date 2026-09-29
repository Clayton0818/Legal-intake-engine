import { describe, it, expect } from "vitest";
import {
  computeGatePanel,
  initialHandoffStatus,
  parseFeeArrangement,
  partiesNeedRecheck,
  paymentRequired,
  setupIncomplete,
  shouldRunHandoff,
  type GateEvidence,
} from "./gates";

const at = (m: number) => new Date(Date.UTC(2026, 9, 1, 12, m));
const signed: GateEvidence = { gate: "engagement_signed", status: "met", evidenceRef: "document:1", details: {}, recordedAt: at(1) };
const retainer: GateEvidence = { gate: "fee_arrangement", status: "met", evidenceRef: "signed_agreement", details: { feeType: "retainer", amountCents: 450000 }, recordedAt: at(2) };
const fixedNoUpfront: GateEvidence = { gate: "fee_arrangement", status: "met", evidenceRef: "signed_agreement", details: { feeType: "fixed_fee", amountCents: 250000, upfrontCents: 0 }, recordedAt: at(2) };
const settled: GateEvidence = { gate: "first_payment", status: "met", evidenceRef: "payment:ch_1", details: { kind: "processor_settled", amountCents: 450000 }, recordedAt: at(3) };
const base = { conflict: "clear" as const, conflictRecheckNeeded: false, retainerFloorCents: 450000 };

describe("c68 gate panel", () => {
  it("all gates met → can open", () => {
    const p = computeGatePanel({ ...base, evidence: [signed, retainer, settled] });
    expect(p.canOpen).toBe(true);
    expect(p.items.map((i) => i.status)).toEqual(["met", "met", "met", "met"]);
  });

  it("a pending conflict decision blocks and names the owner (acceptance 1)", () => {
    const p = computeGatePanel({ ...base, conflict: "possible_pending", evidence: [signed, retainer, settled] });
    expect(p.canOpen).toBe(false);
    expect(p.outstanding[0]).toMatchObject({ gate: "conflict_cleared", owner: "conflicts_attorney", message: "Conflict decision pending - owner: conflicts attorney." });
  });

  it("a party added since the last check blocks until re-checked", () => {
    expect(computeGatePanel({ ...base, conflictRecheckNeeded: true, evidence: [signed, retainer, settled] }).outstanding[0]?.message).toMatch(/re-check/);
  });

  it("fixed fee with no upfront payment: payment not applicable (acceptance 7)", () => {
    const p = computeGatePanel({ ...base, evidence: [signed, fixedNoUpfront] });
    expect(p.items.find((i) => i.gate === "first_payment")?.status).toBe("not_applicable");
    expect(p.canOpen).toBe(true);
  });

  it("retainer matters wait for the deposit; a staff attestation counts (acceptance 6)", () => {
    expect(computeGatePanel({ ...base, evidence: [signed, retainer] }).outstanding.map((o) => o.gate)).toEqual(["first_payment"]);
    const attested: GateEvidence = { ...settled, evidenceRef: "attestation", details: { kind: "staff_attestation", amountCents: 450000 } };
    expect(computeGatePanel({ ...base, evidence: [signed, retainer, attested] }).canOpen).toBe(true);
    const bogus: GateEvidence = { ...settled, details: { kind: "pending_ach" } };
    expect(computeGatePanel({ ...base, evidence: [signed, retainer, bogus] }).canOpen).toBe(false);
  });

  it("a retainer below the $4,500 floor warns but never blocks (open question)", () => {
    const low: GateEvidence = { ...retainer, details: { feeType: "retainer", amountCents: 300000 } };
    const p = computeGatePanel({ ...base, evidence: [signed, low, settled] });
    expect(p.canOpen).toBe(true);
    expect(p.warnings[0]).toMatch(/\$4500\.00/);
  });

  it("the newest evidence per gate wins", () => {
    const unsigned: GateEvidence = { ...signed, status: "missing", recordedAt: at(9) };
    expect(computeGatePanel({ ...base, evidence: [signed, unsigned, retainer, settled] }).canOpen).toBe(false);
  });
});

describe("c68 fee arrangements", () => {
  it("fixed fee or retainer only, positive amounts", () => {
    expect(parseFeeArrangement({ feeType: "hourly", amountCents: 1 }).ok).toBe(false);
    expect(parseFeeArrangement({ feeType: "retainer", amountCents: -5 }).ok).toBe(false);
    expect(parseFeeArrangement({ feeType: "fixed_fee", amountCents: 100, upfrontCents: 200 }).ok).toBe(false);
    const ok = parseFeeArrangement({ feeType: "fixed_fee", amountCents: 100000, upfrontCents: 50000 });
    expect(ok.ok && paymentRequired(ok.value)).toBe(true);
    expect(paymentRequired({ feeType: "retainer", amountCents: 1 })).toBe(true);
  });
});

describe("c68 conflict re-check at open", () => {
  it("only parties added after the check and not covered by it need a re-check", () => {
    const checkedAt = at(10);
    expect(partiesNeedRecheck([{ normalizedName: "ana lopez", addedAt: at(20) }], ["ana lopez", "bo lopez"], checkedAt)).toBe(false);
    expect(partiesNeedRecheck([{ normalizedName: "new partner", addedAt: at(20) }], ["ana lopez"], checkedAt)).toBe(true);
    expect(partiesNeedRecheck([{ normalizedName: "new partner", addedAt: at(5) }], ["ana lopez"], checkedAt)).toBe(false);
    expect(partiesNeedRecheck([], [], null)).toBe(true);
  });
});

describe("c68 hand-offs", () => {
  it("trust ledger only for retainer matters; retries capped at three", () => {
    expect(initialHandoffStatus("trust_ledger", { feeType: "fixed_fee", amountCents: 1 })).toBe("not_applicable");
    expect(initialHandoffStatus("trust_ledger", { feeType: "retainer", amountCents: 1 })).toBe("pending");
    expect(shouldRunHandoff({ status: "failed", attempts: 2 })).toBe(true);
    expect(shouldRunHandoff({ status: "failed", attempts: 3 })).toBe(false);
    expect(shouldRunHandoff({ status: "done", attempts: 1 })).toBe(false);
  });

  it("failed or blocked items show as 'Setup incomplete' (acceptance 5)", () => {
    expect(setupIncomplete([{ item: "portal_invite", status: "failed" }, { item: "team", status: "done" }, { item: "trust_ledger", status: "blocked_pending_approval" }])).toEqual([
      "Setup incomplete: Portal invitation (c11)",
      "Setup incomplete: Trust ledger and retainer floor (c50) (waiting for review sign-off)",
    ]);
  });
});
