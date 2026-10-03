// Search entry point for routes: Postgres backend + permission-aware search
// + access log (every search is logged with its text and result count;
// the log is internal and tenant-scoped).

import { audit } from "@/core";
import type { TenantTx } from "@/tenancy/withTenant";
import { ENGINE, type DocumentSettings } from "../settings";
import type { AccessContext, StaffViewer } from "../access/policy";
import { logAccess } from "../access/service";
import { PostgresSearchBackend } from "./postgres";
import { searchDocuments, type SearchBackend, type SearchOutcome } from "./search";

export async function runSearch(
  tx: TenantTx,
  ctx: { tenantId: string; viewer: StaffViewer; access: AccessContext; settings: DocumentSettings },
  input: { text: string; matterId?: string | null; allVersions?: boolean; page?: number },
  backend: SearchBackend = new PostgresSearchBackend(tx)
): Promise<SearchOutcome> {
  const outcome = await searchDocuments(backend, {
    tenantId: ctx.tenantId,
    viewer: ctx.viewer,
    access: ctx.access,
    text: input.text,
    matterId: input.matterId ?? null,
    allVersions: input.allVersions,
    page: input.page,
    pageSize: ctx.settings.searchPageSize,
    snippetChars: ctx.settings.snippetChars,
  });
  await logAccess(tx, {
    tenantId: ctx.tenantId,
    viewer: ctx.viewer,
    action: "search",
    outcome: outcome.matterDenied ? "denied" : "allowed",
    reason: outcome.matterDenied ? (ctx.viewer.permissions.includes("documents.read") ? "screened" : "no_permission") : null,
    matterId: input.matterId ?? null,
    detail: { text: input.text.slice(0, 500), results: outcome.results.length, page: input.page ?? 1, allVersions: !!input.allVersions },
  });
  if (outcome.droppedByRecheck > 0) {
    // The SQL scoping and the per-hit check disagreed: a bug worth knowing about, never a leak.
    await audit(tx, {
      tenantId: ctx.tenantId,
      engine: ENGINE,
      action: "search.recheck_dropped",
      payload: { dropped: outcome.droppedByRecheck, backend: backend.name },
    });
  }
  return outcome;
}
