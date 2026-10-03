// Permission-aware document search (c84). The backend finds candidates
// (Postgres in production, in-memory in tests); this module scopes the
// request to what the viewer may see BEFORE querying (screened matters,
// matter scope, hidden privilege tags are pushed into the backend request)
// and checks every hit again with decideDocumentAccess() AFTER (defence in
// depth, like withTenant pairs RLS with an explicit tenant filter).

import { decideDocumentAccess, hiddenTagsForRole, type AccessContext, type StaffViewer } from "../access/policy";
import { buildSnippet, matchesQuery, parseHeadline, rerank, scoreText, type Snippet } from "./rank";
import { parseSearchQuery, type ParsedQuery } from "./query";

export interface BackendRequest {
  tenantId: string;
  query: ParsedQuery;
  /** Restrict to one matter (matter search) or null (firm-wide). */
  matterId: string | null;
  excludeMatterIds: readonly string[];
  /** null = every matter. */
  onlyMatterIds: readonly string[] | null;
  hiddenTags: readonly string[];
  /** Only the current version of each file (default) or every version. */
  currentOnly: boolean;
  limit: number;
  offset: number;
  snippetChars: number;
}

export interface RawHit {
  documentId: string;
  groupId: string;
  matterId: string;
  title: string;
  documentType: string;
  privilegeTag: string;
  clientVisible: boolean;
  version: number;
  isCurrentVersion: boolean;
  folderId: string | null;
  createdAt: Date;
  rank: number;
  /** ts_headline output with HL markers, when the backend computed it. */
  headline?: string | null;
  /** Text to build a snippet from, when the backend did not. */
  content?: string | null;
}

export interface SearchBackend {
  readonly name: string;
  search(req: BackendRequest): Promise<RawHit[]>;
}

export interface SearchResult {
  documentId: string;
  groupId: string;
  matterId: string;
  title: string;
  documentType: string;
  privilegeTag: string;
  version: number;
  isCurrentVersion: boolean;
  folderId: string | null;
  createdAt: Date;
  score: number;
  snippet: Snippet;
}

export interface SearchOutcome {
  query: ParsedQuery;
  results: SearchResult[];
  /** Hits the backend returned but the per-hit check refused (should be 0; logged if not). */
  droppedByRecheck: number;
  /** True when the viewer is screened from the requested matter (nothing was searched). */
  matterDenied: boolean;
}

export interface SearchInput {
  tenantId: string;
  viewer: StaffViewer;
  access: AccessContext;
  text: string;
  matterId?: string | null;
  allVersions?: boolean;
  page?: number;
  pageSize: number;
  snippetChars: number;
  now?: Date;
}

/** Run a search for a staff viewer. Throws nothing for "no access": returns an empty, flagged outcome. */
export async function searchDocuments(backend: SearchBackend, input: SearchInput): Promise<SearchOutcome> {
  const query = parseSearchQuery(input.text);
  const empty = (matterDenied: boolean): SearchOutcome => ({ query, results: [], droppedByRecheck: 0, matterDenied });
  if (!input.viewer.permissions.includes("documents.read")) return empty(true);

  const matterId = input.matterId ?? null;
  if (matterId) {
    const probe = decideDocumentAccess(input.viewer, "search", { matterId, privilegeTag: "none", clientVisible: false }, input.access);
    if (!probe.allowed) return empty(true);
  }
  // Firm-wide search with no words is not allowed (it would list every document).
  if (query.empty && !matterId) return empty(false);

  const page = Math.max(1, Math.floor(input.page ?? 1));
  const req: BackendRequest = {
    tenantId: input.tenantId,
    query,
    matterId,
    excludeMatterIds: input.viewer.userId ? [...input.access.screenedMatterIds].sort() : [],
    onlyMatterIds: input.access.allowedMatterIds ? [...input.access.allowedMatterIds].sort() : null,
    hiddenTags: hiddenTagsForRole(input.viewer.role, input.access.restrictedTags),
    currentOnly: !input.allVersions,
    limit: input.pageSize,
    offset: (page - 1) * input.pageSize,
    snippetChars: input.snippetChars,
  };
  const raw = await backend.search(req);

  let dropped = 0;
  const allowed = raw.filter((h) => {
    const ok = decideDocumentAccess(input.viewer, "search", h, input.access).allowed;
    if (!ok) dropped++;
    return ok;
  });
  const ranked = rerank(allowed, query, input.now ?? new Date());
  const results: SearchResult[] = ranked.map((h) => ({
    documentId: h.documentId,
    groupId: h.groupId,
    matterId: h.matterId,
    title: h.title,
    documentType: h.documentType,
    privilegeTag: h.privilegeTag,
    version: h.version,
    isCurrentVersion: h.isCurrentVersion,
    folderId: h.folderId,
    createdAt: h.createdAt,
    score: h.score,
    snippet: h.headline ? parseHeadline(h.headline) : buildSnippet(h.content ?? "", query, input.snippetChars),
  }));
  return { query, results, droppedByRecheck: dropped, matterDenied: false };
}

// ---------------------------------------------------------------------------
// In-memory backend (tests, demos). Same semantics as the Postgres backend.
// ---------------------------------------------------------------------------

export interface IndexedRecord extends Omit<RawHit, "rank" | "headline" | "content"> {
  tenantId: string;
  content: string;
  folderKey?: string | null;
}

export class InMemorySearchBackend implements SearchBackend {
  readonly name = "memory";
  constructor(private readonly records: IndexedRecord[] = []) {}

  add(r: IndexedRecord): void {
    this.records.push(r);
  }

  async search(req: BackendRequest): Promise<RawHit[]> {
    const q = req.query;
    const hits = this.records
      .filter((r) => r.tenantId === req.tenantId)
      .filter((r) => (req.matterId ? r.matterId === req.matterId : true))
      .filter((r) => !req.excludeMatterIds.includes(r.matterId))
      .filter((r) => (req.onlyMatterIds ? req.onlyMatterIds.includes(r.matterId) : true))
      .filter((r) => !req.hiddenTags.includes(r.privilegeTag))
      .filter((r) => (req.currentOnly ? r.isCurrentVersion : true))
      .filter((r) => (q.filters.documentType ? r.documentType === q.filters.documentType : true))
      .filter((r) => (q.filters.privilegeTag ? r.privilegeTag === q.filters.privilegeTag : true))
      .filter((r) => (q.filters.folderKey ? r.folderKey === q.filters.folderKey : true))
      .filter((r) => q.empty || matchesQuery(`${r.title}\n${r.content}`, q))
      .map((r) => ({ ...r, rank: q.empty ? 0 : scoreText(r.title, r.content, q), headline: null }));
    hits.sort((a, b) => b.rank - a.rank || b.createdAt.getTime() - a.createdAt.getTime());
    return hits.slice(req.offset, req.offset + req.limit);
  }
}
