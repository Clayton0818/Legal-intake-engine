// Name matching for conflict checks. Pure functions, no database.
//
// This is a deliberately conservative stand-in for c57 (name matching, not in
// this card group): it OVER-flags rather than skips, because a missed
// conflict is far worse than an extra review. Every hit goes to a human
// conflicts attorney; nothing here ever clears anything.

import { normalizeName } from "@/core";
import type { ConflictHit, IndexEntry, MatchKind, SearchedName } from "./types";

// A small nickname table so "Bill Smith" finds "William Smith". c57 owns the
// real list (including Spanish-language diminutives for the Texas pilot).
const NICKNAME_GROUPS: readonly string[][] = [
  ["william", "bill", "billy", "will", "liam"],
  ["robert", "bob", "bobby", "rob", "robbie"],
  ["richard", "rick", "ricky", "dick", "rich"],
  ["elizabeth", "liz", "beth", "betty", "eliza", "lisa"],
  ["katherine", "catherine", "kathy", "kate", "katie", "cathy"],
  ["margaret", "maggie", "peggy", "meg"],
  ["james", "jim", "jimmy", "jamie"],
  ["john", "jack", "johnny"],
  ["joseph", "joe", "joey", "jose", "pepe"],
  ["michael", "mike", "mikey"],
  ["jennifer", "jen", "jenny"],
  ["christopher", "chris"],
  ["daniel", "dan", "danny"],
  ["anthony", "tony"],
  ["francisco", "frank", "paco", "pancho"],
  ["guadalupe", "lupe"],
  ["alejandro", "alex", "alejo"],
  ["alexander", "alex", "sasha"],
  ["maria", "mary", "mari"],
  ["jesus", "chuy"],
  ["roberto", "beto"],
  ["enrique", "kike", "henry"],
];

const NICKNAME_CANON: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  for (const group of NICKNAME_GROUPS) {
    const canon = group[0]!;
    for (const name of group) if (!map.has(name)) map.set(name, canon);
  }
  return map;
})();

/** Organisation suffixes ignored when comparing business names. */
const ORG_SUFFIXES = new Set(["llc", "inc", "incorporated", "corp", "corporation", "co", "company", "ltd", "lp", "llp", "pllc", "pc", "the"]);

export function tokens(normalized: string): string[] {
  return normalized.split(" ").filter(Boolean);
}

function stripOrgSuffixes(toks: string[]): string[] {
  const kept = toks.filter((t) => !ORG_SUFFIXES.has(t));
  return kept.length > 0 ? kept : toks;
}

function canon(token: string): string {
  return NICKNAME_CANON.get(token) ?? token;
}

/** Levenshtein distance (iterative, two rows). */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    prev = cur;
  }
  return prev[b.length]!;
}

/** 1 = identical, 0 = nothing in common. */
export function similarity(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  return longest === 0 ? 1 : 1 - editDistance(a, b) / longest;
}

export interface NameComparison {
  kind: MatchKind;
  strength: number;
  reason: string;
}

/**
 * Compare two NORMALISED names. Returns the strongest match found, or null.
 * `partial` marks the searched name as incomplete (first name / nickname
 * only), which enables single-token matching.
 */
