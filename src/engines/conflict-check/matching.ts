// c57 — name matching for conflict checks. Pure functions, no database.
//
// Exact-name matching misses real conflicts, so this matcher looks for
// spelling variants and typos, nicknames (Bob/Robert, Chuy/Jesús), phonetic
// similarity (Smyth/Smith, Gonzales/Gonzalez), Spanish naming (two surnames,
// either used alone; "de la" particles), maiden and married names, and
// business suffixes (LLC, Inc.). Secondary identifiers (date of birth,
// address, phone, email) strengthen a hit or mark it as possibly a different
// person — but never remove it: the matcher is tuned to OVER-flag, because a
// missed conflict is far worse than an extra review. Every hit carries the
// evidence for it and a strength band, and every hit goes to a human
// conflicts attorney; nothing here ever clears anything. Results feed the
// c3 core check (coreCheck.ts).

import { normalizeName } from "@/core";
import { comparableTokens, isNicknamePair, normalizeAddress, phoneticKey } from "./nameRules";
import type { ConflictHit, IndexEntry, MatchBand, MatchEvidence, MatchKind, SearchedName } from "./types";

export function tokens(normalized: string): string[] {
  return normalized.split(" ").filter(Boolean);
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
  evidence: MatchEvidence[];
}

type TokenLink = "exact" | "nickname" | "phonetic" | "fuzzy";
interface TokenPair {
  a: string;
  b: string;
  link: TokenLink;
  score: number;
}

const LINK_SCORE: Record<TokenLink, number> = { exact: 4, nickname: 3, phonetic: 2, fuzzy: 1 };

/** How two single tokens relate, strongest first. Pure. */
export function linkTokens(a: string, b: string): TokenLink | null {
  if (a === b) return "exact";
  if (isNicknamePair(a, b)) return "nickname";
  if (a.length >= 2 && b.length >= 2 && phoneticKey(a) === phoneticKey(b)) return "phonetic";
  if (Math.min(a.length, b.length) >= 4 && similarity(a, b) >= 0.75) return "fuzzy";
  return null;
}

/** Greedy best alignment of every token of `short` to a distinct token of `long`. Pure. */
function alignTokens(short: readonly string[], long: readonly string[]): TokenPair[] {
  const used = new Set<number>();
  const out: TokenPair[] = [];
  for (const a of short) {
    let best: { idx: number; link: TokenLink } | null = null;
    long.forEach((b, idx) => {
      if (used.has(idx)) return;
      const link = linkTokens(a, b);
      if (link && (!best || LINK_SCORE[link] > LINK_SCORE[best.link])) best = { idx, link };
    });
    if (!best) continue;
    const { idx, link } = best as { idx: number; link: TokenLink };
    used.add(idx);
    out.push({ a, b: long[idx]!, link, score: LINK_SCORE[link] });
  }
  return out;
}

function pairEvidence(pairs: readonly TokenPair[]): MatchEvidence[] {
  return pairs
    .filter((p) => p.link !== "exact")
    .map((p): MatchEvidence => {
      switch (p.link) {
        case "nickname":
          return { signal: "nickname", detail: `'${p.a}' and '${p.b}' are forms of the same given name`, weight: 0.85 };
        case "phonetic":
          return { signal: "phonetic", detail: `'${p.a}' sounds like '${p.b}'`, weight: 0.7 };
        default:
          return { signal: "spelling", detail: `'${p.a}' is spelled like '${p.b}' (possible typo)`, weight: round(0.75 * similarity(p.a, p.b)) };
      }
    });
}

function cmp(kind: MatchKind, strength: number, reason: string, extra: MatchEvidence[] = []): NameComparison {
  return { kind, strength: round(strength), reason, evidence: [{ signal: "name", detail: reason, weight: round(strength) }, ...extra] };
}

/**
 * Compare two NORMALISED names. Returns the strongest match found, or null.
 * `partial` marks the searched name as incomplete (first name / nickname
 * only), which enables single-token matching.
 */
