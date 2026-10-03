# c84 · Document store for each matter: folders, versions, search and scanned-text recognition

**Card:** `c84` Document engine (Engineering, P0)
**Status:** Built (wave 2, branch `wave2/document`). Vendor storage, malware scanning, OCR and retention dates are built behind approval gates that are still pending.
**Code:** `src/engines/document/**`, `src/db/tables/document.ts`, `src/app/api/document/**`, `src/app/admin/document/page.tsx`

This is the base the other Document-engine cards build on: c4/c39 store signed agreements as versions, c41 approves a specific version (by hash), c49 files client uploads, c85 writes generated drafts, c87 files email, c90 runs the retention clock. Nothing here gives legal advice or interprets a document.

## 1. What it does

| Need | How it is met |
|---|---|
| Per-matter folders from a firm template per practice area | `document_folder_templates` (draft → active → retired, one active per practice area, firm-wide fallback, then a product default). Folders are created on first use and by the `document.provision_folders` worker hook for every open matter, so a matter opened by any engine gets folders without importing this one. Templates must keep the folder keys other cards file into: `client_uploads`, `correspondence`, `email`, `agreements`. Existing matters are never reshaped by a template edit; missing folders are added, user-made folders with the same name are adopted. |
| Every upload versioned, never overwritten | One `documents` row (shared table) per version, `version` = latest + 1 in the same `versionGroupId`. `document_groups` holds the logical file (folder, title, current version, legal hold, "original held"). Uploading bytes identical to the current version creates nothing. The previous version becomes `superseded` (a `filed` version stays `filed`). Group rows are locked during an upload, so two concurrent uploads cannot both become version N+1. Storage adapters refuse to overwrite an object key. |
| Checksums | SHA-256 computed server-side at upload (and checked against a client-supplied one when given), stored on `documents.sha256` and `document_version_files.sha256`, re-verified on every download. A mismatch is never served: it is logged and audited (`document.integrity_failed`). |
| Real file type | Type detected from the bytes (PDF, images, Office, RTF, text, email), not trusted from the browser; executables posing as PDFs are refused. Allowed types and size limit are firm settings. |
| Encryption and malware scanning | `StorageAdapter` / `MalwareScanner` / `OcrAdapter` interfaces. Internal adapters: in-memory (tests, dev) and local disk with AES-256-GCM (dev / single-server pilot; refused in production unless an operator overrides). Any vendor adapter is wrapped so every call needs the shared `vendor.object_storage` gate. Until a scanner is approved, files are marked `not_scanned`: staff may download them (firm setting, with a response header warning), clients never. Infected files are quarantined: stored, never served, never indexed, and an internal flag goes to the uploader and firm admins. |
| Text extraction for search | Native extractors (no new dependencies): plain text, CSV, Markdown, HTML, RTF, email (.eml, readable parts only), PDF text layer (Flate or raw content streams, best effort), Word (.docx) and Excel (.xlsx). Small uploads are indexed inline, the rest by the `document.index_text` worker hook. Scanned PDFs and photos are marked `ocr_pending` and wait for an OCR service behind the same vendor gate. |
| Full-text search across a matter or the firm | Postgres full-text: a STORED generated `tsvector` on `document_text` (title weight A, body B) with a GIN index; queries go through `websearch_to_tsquery` with bound parameters. Supported syntax: words, "phrases", `-exclude`, `a OR b`, `type:`, `tag:`, `folder:`. Current versions only unless `allVersions=1`. A pure layer (`search/query.ts`, `search/rank.ts`) parses queries, turns `ts_headline` output into plain text with highlight ranges, builds snippets and re-ranks (relevance, title match, current version, recency). |
| Search respects permissions and ethical screens | Screens, matter scope and hidden privilege tags are pushed into the SQL; every hit is checked again in code (a disagreement is audited, never shown). A firm-wide search with no words is refused. |
| Every view and download logged | `document_access_log` (append-only): list, view, download, search, with allowed / denied and a machine reason. Denied attempts are committed even though the request fails (the route answers inside the transaction). |
| Retention / deletion periods are policy | Firms enter their own periods with the basis they relied on (`document_retention_rules`, superseded not edited; the product ships none). Proposing a destruction-review date runs only through the shared `rules.retention_periods` gate. Nothing is ever deleted here; c90 adds the lawyer-approved destruction review. Legal hold always wins. |

## 2. Access rules

Checked in this order (first failure is the logged reason):

1. **Permission** (c34 RBAC): `documents.read` to see, `documents.write` to upload or change. Sharing with the client, lifting `sealed`, and setting or releasing a legal hold need `documents.approve` (attorney-only).
2. **Matter scope** (optional, for c99): an injected `MatterScopeSource` may limit a user to certain matters.
3. **Ethical screen** (c60): a screened user cannot list, open, download or search that matter's documents, whatever their role (firm admin included). The API never says *why* access is refused.
4. **Restricted privilege tags** (firm setting; default `sealed` → attorney and firm admin only).
5. **Byte safety** for downloads: infected → never; pending scan → never; not scanned → staff only if the firm allows.