export function compareNames(searched: string, candidate: string, opts: { partial?: boolean } = {}): NameComparison | null {
  if (!searched || !candidate) return null;
  if (searched === candidate) return { kind: "exact", strength: 1, reason: "Same name" };

  const a = stripOrgSuffixes(tokens(searched));
  const b = stripOrgSuffixes(tokens(candidate));
  if (a.join(" ") === b.join(" ")) return { kind: "exact", strength: 0.98, reason: "Same name apart from a business suffix" };

  const sortedA = [...a].sort().join(" ");
  const sortedB = [...b].sort().join(" ");
  if (sortedA === sortedB) return { kind: "reordered", strength: 0.95, reason: "Same names in a different order" };

  const canonA = a.map(canon);
  const canonB = b.map(canon);
  if ([...canonA].sort().join(" ") === [...canonB].sort().join(" ")) {
    return { kind: "nickname", strength: 0.85, reason: "Same name allowing for a common nickname" };
  }

  // One name contains every token of the other (missing middle name or a
  // second surname, common with Spanish naming conventions).
  const [shorter, longer] = canonA.length <= canonB.length ? [canonA, canonB] : [canonB, canonA];
  if (shorter.length >= 2 && shorter.every((t) => longer.includes(t))) {
    return { kind: "subset", strength: 0.8, reason: "One name contains all parts of the other (middle name or second surname)" };
  }

  // Initial + surname: "J Smith" vs "John Smith".
  if (a.length >= 2 && b.length >= 2 && a[a.length - 1] === b[b.length - 1]) {
    const fa = a[0]!;
    const fb = b[0]!;
    if ((fa.length === 1 && fb.startsWith(fa)) || (fb.length === 1 && fa.startsWith(fb))) {
      return { kind: "initial", strength: 0.6, reason: "Same surname and matching first initial" };
    }
  }

  // Typos: whole-string similarity, or token-by-token when counts match.
  const whole = similarity(searched, candidate);
  if (Math.min(searched.length, candidate.length) >= 5 && whole >= 0.85) {
    return { kind: "fuzzy", strength: round(0.9 * whole), reason: "Very similar spelling" };
  }
  if (a.length === b.length && a.length >= 2) {
    const pairs = a.map((t, i) => similarity(t, b[i]!));
    if (pairs.every((s) => s >= 0.75)) {
      return { kind: "fuzzy", strength: round(0.75 * Math.min(...pairs)), reason: "Similar spelling of each name part" };
    }
  }

  // Partial names (first name or nickname only) match any shared token.
  if (opts.partial || a.length === 1) {
    const single = canonA.length === 1 ? canonA[0]! : null;
    if (single && single.length >= 2 && canonB.includes(single)) {
      return { kind: "single_token", strength: 0.4, reason: "Only part of the name was given; one part matches" };
    }
  }
  return null;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function digits(value: string | null | undefined): string {
  return (value ?? "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
}

function lowerEmail(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

export interface MatchOptions {
  /** Hits below this strength are dropped (default 0.4: over-flag). */
  minStrength?: number;
  /** Involvements belonging to the matter/inquiry being checked are not hits against itself. */
  exclude?: { kind: "matter" | "inquiry"; id: string } | null;
}

/**
 * Match every searched name against every index entry. Returns hits
 * strongest-first, at most one per (searched name, entry). Pure.
 */
export function matchIndex(
  searched: readonly SearchedName[],
  entries: readonly IndexEntry[],
  opts: MatchOptions = {}
): ConflictHit[] {
  const minStrength = opts.minStrength ?? 0.4;
  const hits: ConflictHit[] = [];

  searched.forEach((s, searchedIndex) => {
    if (s.nameUnknown || !s.name.trim()) return;
    const normalized = normalizeName(s.name);
    const partial = s.completeness === "partial";

    for (const entry of entries) {
      const involvements = opts.exclude
        ? entry.involvements.filter((i) => !(i.kind === opts.exclude!.kind && i.id === opts.exclude!.id))
        : [...entry.involvements];
      // A party known ONLY from the matter/inquiry being checked is not a hit against itself.
      // (The same person's OTHER involvements are still hits: a prospect who is a
      // former opposing party must reach the conflicts attorney.)
      if (entry.sourceType === "party" && involvements.length === 0) continue;

      let best: (NameComparison & { matchedName: string }) | null = null;
      const reasons: string[] = [];
      for (const n of entry.names) {
        const cmp = compareNames(normalized, n.normalized, { partial });
        if (cmp && (!best || cmp.strength > best.strength)) {
          best = {
            ...cmp,
            kind: cmp.kind === "exact" && n.type !== "legal" ? "variant" : cmp.kind,
            reason: n.type !== "legal" ? `${cmp.reason} (${n.type} name)` : cmp.reason,
            matchedName: n.normalized,
          };
        }
      }
      if (best) reasons.push(best.reason);

      // Secondary identifiers (strong even when names differ, e.g. a new married name).
      const email = lowerEmail(s.email);
      if (email && (entry.emails ?? []).some((e) => lowerEmail(e) === email)) {
        reasons.push("Same email address");
        if (!best || best.strength < 0.9) best = { kind: "email", strength: 0.9, reason: "Same email address", matchedName: email };
      }
      const phone = digits(s.phone);
      if (phone.length >= 7 && (entry.phones ?? []).some((p) => digits(p) === phone)) {
        reasons.push("Same phone number");
        if (!best || best.strength < 0.85) best = { kind: "phone", strength: 0.85, reason: "Same phone number", matchedName: phone };
      }
      if (s.dateOfBirth && entry.dateOfBirth && s.dateOfBirth === entry.dateOfBirth) {
        const surname = tokens(normalized).at(-1);
        if (surname && entry.names.some((n) => tokens(n.normalized).includes(surname))) {
          reasons.push("Same date of birth and surname");
          if (!best || best.strength < 0.85) {
            best = { kind: "dob_name", strength: 0.85, reason: "Same date of birth and surname", matchedName: normalized };
          }
        }
      }

      if (!best || best.strength < minStrength) continue;
      hits.push({
        searchedIndex,
        searchedName: s.name,
        searchedRole: s.role,
        sourceType: entry.sourceType,
        sourceId: entry.sourceId,
        partyId: entry.partyId ?? null,
        displayName: entry.displayName,
        matchedName: best.matchedName,
        matchKind: best.kind,
        strength: best.strength,
        reasons: [...new Set(reasons)],
        involvements,
        ownerUserId: entry.ownerUserId ?? null,
        note: entry.note ?? null,
      });
    }
  });

  return dedupeHits(hits).sort((x, y) => y.strength - x.strength || x.displayName.localeCompare(y.displayName));
}

/** Keep the strongest hit per (searched name, source, resolved party). */
export function dedupeHits(hits: readonly ConflictHit[]): ConflictHit[] {
  const best = new Map<string, ConflictHit>();
  for (const h of hits) {
    const key = `${h.searchedIndex}|${h.sourceType}|${h.partyId ?? h.sourceId}`;
    const cur = best.get(key);
    if (!cur || h.strength > cur.strength) best.set(key, h);
  }
  return [...best.values()];
}

export interface OrgLink {
  parentPartyId: string;
  childPartyId: string;
}

/**
 * Parties reachable from `partyId` through parent/subsidiary/affiliate links
 * within `depth` steps up or down (c56 rule 10). Excludes `partyId` itself.
 */
export function relatedOrgParties(partyId: string, links: readonly OrgLink[], depth: number): Map<string, number> {
  const found = new Map<string, number>();
  let frontier = [partyId];
  const seen = new Set([partyId]);
  for (let step = 1; step <= depth; step++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const l of links) {
        const other = l.parentPartyId === id ? l.childPartyId : l.childPartyId === id ? l.parentPartyId : null;
        if (other && !seen.has(other)) {
          seen.add(other);
          found.set(other, step);
          next.push(other);
        }
      }
    }
    frontier = next;
  }
  return found;
}

/**
 * Add hits for organisations linked to a hit organisation (e.g. the parent
 * company of an opposing party is a former client). Linked hits are weaker
 * than the direct hit and say how they were found. Pure.
 */
export function expandOrgLinkHits(
  hits: readonly ConflictHit[],
  links: readonly OrgLink[],
  entriesByPartyId: ReadonlyMap<string, IndexEntry>,
  depth: number
): ConflictHit[] {
  if (depth <= 0 || links.length === 0) return [...hits];
  const out = [...hits];
  const present = new Set(hits.map((h) => `${h.searchedIndex}|${h.partyId ?? h.sourceId}`));
  for (const h of hits) {
    if (h.sourceType !== "party" || !h.partyId) continue;
    for (const [relatedId, steps] of relatedOrgParties(h.partyId, links, depth)) {
      const key = `${h.searchedIndex}|${relatedId}`;
      const entry = entriesByPartyId.get(relatedId);
      if (present.has(key) || !entry || entry.involvements.length === 0) continue;
      present.add(key);
      out.push({
        ...h,
        sourceId: entry.sourceId,
        partyId: relatedId,
        displayName: entry.displayName,
        matchKind: "org_link",
        strength: round(h.strength * Math.pow(0.8, steps)),
        reasons: [`Linked organisation of ${h.displayName} (${steps} step${steps === 1 ? "" : "s"})`],
        involvements: [...entry.involvements],
        viaOrgLinkFromPartyId: h.partyId,
      });
    }
  }
  return out.sort((x, y) => y.strength - x.strength);
}
