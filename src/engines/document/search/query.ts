// Search query parsing (c84). Pure.
//
// Accepts what people type: plain words, "quoted phrases", -excluded words,
// OR between words, and a few filters: type:<document_type>, tag:<privilege tag>,
// folder:<folder key>. The result drives both the Postgres backend
// (websearch_to_tsquery — never raw to_tsquery, so user input can never form
// a syntax error or operator injection; the text is also always a bound
// parameter) and the in-memory backend used in tests.

import { isPrivilegeTag } from "@/core/documents";

export const MAX_QUERY_CHARS = 500;
export const MAX_QUERY_TERMS = 32;

export interface ParsedQuery {
  /** Required words (normalised). */
  terms: string[];
  /** Required phrases, each a list of normalised words. */
  phrases: string[][];
  /** Words that must not appear. */
  excluded: string[];
  /** Alternative groups from "a OR b": at least one word of each group must match. */
  anyOf: string[][];
  filters: { documentType?: string; privilegeTag?: string; folderKey?: string };
  /** Text for websearch_to_tsquery (reconstructed from the parsed parts). */
  websearch: string;
  /** Nothing to search for (filters alone are allowed with a matter scope). */
  empty: boolean;
  /** Problems worth showing the user (unknown filter values …). */
  warnings: string[];
}

/** Lower-case, strip accents and punctuation at the edges. Pure. */
export function normalizeToken(raw: string): string {
  return raw
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

/** Split text into normalised words (keeps inner '-', '.', '/' e.g. cause numbers "2024-CI-01234"). */
export function tokenize(text: string): string[] {
  return text
    .split(/[^\p{L}\p{N}\-./']+/u)
    .map(normalizeToken)
    .filter((t) => t.length > 0);
}

export function parseSearchQuery(raw: string): ParsedQuery {
  const warnings: string[] = [];
  let input = (raw ?? "").normalize("NFKC");
  if (input.length > MAX_QUERY_CHARS) {
    input = input.slice(0, MAX_QUERY_CHARS);
    warnings.push(`Search text was cut to ${MAX_QUERY_CHARS} characters.`);
  }

  const phrases: string[][] = [];
  input = input.replace(/"([^"]*)"?/g, (_m, inner: string) => {
    const words = tokenize(inner);
    if (words.length === 1) return ` ${words[0]} `;
    if (words.length > 1) phrases.push(words);
    return " ";
  });

  const filters: ParsedQuery["filters"] = {};
  const terms: string[] = [];
  const excluded: string[] = [];
  const anyOf: string[][] = [];

  const raws = input.split(/\s+/).filter(Boolean);
  let lastGroup: number | null = null;
  for (let i = 0; i < raws.length; i++) {
    const tok = raws[i]!;
    const filter = /^(type|tag|folder):(.+)$/i.exec(tok);
    if (filter) {
      const key = filter[1]!.toLowerCase();
      const value = filter[2]!.toLowerCase();
      if (key === "type") filters.documentType = value;
      else if (key === "folder") filters.folderKey = value;
      else if (isPrivilegeTag(value)) filters.privilegeTag = value;
      else warnings.push(`Unknown tag '${value}'.`);
      continue;
    }
    if (tok === "OR") continue;
    if (tok.startsWith("-") && tok.length > 1) {
      for (const w of tokenize(tok.slice(1))) excluded.push(w);
      continue;
    }
    const words = tokenize(tok);
    if (words.length === 0) continue;
    // "a OR b OR c": fold into one alternative group with the previous word(s).
    if (raws[i - 1] === "OR" && lastGroup !== null) {
      anyOf[lastGroup]!.push(...words);
      continue;
    }
    if (raws[i - 1] === "OR" && terms.length > 0) {
      const prev = terms.pop()!;
      anyOf.push([prev, ...words]);
      lastGroup = anyOf.length - 1;
      continue;
    }
    lastGroup = null;
    terms.push(...words);
  }

  const cap = <T>(list: T[]): T[] => list.slice(0, MAX_QUERY_TERMS);
  const t = cap([...new Set(terms)]);
  const ex = cap([...new Set(excluded)]);
  const ph = cap(phrases);
  const any = cap(anyOf);
  const websearch = [
    ...t,
    ...ph.map((p) => `"${p.join(" ")}"`),
    ...any.map((g) => g.join(" or ")),
    ...ex.map((w) => `-${w}`),
  ].join(" ");
  return {
    terms: t,
    phrases: ph,
    excluded: ex,
    anyOf: any,
    filters,
    websearch,
    empty: t.length === 0 && ph.length === 0 && any.length === 0,
    warnings,
  };
}

/** Every positive word in the query (for highlighting). */
export function highlightWords(q: ParsedQuery): string[] {
  return [...new Set([...q.terms, ...q.phrases.flat(), ...q.anyOf.flat()])];
}
