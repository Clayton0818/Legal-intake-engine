// Full-text search helpers (c84). Pure. The database query uses Postgres
// full-text search (to_tsvector / websearch_to_tsquery); these helpers clean
// the query and build the snippet shown in results.

export function cleanQuery(q: string): string {
  return q.replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
}

export function queryTerms(q: string): string[] {
  return [...new Set(cleanQuery(q).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 2))].slice(0, 12);
}

/** A short excerpt around the first matching term, with matches wrapped in «». */
export function buildSnippet(content: string, q: string, radius = 80): string {
  const terms = queryTerms(q);
  if (!content) return "";
  const lower = content.toLowerCase();
  let at = -1;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  const start = at < 0 ? 0 : Math.max(0, at - radius);
  const end = Math.min(content.length, (at < 0 ? 0 : at) + radius * 2);
  let s = content.slice(start, end).replace(/\s+/g, " ").trim();
  for (const t of terms) {
    s = s.replace(new RegExp(`(${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi"), "«$1»");
  }
  return `${start > 0 ? "…" : ""}${s}${end < content.length ? "…" : ""}`;
}
