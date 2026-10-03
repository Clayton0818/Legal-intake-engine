import { describe, expect, it } from "vitest";
import { buildRegistry } from "@/worker/hooks";
import { worker } from "./worker";
import { buildAccessLogRow } from "./access/service";
import { readDocumentSettings, DEFAULT_DOCUMENT_SETTINGS } from "./settings";
import { DOCUMENT_GATE_KEYS } from "./gates";
import { gateStatus } from "@/compliance/approvals";

describe("document worker module", () => {
  it("registers prefixed tick hooks", () => {
    expect(worker.tickHooks!.map((h) => h.name)).toEqual(["document.provision_folders", "document.index_text"]);
    const reg = buildRegistry([{ slug: "document", module: worker }]);
    expect(reg.hooks.map((h) => h.name)).toEqual(expect.arrayContaining(["document.provision_folders", "document.index_text"]));
  });
});

describe("gates", () => {
  it("every gate the engine lists is defined and pending by default", () => {
    for (const key of DOCUMENT_GATE_KEYS) expect(gateStatus(key).approved).toBe(false);
    expect(DOCUMENT_GATE_KEYS).toEqual(expect.arrayContaining(["vendor.object_storage", "rules.retention_periods", "copy.document.upload_rejected"]));
  });
});

describe("settings", () => {
  it("uses defaults and ignores invalid firm values", () => {
    expect(readDocumentSettings({ engineSettings: {} })).toEqual({ ...DEFAULT_DOCUMENT_SETTINGS });
    const s = readDocumentSettings({
      engineSettings: {
        document: { maxUploadBytes: -5, allowedMimeTypes: ["application/pdf"], restrictedTags: { sealed: ["attorney"], bogus: ["x"] }, staffMayDownloadUnscanned: "yes" },
      },
    });
    expect(s.maxUploadBytes).toBe(DEFAULT_DOCUMENT_SETTINGS.maxUploadBytes);
    expect(s.allowedMimeTypes).toEqual(["application/pdf"]);
    expect(s.restrictedTags).toEqual({ sealed: ["attorney"] });
    expect(s.staffMayDownloadUnscanned).toBe(true);
  });
});

describe("access log rows", () => {
  it("records who, what and why", () => {
    const row = buildAccessLogRow({
      tenantId: "t",
      viewer: { kind: "staff", userId: "u", role: "attorney", permissions: [] },
      action: "download",
      outcome: "denied",
      reason: "screened",
      documentId: "d",
      matterId: "m",
    });
    expect(row).toMatchObject({ actorType: "user", actorUserId: "u", actorPartyId: null, action: "download", outcome: "denied", reason: "screened" });
    expect(buildAccessLogRow({ tenantId: "t", viewer: { kind: "client", partyId: "p", matterIds: [] }, action: "view", outcome: "allowed" })).toMatchObject({
      actorType: "client",
      actorPartyId: "p",
    });
    expect(buildAccessLogRow({ tenantId: "t", viewer: { kind: "staff", userId: null, role: "firm_admin", permissions: [] }, action: "list", outcome: "allowed" }).actorType).toBe("system");
  });
  it("refuses a denial without a reason", () => {
    expect(() => buildAccessLogRow({ tenantId: "t", viewer: { kind: "staff", userId: "u", role: "x", permissions: [] }, action: "view", outcome: "denied" })).toThrow();
  });
});
