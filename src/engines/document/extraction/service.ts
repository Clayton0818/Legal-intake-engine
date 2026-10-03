// Text indexing (c84): extract text from a stored version and write it to
// document_text, whose generated search_vector feeds full-text search.
// Runs inline for small uploads and from the worker for the backlog. OCR is a
// vendor call: it only runs through the gated OCR adapter, and while the
// gate is pending scanned files stay 'ocr_pending' (blocked attempts logged).

import { and, asc, eq, inArray, lt } from "drizzle-orm";
import { documents } from "@/db/schema";
import { documentText, documentVersionFiles } from "@/db/tables/document";
import { PendingApprovalError, isApproved } from "@/compliance/approvals";
import { auditBlocked } from "@/core";
import type { TenantTx } from "@/tenancy/withTenant";
import { ENGINE, type DocumentSettings } from "../settings";
import { STORAGE_VENDOR_GATE, StubOcrAdapter, gatedAdapters, getDocumentAdapters, type DocumentAdapters } from "../storage/adapters";
import { checksumsMatch, sha256Hex } from "../versions/versioning";
import { extractText, finalizeText } from "./extract";

export type IndexOutcome = "extracted" | "ocr_pending" | "unsupported" | "failed" | "blocked" | "skipped";

/** Extract (or OCR) one version's text and store it. Never throws for content problems. */
export async function indexVersionText(
  tx: TenantTx,
  tenantId: string,
  documentId: string,
  settings: DocumentSettings,
  opts: { adapters?: DocumentAdapters; bytes?: Uint8Array; allowOcr?: boolean; now?: Date } = {}
): Promise<IndexOutcome> {
  const now = opts.now ?? new Date();
  const [row] = await tx
    .select({ text: documentText, file: documentVersionFiles, mimeType: documents.mimeType })
    .from(documentText)
    .innerJoin(documentVersionFiles, and(eq(documentVersionFiles.tenantId, tenantId), eq(documentVersionFiles.documentId, documentText.documentId)))
    .innerJoin(documents, eq(documents.id, documentText.documentId))
    .where(and(eq(documentText.tenantId, tenantId), eq(documentText.documentId, documentId)))
    .limit(1);
  if (!row) return "skipped";
  const { text, file } = row;
  if (file.scanStatus === "infected") {
    await tx.update(documentText).set({ status: "blocked", detail: "Quarantined file: not indexed.", content: "" }).where(eq(documentText.id, text.id));
    return "blocked";
  }
  if (text.status === "extracted" || text.status === "unsupported") return "skipped";

  const adapters = gatedAdapters(tenantId, opts.adapters);
  const write = (set: Partial<typeof documentText.$inferInsert>) =>
    tx
      .update(documentText)
      .set({ attempts: text.attempts + 1, ...set })
      .where(eq(documentText.id, text.id));

  let bytes = opts.bytes;
  try {
    bytes ??= await adapters.storage.get(file.storageKey);
  } catch (err) {
    if (err instanceof PendingApprovalError) {
      await auditBlocked(tx, err, { tenantId, engine: ENGINE, entityType: "document", entityId: documentId });
      return "skipped";
    }
    await write({ status: text.attempts + 1 >= settings.extractionMaxAttempts ? "failed" : "pending", detail: `Could not read file: ${(err as Error).message}` });
    return "failed";
  }
  if (!checksumsMatch(sha256Hex(bytes), file.sha256)) {
    await write({ status: "failed", detail: "Stored file does not match its checksum." });
    return "failed";
  }

  const mime = file.detectedMimeType ?? row.mimeType ?? "application/octet-stream";
  const result = text.status === "ocr_pending" ? ({ status: "needs_ocr", pageCount: text.pageCount, detail: "" } as const) : extractText(bytes, mime);

  if (result.status === "extracted") {
    const { text: content, truncated } = finalizeText(result.text, settings.maxIndexedChars);
    await write({ status: "extracted", method: "native", content, truncated, pageCount: result.pageCount, extractedAt: now, detail: null });
    return "extracted";
  }
  if (result.status === "needs_ocr") {
    if (!opts.allowOcr) {
      await write({ status: "ocr_pending", pageCount: result.pageCount, detail: result.detail || "Waiting for text recognition." });
      return "ocr_pending";
    }
    try {
      const ocr = await adapters.ocr.recognize(bytes, mime);
      if (ocr.status === "ok") {
        const { text: content, truncated } = finalizeText(ocr.text, settings.maxIndexedChars);
        await write({ status: "extracted", method: "ocr", content, truncated, pageCount: ocr.pageCount ?? result.pageCount, extractedAt: now, detail: null });
        return "extracted";
      }
      await tx.update(documentText).set({ status: "ocr_pending", pageCount: result.pageCount, detail: ocr.detail }).where(eq(documentText.id, text.id));
      return "ocr_pending";
    } catch (err) {
      if (err instanceof PendingApprovalError) {
        await auditBlocked(tx, err, { tenantId, engine: ENGINE, entityType: "document", entityId: documentId });
        await tx.update(documentText).set({ status: "ocr_pending", detail: err.placeholder }).where(eq(documentText.id, text.id));
        return "ocr_pending";
      }
      await write({ status: text.attempts + 1 >= settings.extractionMaxAttempts ? "failed" : "ocr_pending", detail: (err as Error).message });
      return "failed";
    }
  }
  await write({ status: result.status, detail: result.detail });
  return result.status;
}

/** Worker: index pending versions (and retry OCR for scanned ones). */
export async function processTextBacklog(
  tx: TenantTx,
  tenantId: string,
  settings: DocumentSettings,
  opts: { adapters?: DocumentAdapters; now?: Date } = {}
): Promise<Record<IndexOutcome, number>> {
  // Only retry scanned files when a real OCR service is wired AND its gate is open;
  // otherwise they wait quietly instead of being re-read (and re-logged) every tick.
  const ocr = opts.adapters?.ocr ?? getDocumentAdapters().ocr;
  const ocrReady = !(ocr instanceof StubOcrAdapter) && (ocr.kind === "internal" || isApproved(STORAGE_VENDOR_GATE));
  const statuses = ocrReady ? ["pending", "ocr_pending"] : ["pending"];
  const rows = await tx
    .select({ documentId: documentText.documentId })
    .from(documentText)
    .where(
      and(
        eq(documentText.tenantId, tenantId),
        inArray(documentText.status, statuses),
        lt(documentText.attempts, settings.extractionMaxAttempts)
      )
    )
    .orderBy(asc(documentText.createdAt))
    .limit(settings.extractionBatchSize);
  const counts: Record<IndexOutcome, number> = { extracted: 0, ocr_pending: 0, unsupported: 0, failed: 0, blocked: 0, skipped: 0 };
  for (const r of rows) {
    counts[await indexVersionText(tx, tenantId, r.documentId, settings, { ...opts, allowOcr: true })]++;
  }
  return counts;
}
