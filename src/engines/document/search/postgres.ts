// Postgres full-text backend (c84) over document_text.search_vector (GIN).
// All user input is a bound parameter fed to websearch_to_tsquery, which
// never raises a syntax error. Scoping (tenant, matter, screens, matter
// scope, hidden tags, current version only) is in the WHERE clause; the
// caller (./search.ts) re-checks every hit.

import { and, desc, eq, inArray, notInArray, sql, type SQL } from "drizzle-orm";
import { documents } from "@/db/schema";
import { documentFolders, documentGroups, documentText } from "@/db/tables/document";
import type { TenantTx } from "@/tenancy/withTenant";
import { HL_START, HL_STOP } from "./rank";
import type { BackendRequest, RawHit, SearchBackend } from "./search";

const TS_CONFIG = sql.raw("'english'::regconfig");

export class PostgresSearchBackend implements SearchBackend {
  readonly name = "postgres";
  constructor(private readonly tx: TenantTx) {}

  async search(req: BackendRequest): Promise<RawHit[]> {
    const q = req.query;
    const tsq = sql`websearch_to_tsquery(${TS_CONFIG}, ${q.websearch})`;
    const conds: SQL[] = [
      eq(documentText.tenantId, req.tenantId),
      sql`${documentGroups.archivedAt} is null`,
      sql`${documentText.status} <> 'blocked'`,
    ];
    if (!q.empty) conds.push(sql`${documentText.searchVector} @@ ${tsq}`);
    if (req.matterId) conds.push(eq(documentText.matterId, req.matterId));
    if (req.excludeMatterIds.length) conds.push(notInArray(documentText.matterId, [...req.excludeMatterIds]));
    if (req.onlyMatterIds) {
      if (req.onlyMatterIds.length === 0) return [];
      conds.push(inArray(documentText.matterId, [...req.onlyMatterIds]));
    }
    if (req.hiddenTags.length) conds.push(notInArray(documents.privilegeTag, [...req.hiddenTags]));
    if (req.currentOnly) conds.push(sql`${documentGroups.currentDocumentId} = ${documentText.documentId}`);
    if (q.filters.documentType) conds.push(eq(documents.documentType, q.filters.documentType));
    if (q.filters.privilegeTag) conds.push(eq(documents.privilegeTag, q.filters.privilegeTag));
    if (q.filters.folderKey) conds.push(eq(documentFolders.templateKey, q.filters.folderKey));

    const rank = q.empty ? sql<number>`0` : sql<number>`ts_rank_cd(${documentText.searchVector}, ${tsq}, 32)`;
    const opts = `StartSel=${HL_START}, StopSel=${HL_STOP}, MaxFragments=2, MaxWords=${Math.max(10, Math.round(req.snippetChars / 6))}, MinWords=5, FragmentDelimiter=" … "`;
    const headline = q.empty ? sql<string | null>`null` : sql<string | null>`ts_headline(${TS_CONFIG}, ${documentText.content}, ${tsq}, ${opts})`;

    // Rank in a CTE first so ts_headline (expensive) runs only on the page of hits.
    const rows = await this.tx
      .select({
        documentId: documentText.documentId,
        groupId: documentText.groupId,
        matterId: documentText.matterId,
        title: documentGroups.title,
        documentType: documents.documentType,
        privilegeTag: documents.privilegeTag,
        clientVisible: documents.clientVisible,
        version: documents.version,
        currentDocumentId: documentGroups.currentDocumentId,
        folderId: documentGroups.folderId,
        createdAt: documents.createdAt,
        rank,
        headline,
        content: q.empty ? sql<string>`left(${documentText.content}, ${req.snippetChars * 2})` : sql<string | null>`null`,
      })
      .from(documentText)
      .innerJoin(documents, eq(documents.id, documentText.documentId))
      .innerJoin(documentGroups, eq(documentGroups.id, documentText.groupId))
      .leftJoin(documentFolders, eq(documentFolders.id, documentGroups.folderId))
      .where(and(...conds))
      .orderBy(desc(rank), desc(documents.createdAt))
      .limit(req.limit)
      .offset(req.offset);

    return rows.map((r) => ({
      documentId: r.documentId,
      groupId: r.groupId,
      matterId: r.matterId,
      title: r.title,
      documentType: r.documentType,
      privilegeTag: r.privilegeTag,
      clientVisible: r.clientVisible,
      version: r.version,
      isCurrentVersion: r.currentDocumentId === r.documentId,
      folderId: r.folderId,
      createdAt: r.createdAt,
      rank: Number(r.rank) || 0,
      headline: r.headline,
      content: r.content,
    }));
  }
}
