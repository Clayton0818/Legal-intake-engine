// c96 — history import service: validate (preview) → commit → firm confirms.
//
//  1. validateImport(): parses and checks the file and stores every row with
//     its result. Nothing reaches the party index yet; the firm sees what
//     will be imported and what failed (line numbers and reasons).
//  2. commitImport(): indexes each valid row (party, name variants, address)
//     and records its matter or consultation in imported_matters /
//     imported_involvements, which every check searches like live history.
//     Each row runs in its own savepoint, so one bad row is reported as
//     'failed' instead of aborting the file. Same-person rows share a party;
//     look-alikes already in the index become merge suggestions (c56:
//     never merged automatically).
//  3. confirmHistoryImport() (settingsService.ts): the conflicts attorney
//     confirms the history is loaded; only then may checks come back clear.
//
// The audit trail records counts only; names stay in the restricted tables.

import { createHash } from "node:crypto";
import { and, asc, desc, eq } from "drizzle-orm";
import { conflictImportBatches, conflictImportRows, importedInvolvements, importedMatters } from "@/db/tables/conflict-check";
import { audit } from "@/core";
import type { TenantTx } from "@/tenancy/withTenant";
import { assertCan, type ConflictAccess } from "./access";
import { mergeMatterStatus, prepareImport, summarizeImport, type ImportRecord, type ImportSummary, type ValidatedRow } from "./historyImport";
import { indexParty } from "./partyIndex";
import { ENGINE } from "./settings";
import { actorFor, ConflictError } from "./util";

export type ImportBatchRow = typeof conflictImportBatches.$inferSelect;

export interface ImportReport {
  batch: ImportBatchRow;
  /** Full summary at validation time; later reports carry the counts on `batch`. */
  summary: ImportSummary | null;
  unknownHeaders: string[];
  /** Rows that failed validation or import (line, reasons). */
  problems: Array<{ lineNumber: number; status: string; errors: string[]; warnings: string[] }>;
}

function rowStatus(r: ValidatedRow): "valid" | "error" | "duplicate" {
  if (!r.record) return "error";
  if (r.duplicateOfLine !== null) return "duplicate";
  return "valid";
}

export async function validateImport(
  tx: TenantTx,
  input: { tenantId: string; filename: string; csv: string; columnMap?: Record<string, string>; access: ConflictAccess; now?: Date }
): Promise<ImportReport> {
  assertCan(input.access, "index.edit");
  const filename = input.filename.trim().slice(0, 200) || "import.csv";
  const sha256 = createHash("sha256").update(input.csv).digest("hex");
  const [already] = await tx
    .select({ id: conflictImportBatches.id })
    .from(conflictImportBatches)
    .where(and(eq(conflictImportBatches.tenantId, input.tenantId), eq(conflictImportBatches.sha256, sha256), eq(conflictImportBatches.status, "committed")))
    .limit(1);
  if (already) throw new ConflictError("This exact file was already imported.", 409, [`batch ${already.id}`]);

  const preview = prepareImport(input.csv, input.columnMap ?? {});
  if (preview.fatal.length > 0) throw new ConflictError("The file cannot be imported.", 422, preview.fatal);
  const summary = summarizeImport(preview.rows);

  const [batch] = await tx
    .insert(conflictImportBatches)
    .values({
      tenantId: input.tenantId,
      filename,
      status: "validated",
      columnMap: preview.mapping.described,
      totalRows: summary.totalRows,
      validRows: summary.validRows,
      errorRows: summary.errorRows,
      duplicateRows: summary.duplicateRows,
      sha256,
      uploadedByUserId: input.access.userId,
      createdAt: input.now ?? new Date(),
    })
    .returning();

  const CHUNK = 500;
  for (let i = 0; i < preview.rows.length; i += CHUNK) {
    await tx.insert(conflictImportRows).values(
      preview.rows.slice(i, i + CHUNK).map((r) => ({
        tenantId: input.tenantId,
        batchId: batch!.id,
        lineNumber: r.lineNumber,
        record: (r.record ?? {}) as unknown as Record<string, unknown>,
        status: rowStatus(r),
        errors: r.errors,
        warnings: r.warnings,
        duplicateOfLine: r.duplicateOfLine ?? r.samePersonAsLine,
      }))
    );
  }

  await audit(tx, {
    tenantId: input.tenantId,
    engine: ENGINE,
    action: "import.validated",
    entityType: "conflict_import_batch",
    entityId: batch!.id,
    actor: actorFor(input.access),
    payload: { ...summary, unknownHeaders: preview.mapping.unknownHeaders.length },
  });
  return {
    batch: batch!,
    summary,
    unknownHeaders: preview.mapping.unknownHeaders,
    problems: preview.rows
      .filter((r) => r.errors.length > 0 || r.warnings.length > 0)
      .map((r) => ({ lineNumber: r.lineNumber, status: rowStatus(r), errors: r.errors, warnings: r.warnings })),
  };
}