Clients (portal, c11/c89) are modelled already: only their matters, only documents a lawyer marked client-visible with tag `none` or `confidential`, only clean scanned bytes, no search.

### Screens hook

Screens are owned by the conflict-check engine, which this engine may not import. The access check reads screens through `ScreenSource` objects, combined by union (any source that says "screened" wins; a failing source fails closed):

- default: `document_access_blocks`, this engine's local mirror (staff or a sync job write it; `POST /api/document/screens`);
- `setAccessHooks({ screens: [...] })` adds a source, e.g. one reading a shared screens table, or `predicateScreenSource(name, fn)` wrapping an injected predicate.

Foundation request: a shared, read-only screens view or table (e.g. `matter_screens(tenant_id, user_id, matter_id, active)`) that conflict-check writes and every engine reads. When it exists, add one `ScreenSource` and retire the mirror.

## 3. Tables (`src/db/tables/document.ts`)

| Table | Purpose |
|---|---|
| `document_folder_templates` | Firm folder layout per practice area, versioned |
| `document_folders` | A matter's folder tree (archived, never deleted) |
| `document_groups` | One logical file: folder, title, current version, legal hold, original held |
| `document_version_files` | Storage adapter, key, SHA-256, size, detected type, encryption, scan status of each version |
| `document_text` | Extracted text, status, generated `search_vector` |
| `document_access_log` | Append-only view / download / list / search log |
| `document_access_blocks` | Local screens mirror (c60) |
| `document_retention_rules` | Firm-entered retention periods (gated when applied) |

The shared `documents` table is reused as-is. The migration notes at the bottom of the table file list RLS, REVOKEs (append-only log, no deletes on version history) and the generated-column SQL.

## 4. API (`/api/document`)

| Method and path | What |
|---|---|
| `GET /matters/{id}/documents` | The matter's files (current versions); `?folderId=` or `root` |
| `POST /matters/{id}/documents` | Upload (multipart: `file`, optional `groupId` for a new version, `folderId`, `title`, `documentType`, `privilegeTag`, `sha256`) |
| `GET /matters/{id}/folders`, `POST` | Folder tree (provisioned on first use); add a folder |
| `PATCH /folders/{id}` | Rename or archive |
| `GET /documents/{id}` | Version detail and history |
| `GET /documents/{id}/download` | Bytes, checksum-verified (`?inline=1`) |
| `PATCH /groups/{id}` | Move, rename, tag, client-visible, legal hold, original held, archive |
| `GET /search?q=&matterId=&allVersions=&page=` | Full-text search |
| `GET/POST /folder-templates`, `POST /folder-templates/{id}` | Templates; `activate` / `retire` |
| `GET/POST /screens`, `POST /screens/{id}` | Screens mirror; end a screen |
| `GET/POST /retention-rules` | Firm retention periods |
| `GET /matters/{id}/retention` | Proposed destruction-review dates (gated, 423 until approved) |
| `GET /access-log` | Access log (`audit.read`) |

Admin page: `/admin/document` (gate status, storage mode, screen sources, default layout; shows no documents).

## 5. Firm settings (`engine_settings.document`)

`maxUploadBytes` (50 MB), `allowedMimeTypes`, `maxIndexedChars` (400 000), `restrictedTags` (`sealed` → attorney, firm admin), `searchPageSize` (25), `snippetChars` (160), `provisionBatchSize`, `extractionBatchSize`, `extractionMaxAttempts`, `staffMayDownloadUnscanned` (true).

## 6. Known limits

- PDF text extraction is best effort: fonts with custom encodings may give garbled or missing text; such files fall back to `ocr_pending` only when almost no letters come out.
- Bytes are written to storage before the database rows; if the transaction then fails, an unreferenced object is left behind. An orphan sweep belongs with the storage vendor decision.
- The in-memory adapter is per process; use the local-disk adapter for anything that must survive a restart.
- `ts_headline` runs on the full text of each hit on the page (at most one page of results).

## 7. Open questions for Clayton / an attorney

1. Object storage and scanning vendor (storage ADR addendum): which vendor, which region, and is OCR part of the same DPA or a separate subprocessor (needs its own `vendor.*` gate)?
2. Should staff be able to open files no scanner has checked while no scanner is approved (current default: yes, with a warning; clients never)?
3. Is `sealed` limited to attorneys and firm admins the right default, and should `privileged` / `work_product` also be restricted for some roles (e.g. intake staff)?
4. Retention: confirm the product ships no default periods and that the firm records the basis for each (c90 open question 18).
5. Should the search log keep the full search text (useful for audits, but itself sensitive), or only a hash and result count?

*Not legal advice. Retention periods, privilege handling and screening practice must be reviewed by a licensed Texas attorney before use.*
