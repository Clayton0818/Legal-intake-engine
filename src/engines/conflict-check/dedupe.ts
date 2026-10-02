// Duplicate detection for the party index (c56 §4.5). Pure.
// Produces SUGGESTIONS only: a person with the conflicts role confirms or
// rejects each one, and the index never auto-merges (c56 rule 4).

import { compareNames, tokens } from "./matching";

export interface DedupeCandidate {
  id: string;
  /** Normalised legal name plus normalised variants. */
  names: readonly string[];
  dateOfBirth?: string | null;
  emails?: readonly string[];
  phones?: readonly string[];
}

export interface DuplicatePair {
  partyAId: string;
  partyBId: string;
  score: number;
  reasons: string[];
}

export function pairKey(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

function digits(v: string): string {
  return v.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
}

/** Score one pair; null when they do not look like the same party. */
export function scorePair(a: DedupeCandidate, b: DedupeCandidate): { score: number; reasons: string[] } | null {
  if (a.id === b.id) return null;
  // Different known dates of birth: different people, whatever the names say.
  if (a.dateOfBirth && b.dateOfBirth && a.dateOfBirth !== b.dateOfBirth) return null;

  const reasons: string[] = [];
  let score = 0;

  let bestName = 0;
  for (const x of a.names) for (const y of b.names) bestName = Math.max(bestName, compareNames(x, y)?.strength ?? 0);

  const emailsA = new Set((a.emails ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean));
  if ((b.emails ?? []).some((e) => emailsA.has(e.trim().toLowerCase()))) {
    reasons.push("Same email address");
    score = Math.max(score, 0.9);
  }
  const phonesA = new Set((a.phones ?? []).map(digits).filter((p) => p.length >= 7));
  if ((b.phones ?? []).some((p) => phonesA.has(digits(p)))) {
    reasons.push("Same phone number");
    score = Math.max(score, 0.8);
  }
  if (a.dateOfBirth && a.dateOfBirth === b.dateOfBirth && bestName >= 0.6) {
    reasons.push("Same date of birth and similar name");
    score = Math.max(score, 0.95);
  }
  if (bestName >= 0.95) {
    reasons.push("Same name");
    score = Math.max(score, 0.7);
  } else if (bestName >= 0.8 && score > 0) {
    reasons.push("Similar name");
  }
  return score > 0 ? { score, reasons } : null;
}

/**
 * Find likely duplicate pairs among candidates. Candidates are bucketed by
 * surname, email and phone so large indexes are not compared all-to-all.
 * Pairs in `skip` (already suggested, rejected, or merged) are left out.
 */
export function findDuplicatePairs(candidates: readonly DedupeCandidate[], skip: ReadonlySet<string> = new Set()): DuplicatePair[] {
  const buckets = new Map<string, DedupeCandidate[]>();
  const put = (key: string, c: DedupeCandidate) => {
    const list = buckets.get(key) ?? [];
    if (!list.includes(c)) list.push(c);
    buckets.set(key, list);
  };
  for (const c of candidates) {
    for (const n of c.names) {
      const last = tokens(n).at(-1);
      if (last && last.length >= 2) put(`s:${last}`, c);
    }
    for (const e of c.emails ?? []) if (e.trim()) put(`e:${e.trim().toLowerCase()}`, c);
    for (const p of c.phones ?? []) if (digits(p).length >= 7) put(`p:${digits(p)}`, c);
  }

  const out = new Map<string, DuplicatePair>();
  for (const list of buckets.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const [aId, bId] = pairKey(list[i]!.id, list[j]!.id);
        const key = `${aId}|${bId}`;
        if (skip.has(key) || out.has(key)) continue;
        const scored = scorePair(list[i]!, list[j]!);
        if (scored) out.set(key, { partyAId: aId, partyBId: bId, ...scored });
      }
    }
  }
  return [...out.values()].sort((x, y) => y.score - x.score);
}