async function loadBatch(tx: TenantTx, tenantId: string, batchId: string): Promise<ImportBatchRow> {
  const [batch] = await tx
    .select()
    .from(conflictImportBatches)
    .where(and(eq(conflictImportBatches.tenantId, tenantId), eq(conflictImportBatches.id, batchId)))
    .limit(1);
  if (!batch) throw new ConflictError("Import not found.", 404);
  return batch;
}

async function upsertImportedMatter(tx: TenantTx, tenantId: string, batchId: string, r: ImportRecord): Promise<{ id: string; created: boolean }> {
  const [existing] = await tx
    .select()
    .from(importedMatters)
    .where(and(eq(importedMatters.tenantId, tenantId), eq(importedMatters.externalRef, r.matterRef)))
    .limit(1);
  if (existing) {
    const status = mergeMatterStatus(existing.status as ImportRecord["matterStatus"], r.matterStatus);
    // An engaged matter outranks a consultation with the same reference.
    const kind = existing.kind === "matter" || r.involvementKind === "matter" ? "matter" : "consultation";
    if (status !== existing.status || kind !== existing.kind) {
      await tx.update(importedMatters).set({ status, kind }).where(eq(importedMatters.id, existing.id));
    }
    return { id: existing.id, created: false };
  }
  const [row] = await tx
    .insert(importedMatters)
    .values({
      tenantId,
      batchId,
      externalRef: r.matterRef,
      kind: r.involvementKind,
      title: r.matterTitle,
      practiceArea: r.practiceArea,
      status: r.matterStatus,
      openedOn: r.openedOn,
      closedOn: r.closedOn,
    })
    .returning({ id: importedMatters.id });
  return { id: row!.id, created: true };
}

export async function commitImport(
  tx: TenantTx,
  input: { tenantId: string; batchId: string; access: ConflictAccess; now?: Date }
): Promise<ImportReport> {
  assertCan(input.access, "index.edit");
  const now = input.now ?? new Date();
  const batch = await loadBatch(tx, input.tenantId, input.batchId);
  if (batch.status !== "validated") throw new ConflictError(`This import is already ${batch.status}.`, 409);

  const rows = await tx
    .select()
    .from(conflictImportRows)
    .where(and(eq(conflictImportRows.tenantId, input.tenantId), eq(conflictImportRows.batchId, batch.id), eq(conflictImportRows.status, "valid")))
    .orderBy(asc(conflictImportRows.lineNumber));

  const partyByLine = new Map<number, string>();
  let partiesCreated = 0;
  let mattersCreated = 0;
  let mergeSuggestions = 0;
  let failed = 0;

  for (const row of rows) {
    const r = row.record as unknown as ImportRecord;
    try {
      // One savepoint per row: a failure is reported, not fatal to the file.
      const result = await tx.transaction(async (sp) => {
        const samePerson = row.duplicateOfLine !== null ? partyByLine.get(row.duplicateOfLine) : undefined;
        const indexed = await indexParty(sp as unknown as TenantTx, {
          tenantId: input.tenantId,
          name: r.name,
          kind: r.kind,
          dateOfBirth: r.dateOfBirth,
          email: r.email,
          phone: r.phone,
          address: r.address,
          variants: r.variants,
          source: "import",
          reusePartyId: samePerson ?? null,
          by: actorFor(input.access),
        });
        const matter = await upsertImportedMatter(sp as unknown as TenantTx, input.tenantId, batch.id, r);
        await sp
          .insert(importedInvolvements)
          .values({
            tenantId: input.tenantId,
            importedMatterId: matter.id,
            partyId: indexed.partyId,
            role: r.role,
            relationship: r.relationship,
            isAdverse: r.isAdverse,
          })
          .onConflictDoNothing();
        await sp.update(conflictImportRows).set({ status: "imported", partyId: indexed.partyId }).where(eq(conflictImportRows.id, row.id));
        return { indexed, matter };
      });
      partyByLine.set(row.lineNumber, result.indexed.partyId);
      if (result.indexed.created) partiesCreated++;
      if (result.matter.created) mattersCreated++;
      mergeSuggestions += result.indexed.suggestions;
    } catch (err) {
      failed++;
      const message = err instanceof ConflictError ? err.message : "The row could not be saved.";
      await tx.update(conflictImportRows).set({ status: "failed", errors: [...row.errors, message] }).where(eq(conflictImportRows.id, row.id));
    }
  }
  // A same-person row whose first row failed gets its own party (reported, never lost).
  await tx
    .update(conflictImportBatches)
    .set({ status: "committed", committedAt: now, committedByUserId: input.access.userId, partiesCreated, mattersCreated, mergeSuggestions })
    .where(eq(conflictImportBatches.id, batch.id));

  await audit(tx, {
    tenantId: input.tenantId,
    engine: ENGINE,
    action: "import.committed",
    entityType: "conflict_import_batch",
    entityId: batch.id,
    actor: actorFor(input.access),
    payload: { imported: rows.length - failed, failed, partiesCreated, mattersCreated, mergeSuggestions },
  });
  return getImportReport(tx, { tenantId: input.tenantId, batchId: batch.id, access: input.access });
}