export function compareNames(searched: string, candidate: string, opts: { partial?: boolean } = {}): NameComparison | null {
  if (!searched || !candidate) return null;
  if (searched === candidate) return cmp("exact", 1, "Same name");

  const a = comparableTokens(searched);
  const b = comparableTokens(candidate);
  if (a.join(" ") === b.join(" ")) return cmp("exact", 0.98, "Same name apart from a business suffix or name particle");

  if ([...a].sort().join(" ") === [...b].sort().join(" ")) return cmp("reordered", 0.95, "Same names in a different order");

  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  const pairs = alignTokens(shorter, longer);
  const allAligned = pairs.length === shorter.length;
  const links = new Set(pairs.map((p) => p.link));
  const onlyStrong = pairs.every((p) => p.link === "exact" || p.link === "nickname");

  if (allAligned && a.length === b.length && onlyStrong && links.has("nickname")) {
    return cmp("nickname", 0.85, "Same name allowing for a common nickname", pairEvidence(pairs));
  }

  // One name contains every part of the other: a missing middle name, or one
  // of two Spanish surnames used alone ("María García" / "María García López").
  if (shorter.length >= 2 && allAligned && onlyStrong) {
    return cmp("subset", 0.8, "One name contains all parts of the other (middle name or second surname)", pairEvidence(pairs));
  }

  // Initial + surname: "J Smith" vs "John Smith".
  if (a.length >= 2 && b.length >= 2 && a[a.length - 1] === b[b.length - 1]) {
    const fa = a[0]!;
    const fb = b[0]!;
    if ((fa.length === 1 && fb.startsWith(fa)) || (fb.length === 1 && fa.startsWith(fb))) {
      return cmp("initial", 0.6, "Same surname and matching first initial", [
        { signal: "initial", detail: `Initial '${fa.length === 1 ? fa : fb}' fits '${fa.length === 1 ? fb : fa}'`, weight: 0.6 },
      ]);
    }
  }

  // Typos: whole-string similarity, or token-by-token when counts match.
  const whole = similarity(searched, candidate);
  if (Math.min(searched.length, candidate.length) >= 5 && whole >= 0.85) {
    return cmp("fuzzy", 0.9 * whole, "Very similar spelling", [
      { signal: "spelling", detail: `'${searched}' is spelled like '${candidate}' (possible typo)`, weight: round(0.9 * whole) },
    ]);
  }
  // Sounds alike: every part matches exactly, by nickname, phonetically or by spelling.
  if (allAligned && shorter.length >= 2 && (links.has("phonetic") || links.has("fuzzy"))) {
    const sameCount = a.length === b.length;
    return cmp(
      "phonetic",
      sameCount ? 0.7 : 0.62,
      sameCount ? "Names sound alike (phonetic match)" : "Names sound alike, with an extra middle name or surname",
      pairEvidence(pairs)
    );
  }

  if (a.length === b.length && a.length >= 2) {
    const sims = a.map((t, i) => similarity(t, b[i]!));
    if (sims.every((s) => s >= 0.75)) {
      return cmp("fuzzy", 0.75 * Math.min(...sims), "Similar spelling of each name part", pairEvidence(pairs));
    }
  }

  // Partial names (first name or nickname only) match any linked token.
  if (opts.partial || a.length === 1) {
    if (a.length === 1 && a[0]!.length >= 2) {
      const link = b.map((t) => linkTokens(a[0]!, t)).find((l) => l === "exact" || l === "nickname");
      if (link) {
        return cmp("single_token", 0.4, "Only part of the name was given; one part matches", [
          { signal: "partial_name", detail: "Only one name was given, so this is a weak match", weight: 0.4 },
        ]);
      }
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

/** Strength band shown with every hit (c57). Pure. */
export function bandFor(strength: number): MatchBand {
  if (strength >= 0.85) return "strong";
  if (strength >= 0.6) return "likely";
  return "weak";
}

/** One-line explanation of a hit for the conflicts attorney (internal only). Pure. */
export function explainHit(hit: Pick<ConflictHit, "searchedName" | "displayName" | "strength" | "reasons" | "band" | "evidence">): string {
  const band = hit.band ?? bandFor(hit.strength);
  const why = hit.evidence?.length ? hit.evidence.map((e) => e.detail) : hit.reasons;
  return `'${hit.searchedName}' → '${hit.displayName}': ${band} match (${Math.round(hit.strength * 100)}%). ${[...new Set(why)].join("; ")}.`;
}

export interface MatchOptions {
  /** Hits below this strength are dropped (default 0.4: over-flag). */
  minStrength?: number;
  /** Involvements belonging to the matter/inquiry being checked are not hits against itself. */
  exclude?: { kind: "matter" | "inquiry"; id: string } | null;
}

type Best = NameComparison & { matchedName: string };

function consider(best: Best | null, next: Best): Best {
  return !best || next.strength > best.strength ? next : best;
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
    const searchedTokens = comparableTokens(normalized, "person");
    const address = normalizeAddress(s.address);

    for (const entry of entries) {
      const involvements = opts.exclude
        ? entry.involvements.filter((i) => !(i.kind === opts.exclude!.kind && i.id === opts.exclude!.id))
        : [...entry.involvements];
      // A party known ONLY from the matter/inquiry being checked is not a hit against itself.
      // (The same person's OTHER involvements are still hits: a prospect who is a
      // former opposing party must reach the conflicts attorney.)
      if (entry.sourceType === "party" && involvements.length === 0) continue;

      let best: Best | null = null;
      for (const n of entry.names) {
        const c = compareNames(normalized, n.normalized, { partial });
        if (!c) continue;
        const variant = n.type !== "legal";
        best = consider(best, {
          ...c,
          kind: c.kind === "exact" && variant ? "variant" : c.kind,
          reason: variant ? `${c.reason} (${n.type} name)` : c.reason,
          evidence: variant
            ? [...c.evidence, { signal: "name_variant", detail: `Matched the recorded ${n.type} name '${n.normalized}'`, weight: c.strength }]
            : c.evidence,
          matchedName: n.normalized,
        });
      }
      const extra: MatchEvidence[] = [];

      // Secondary identifiers (strong even when names differ, e.g. a new married name).
      const email = lowerEmail(s.email);
      if (email && (entry.emails ?? []).some((e) => lowerEmail(e) === email)) {
        extra.push({ signal: "email", detail: "Same email address", weight: 0.9 });
        best = consider(best, { kind: "email", strength: 0.9, reason: "Same email address", evidence: [], matchedName: email });
      }
      const phone = digits(s.phone);
      if (phone.length >= 7 && (entry.phones ?? []).some((p) => digits(p) === phone)) {
        extra.push({ signal: "phone", detail: "Same phone number", weight: 0.85 });
        best = consider(best, { kind: "phone", strength: 0.85, reason: "Same phone number", evidence: [], matchedName: phone });
      }
      const sameDob = !!s.dateOfBirth && !!entry.dateOfBirth && s.dateOfBirth === entry.dateOfBirth;
      const dobDiffers = !!s.dateOfBirth && !!entry.dateOfBirth && s.dateOfBirth !== entry.dateOfBirth;
      if (sameDob) {
        const surname = searchedTokens.at(-1);
        const given = searchedTokens[0];
        const entryTokens = entry.names.map((n) => comparableTokens(n.normalized, "person"));
        if (surname && entryTokens.some((t) => t.includes(surname))) {
          best = consider(best, { kind: "dob_name", strength: 0.85, reason: "Same date of birth and surname", evidence: [], matchedName: normalized });
        } else if (
          given &&
          searchedTokens.length >= 2 &&
          entry.kind !== "organization" &&
          entryTokens.some((t) => t.length >= 2 && (t[0] === given || isNicknamePair(t[0]!, given)))
        ) {
          // Same first name and birth date, different surname: a maiden or married name.
          best = consider(best, {
            kind: "name_change",
            strength: 0.75,
            reason: "Same first name and date of birth with a different surname (possible maiden or married name)",
            evidence: [],
            matchedName: normalized,
          });
        }
      }
      const sameAddress = !!address && (entry.addresses ?? []).some((x) => normalizeAddress(x) === address);
      if (sameAddress) {
        extra.push({ signal: "address", detail: "Same address", weight: 0.5 });
        best = consider(best, { kind: "address", strength: 0.5, reason: "Same address (may be the same person or a household member)", evidence: [], matchedName: address });
      }
      if (!best) continue;

      let strength = best.strength;
      const nameBased = !["email", "phone", "address", "dob_name", "name_change"].includes(best.kind);
      if (sameDob) {
        extra.push({ signal: "date_of_birth", detail: "Same date of birth", weight: 0.15 });
        if (nameBased) strength = Math.min(0.99, strength + 0.15);
      } else if (dobDiffers && nameBased) {
        // Probably a different person — but still shown (over-flag); the attorney decides.
        extra.push({ signal: "date_of_birth_differs", detail: "Different date of birth: may be a different person", weight: -0.25 });
        strength = Math.max(minStrength, strength * 0.75);
      }
      if (sameAddress && best.kind !== "address") strength = Math.min(0.99, strength + 0.05);
      if ((email || phone) && best.kind !== "email" && best.kind !== "phone" && extra.some((e) => e.signal === "email" || e.signal === "phone")) {
        strength = Math.min(0.99, Math.max(strength, 0.9));
      }
      strength = round(strength);
      if (strength < minStrength) continue;

      const evidence = [...best.evidence, ...extra];
      if (evidence.length === 0) evidence.push({ signal: "name", detail: best.reason, weight: best.strength });
      const reasons = [best.reason, ...extra.filter((e) => e.weight > 0).map((e) => e.detail)];
      if (extra.some((e) => e.signal === "date_of_birth_differs")) reasons.push("Different date of birth: may be a different person");
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
        strength,
        reasons: [...new Set(reasons)],
        involvements,
        ownerUserId: entry.ownerUserId ?? null,
        note: entry.note ?? null,
        evidence: dedupeEvidence(evidence),
        band: bandFor(strength),
      });
    }
  });

  return dedupeHits(hits).sort((x, y) => y.strength - x.strength || x.displayName.localeCompare(y.displayName));
}

function dedupeEvidence(list: readonly MatchEvidence[]): MatchEvidence[] {
  const seen = new Set<string>();
  return list.filter((e) => {
    const k = `${e.signal}|${e.detail}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
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
        band: bandFor(round(h.strength * Math.pow(0.8, steps))),
        reasons: [`Linked organisation of ${h.displayName} (${steps} step${steps === 1 ? "" : "s"})`],
        evidence: [
          ...(h.evidence ?? []),
          { signal: "org_link", detail: `Parent, subsidiary or affiliate of ${h.displayName} (${steps} step${steps === 1 ? "" : "s"})`, weight: -0.2 * steps },
        ],
        involvements: [...entry.involvements],
        viaOrgLinkFromPartyId: h.partyId,
      });
    }
  }
  return out.sort((x, y) => y.strength - x.strength);
}
