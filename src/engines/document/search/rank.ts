// Ranking and snippets for search results (c84). Pure.
//
// Postgres does the heavy lifting (GIN index, ts_rank_cd, ts_headline). This
// layer turns its output into something the UI can render safely and orders
// it predictably:
//   - parseHeadline(): ts_headline output with sentinel markers → plain text + highlight ranges
//     (the UI escapes the text; no HTML from the database is ever trusted);
//   - buildSnippet(): the same shape computed in JS (in-memory backend, title-only hits);
//   - rerank(): database rank + title match + current version + gentle recency.

import { highlightWords, tokenize, type ParsedQuery } from "./query";

/** Sentinels passed to ts_headline as StartSel/StopSel. Control chars cannot appear in finalised text. */
export const HL_START = "\u0002";
export const HL_STOP = "\u0003";

export interface Snippet {
  text: string;
  /** [start, end) character ranges in `text` to highlight. */
  highlights: [number, number][];
}

/** Turn ts_headline output (with HL_START/HL_STOP markers) into text + ranges, whitespace collapsed. */
export function parseHeadline(raw: string): Snippet {
  let text = "";
  const ranges: [number, number][] = [];
  let open: number | null = null;
  for (const ch of raw) {
    if (ch === HL_START) {
      open ??= text.length;
    } else if (ch === HL_STOP) {
      if (open !== null && text.length > open) ranges.push([open, text.length]);
      open = null;
    } else {
      text += ch;
    }
  }
  if (open !== null && text.length > open) ranges.push([open, text.length]);
  const { out, map } = collapseMap(text);
  const highlights = ranges.map(([s, e]) => [map[s]!, map[e]!] as [number, number]).filter(([s, e]) => e > s);
  return { text: out, highlights };
}

/** Collapse whitespace runs and trim; map[i] = output index for input index i. */
function collapseMap(text: string): { out: string; map: number[] } {
  const map: number[] = new Array(text.length + 1);
  let out = "";
  let prevSpace = true; // drops leading whitespace
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (/\s/.test(ch)) {
      map[i] = out.length;
      if (!prevSpace) out += " ";
      prevSpace = true;
    } else {
      map[i] = out.length;
      out += ch;
      prevSpace = false;
    }
  }
  map[text.length] = out.length;
  const trimmed = out.trimEnd();
  for (let i = 0; i < map.length; i++) map[i] = Math.min(map[i]!, trimmed.length);
  return { out: trimmed, map };
}

/** Light stemming so "filed" matches "filing"/"files" in the JS paths (Postgres uses its own stemmer). */
export function stem(word: string): string {
  const w = word.toLowerCase();
  for (const suffix of ["ings", "ing", "edly", "ed", "ies", "es", "s"]) {
    if (w.length > suffix.length + 2 && w.endsWith(suffix)) {
      const base = w.slice(0, -suffix.length);
      return suffix === "ies" ? `${base}y` : base;
    }
  }
  return w;
}

interface WordPos {
  word: string;
  start: number;
  end: number;
}