export async function discardImport(tx: TenantTx, input: { tenantId: string; batchId: string; access: ConflictAccess; now?: Date }) {
  assertCan(input.access, "index.edit");
  const batch = await loadBatch(tx, input.tenantId, input.batchId);
  if (batch.status !== "validated") throw new ConflictError("Only an import that has not been committed can be discarded.", 409);
  const [row] = await tx
    .update(conflictImportBatches)
    .set({ status: "discarded", discardedAt: input.now ?? new Date() })
    .where(eq(conflictImportBatches.id, batch.id))
    .returning();
  await audit(tx, {
    tenantId: input.tenantId,
    engine: ENGINE,
    action: "import.discarded",
    entityType: "conflict_import_batch",
    entityId: batch.id,
    actor: actorFor(input.access),
  });
  return row!;
}

/** The report: counts for anyone with health access; failed rows' reasons for the conflicts role. */
export async function getImportReport(tx: TenantTx, input: { tenantId: string; batchId: string; access: ConflictAccess }): Promise<ImportReport> {
  assertCan(input.access, "health.view");
  const batch = await loadBatch(tx, input.tenantId, input.batchId);
  const canSeeRows = input.access.caps.has("index.edit");
  const rows = canSeeRows
    ? await tx
        .select({ lineNumber: conflictImportRows.lineNumber, status: conflictImportRows.status, errors: conflictImportRows.errors, warnings: conflictImportRows.warnings })
        .from(conflictImportRows)
        .where(and(eq(conflictImportRows.tenantId, input.tenantId), eq(conflictImportRows.batchId, batch.id)))
        .orderBy(asc(conflictImportRows.lineNumber))
    : [];
  return {
    batch,
    summary: null,
    unknownHeaders: [],
    problems: rows.filter((r) => r.errors.length > 0 || r.warnings.length > 0 || r.status === "failed"),
  };
}

export async function listImports(tx: TenantTx, tenantId: string, access: ConflictAccess): Promise<ImportBatchRow[]> {
  assertCan(access, "health.view");
  return tx
    .select()
    .from(conflictImportBatches)
    .where(eq(conflictImportBatches.tenantId, tenantId))
    .orderBy(desc(conflictImportBatches.createdAt))
    .limit(100);
}

/** Has the firm committed at least one import? (c96: needed before confirming, unless it attests it has no history.) */
export async function hasCommittedImport(tx: TenantTx, tenantId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: conflictImportBatches.id })
    .from(conflictImportBatches)
    .where(and(eq(conflictImportBatches.tenantId, tenantId), eq(conflictImportBatches.status, "committed")))
    .limit(1);
  return !!row;
}
