// End-to-end check of the c84 document store against a REAL Postgres:
// folder provisioning, upload + versioning (never overwritten), checksum-
// verified download, full-text search with a screen, and the access log.
//
// Skipped without DATABASE_URL, and until the integration migration has
// created this engine's tables. Runs in ONE transaction that is rolled back
// (document_access_log is append-only for app_runtime).

import { it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { describeWithDb, loadDb } from "@/tenancy/testing";
import type { TenantTx } from "@/tenancy/withTenant";
import { firms, matters, parties, users } from "@/db/schema";
import { DEFAULT_DOCUMENT_SETTINGS } from "./settings";
import { MemoryStorageAdapter, StubMalwareScanner, StubOcrAdapter } from "./storage/adapters";
import { addAccessBlock, listAccessLog, loadAccess } from "./access/service";
import { provisionMatterFolders, folderByKey } from "./folders/service";
import { downloadDocument, getDocumentDetail, listMatterDocuments, uploadDocument } from "./store/service";
import { runSearch } from "./search/service";
import { DocumentAccessDeniedError } from "./errors";
import type { StaffViewer } from "./access/policy";

class Rollback extends Error {}

const enc = (s: string) => new TextEncoder().encode(s);

describeWithDb("document store (c84) against Postgres", () => {
  it("folders, versions, download, search, screens and access log in one rolled-back transaction", async (ctx) => {
    const { rawDb } = await loadDb();
    const probe = (await rawDb.execute(sql`select to_regclass('public.document_text') as t`)) as unknown as { t: string | null }[];
    if (!probe[0]?.t) ctx.skip();

    try {
      await rawDb.transaction(async (raw) => {
        const [firm] = await raw.insert(firms).values({ name: "Doc Test Firm", slug: `doc-test-${Date.now()}` }).returning({ id: firms.id });
        const tenantId = firm!.id;
        await raw.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
        const tx = raw as unknown as TenantTx;

        const [lawyerRow] = await tx.insert(users).values({ tenantId, email: "l@doc.example", displayName: "Lee", role: "attorney" }).returning({ id: users.id });
        const [otherRow] = await tx.insert(users).values({ tenantId, email: "o@doc.example", displayName: "Oli", role: "attorney" }).returning({ id: users.id });
        const [client] = await tx.insert(parties).values({ tenantId, fullName: "Ana", normalizedName: "ana" }).returning({ id: parties.id });
        const [matter] = await tx.insert(matters).values({ tenantId, primaryPartyId: client!.id, practiceArea: "family" }).returning({ id: matters.id });
        const perms = ["documents.read", "documents.write", "documents.approve"];
        const lawyer: StaffViewer = { kind: "staff", userId: lawyerRow!.id, role: "attorney", permissions: perms };
        const other: StaffViewer = { kind: "staff", userId: otherRow!.id, role: "attorney", permissions: perms };
        const adapters = { storage: new MemoryStorageAdapter(), scanner: new StubMalwareScanner(), ocr: new StubOcrAdapter() };

        expect((await provisionMatterFolders(tx, tenantId, matter!.id)).created).toBeGreaterThan(0);
        expect((await provisionMatterFolders(tx, tenantId, matter!.id)).created).toBe(0);
        const email = await folderByKey(tx, tenantId, matter!.id, "email");
        expect(email).not.toBeNull();

        const { access } = await loadAccess(tx, tenantId, lawyer);
        const c = { tenantId, viewer: lawyer, access, settings: DEFAULT_DOCUMENT_SETTINGS, adapters };
        const v1 = await uploadDocument(tx, c, {
          matterId: matter!.id,
          folderId: email!.id,
          bytes: enc("Temporary orders hearing set for custody of the child."),
          filename: "orders.txt",
          declaredMimeType: "text/plain",
          documentType: "letter",
        });
        expect(v1).toMatchObject({ created: true, version: 1, textStatus: "extracted", scanStatus: "not_scanned" });
        const same = await uploadDocument(tx, c, { matterId: matter!.id, groupId: v1.groupId, bytes: enc("Temporary orders hearing set for custody of the child."), filename: "orders.txt", declaredMimeType: "text/plain" });
        expect(same.created).toBe(false);
        const v2 = await uploadDocument(tx, c, { matterId: matter!.id, groupId: v1.groupId, bytes: enc("Amended: mediation instead of a hearing."), filename: "orders.txt", declaredMimeType: "text/plain" });
        expect(v2).toMatchObject({ created: true, version: 2, groupId: v1.groupId });

        const detail = await getDocumentDetail(tx, c, v2.documentId);
        expect(detail.versions.map((v) => [v.version, v.status, v.isCurrent])).toEqual([
          [2, "uploaded", true],
          [1, "superseded", false],
        ]);
        const dl = await downloadDocument(tx, c, v1.documentId);
        expect(Buffer.from(dl.bytes).toString()).toContain("Temporary orders");

        expect((await runSearch(tx, c, { text: "mediation" })).results.map((r) => r.documentId)).toEqual([v2.documentId]);
        expect((await runSearch(tx, c, { text: "custody" })).results).toEqual([]); // old version only
        expect((await runSearch(tx, c, { text: "custody", allVersions: true })).results.map((r) => r.documentId)).toEqual([v1.documentId]);

        await addAccessBlock(tx, tenantId, lawyer, { userId: other.userId!, matterId: matter!.id, reason: "ethical_screen" });
        const screened = await loadAccess(tx, tenantId, other);
        const oc = { ...c, viewer: other, access: screened.access };
        expect((await runSearch(tx, oc, { text: "mediation" })).results).toEqual([]);
        await expect(listMatterDocuments(tx, oc, matter!.id)).rejects.toBeInstanceOf(DocumentAccessDeniedError);
        await expect(downloadDocument(tx, oc, v2.documentId)).rejects.toBeInstanceOf(DocumentAccessDeniedError);

        const log = await listAccessLog(tx, tenantId, { matterId: matter!.id });
        expect(log.some((l) => l.action === "download" && l.outcome === "allowed")).toBe(true);
        expect(log.some((l) => l.action === "download" && l.outcome === "denied" && l.reason === "screened")).toBe(true);
        expect(log.some((l) => l.action === "list" && l.outcome === "denied")).toBe(true);

        throw new Rollback();
      });
    } catch (err) {
      if (!(err instanceof Rollback)) throw err;
    }
  });
});
