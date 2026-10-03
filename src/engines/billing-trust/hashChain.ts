// Tamper evidence for the trust journal (c75 §11.10: hash-chaining should
// graduate to a hard requirement before the first real transaction).
//
// Each transaction's hash covers its own content, its lines and the previous
// transaction's hash in the same trust account, so editing or deleting any
// historical row (even with a privileged database role that bypasses the
// app's REVOKEs) breaks the chain from that point on. The database enforces
// the LINK (prev_hash must equal the account's last hash, see MIGRATION
// NOTES); recomputing the hashes is done here, by every reconciliation.

import { createHash } from "node:crypto";
import type { Cents } from "./money";

export interface HashableTransaction {
  tenantId: string;
  trustAccountId: string;
  sequence: number;
  kind: string;
  effectiveDate: string;
  netAmount: Cents;
  reason: string;
  memo: string | null;
  counterparty: string | null;
  reference: string | null;
  invoiceId: string | null;
  earnedBasis: string | null;
  fundsSource: string | null;
  reversesTransactionId: string | null;
  postedByUserId: string;
  postedAt: Date;
  prevHash: string | null;
  lines: ReadonlyArray<{ lineNo: number; subledgerId: string; amount: Cents }>;
}

/** Deterministic serialisation: fixed key order, bigints as strings, dates as ISO. */
export function canonicalTransaction(t: HashableTransaction): string {
  const lines = [...t.lines]
    .sort((a, b) => a.lineNo - b.lineNo)
    .map((l) => [l.lineNo, l.subledgerId, l.amount.toString()]);
  return JSON.stringify([
    "billing-trust/v1",
    t.tenantId,
    t.trustAccountId,
    t.sequence,
    t.kind,
    t.effectiveDate,
    t.netAmount.toString(),
    t.reason,
    t.memo,
    t.counterparty,
    t.reference,
    t.invoiceId,
    t.earnedBasis,
    t.fundsSource,
    t.reversesTransactionId,
    t.postedByUserId,
    t.postedAt.toISOString(),
    t.prevHash,
    lines,
  ]);
}

/** JSON with object keys sorted recursively, so a value round-tripped through Postgres jsonb (which reorders keys) hashes the same. */
export function canonicalJson(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .sort()
          .map((k) => [k, norm((v as Record<string, unknown>)[k])])
      );
    }
    return v;
  };
  return JSON.stringify(norm(value));
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function transactionHash(t: HashableTransaction): string {
  return sha256Hex(canonicalTransaction(t));
}

export interface ChainCheck {
  valid: boolean;
  checked: number;
  /** First sequence number where the chain breaks, and why. */
  brokenAt: { sequence: number; problem: "sequence_gap" | "prev_hash_mismatch" | "hash_mismatch" } | null;
}

/** Verify a full account journal, ordered by sequence (1…n). */
export function verifyChain(rows: ReadonlyArray<HashableTransaction & { hash: string }>): ChainCheck {
  const sorted = [...rows].sort((a, b) => a.sequence - b.sequence);
  let prev: string | null = null;
  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i]!;
    if (r.sequence !== i + 1) return { valid: false, checked: i, brokenAt: { sequence: r.sequence, problem: "sequence_gap" } };
    if (r.prevHash !== prev) return { valid: false, checked: i, brokenAt: { sequence: r.sequence, problem: "prev_hash_mismatch" } };
    if (transactionHash(r) !== r.hash) return { valid: false, checked: i, brokenAt: { sequence: r.sequence, problem: "hash_mismatch" } };
    prev = r.hash;
  }
  return { valid: true, checked: sorted.length, brokenAt: null };
}