function wordPositions(text: string): WordPos[] {
  const out: WordPos[] = [];
  for (const m of text.matchAll(/[\p{L}\p{N}][\p{L}\p{N}\-./']*/gu)) {
    const norm = tokenize(m[0])[0];
    if (norm) out.push({ word: norm, start: m.index!, end: m.index! + m[0].length });
  }
  return out;
}

/**
 * Best window of `maxChars` around the densest cluster of query words, with
 * highlight ranges. Falls back to the start of the text. Pure.
 */
export function buildSnippet(content: string, query: ParsedQuery, maxChars: number): Snippet {
  const text = content.replace(/\s+/g, " ").trim();
  if (!text) return { text: "", highlights: [] };
  const wanted = new Set(highlightWords(query).map(stem));
  const words = wordPositions(text);
  const hits = words.filter((w) => wanted.has(stem(w.word)));

  let start = 0;
  if (hits.length) {
    let best = 0;
    let bestCount = -1;
    for (let i = 0; i < hits.length; i++) {
      let count = 0;
      for (let j = i; j < hits.length && hits[j]!.end - hits[i]!.start <= maxChars; j++) count++;
      if (count > bestCount) {
        bestCount = count;
        best = i;
      }
    }
    start = Math.max(0, hits[best]!.start - Math.floor(maxChars / 4));
    // start on a word boundary
    if (start > 0) {
      const sp = text.indexOf(" ", start);
      if (sp >= 0 && sp < hits[best]!.start) start = sp + 1;
    }
  }
  let end = Math.min(text.length, start + maxChars);
  if (end < text.length) {
    const sp = text.lastIndexOf(" ", end);
    if (sp > start + maxChars / 2) end = sp;
  }
  const prefix = start > 0 ? "… " : "";
  const suffix = end < text.length ? " …" : "";
  const highlights: [number, number][] = hits
    .filter((h) => h.start >= start && h.end <= end)
    .map((h) => [h.start - start + prefix.length, h.end - start + prefix.length]);
  return { text: prefix + text.slice(start, end) + suffix, highlights };
}

// ---------------------------------------------------------------------------
// Matching (in-memory backend) and ranking
// ---------------------------------------------------------------------------

/** Does `text` satisfy the query (all terms, all phrases, one of each OR group, no excluded word)? Pure. */
export function matchesQuery(text: string, q: ParsedQuery): boolean {
  const words = tokenize(text).map(stem);
  const set = new Set(words);
  if (q.excluded.some((w) => set.has(stem(w)))) return false;
  if (!q.terms.every((t) => set.has(stem(t)))) return false;
  if (!q.anyOf.every((g) => g.some((t) => set.has(stem(t))))) return false;
  for (const phrase of q.phrases) {
    const p = phrase.map(stem);
    let found = false;
    for (let i = 0; i + p.length <= words.length && !found; i++) found = p.every((w, k) => words[i + k] === w);
    if (!found) return false;
  }
  return true;
}

/** Simple term-frequency score for the in-memory backend (title words count 4x). Pure. */
export function scoreText(title: string, content: string, q: ParsedQuery): number {
  const wanted = highlightWords(q).map(stem);
  if (wanted.length === 0) return 0;
  const t = tokenize(title).map(stem);
  const c = tokenize(content).map(stem);
  let score = 0;
  for (const w of wanted) {
    score += 4 * t.filter((x) => x === w).length;
    score += Math.log1p(c.filter((x) => x === w).length);
  }
  return score / (wanted.length * (1 + Math.log1p(c.length / 1000)));
}

export interface RankInput {
  title: string;
  /** Backend relevance (ts_rank_cd or scoreText); any non-negative scale. */
  rank: number;
  isCurrentVersion: boolean;
  createdAt: Date;
}

/**
 * Final order: normalised backend rank, +0.5 when every query word is in the
 * title, +0.25 for the current version, plus up to 0.1 for recency (half-life
 * one year). Ties keep the backend's order. Pure.
 */
export function rerank<T extends RankInput>(hits: readonly T[], q: ParsedQuery, now: Date): (T & { score: number })[] {
  const max = Math.max(0, ...hits.map((h) => h.rank)) || 1;
  const words = highlightWords(q).map(stem);
  const scored = hits.map((h, i) => {
    const titleWords = new Set(tokenize(h.title).map(stem));
    const titleBonus = words.length > 0 && words.every((w) => titleWords.has(w)) ? 0.5 : 0;
    const ageDays = Math.max(0, (now.getTime() - h.createdAt.getTime()) / 86_400_000);
    const recency = 0.1 * Math.pow(0.5, ageDays / 365);
    const score = h.rank / max + titleBonus + (h.isCurrentVersion ? 0.25 : 0) + recency;
    return { ...h, score: Math.round(score * 10_000) / 10_000, i };
  });
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.map(({ i: _i, ...rest }) => rest as T & { score: number });
}
