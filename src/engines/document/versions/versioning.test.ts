import { describe, expect, it } from "vitest";
import {
  checkUpload,
  checksumsMatch,
  planVersion,
  sanitizeFilename,
  sha256Hex,
  sniffMimeType,
  storageKeyFor,
  titleFromFilename,
} from "./versioning";

const enc = (s: string) => new TextEncoder().encode(s);
const policy = { maxUploadBytes: 1024, allowedMimeTypes: ["application/pdf", "text/plain", "image/png"] };
const UUID = "11111111-2222-3333-4444-555555555555";

describe("checksums", () => {
  it("computes a known SHA-256", () => {
    expect(sha256Hex(enc("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  it("compares digests safely", () => {
    const a = sha256Hex(enc("x"));
    expect(checksumsMatch(a, a)).toBe(true);
    expect(checksumsMatch(a, sha256Hex(enc("y")))).toBe(false);
    expect(checksumsMatch(a, "nope")).toBe(false);
  });
});

describe("sniffMimeType", () => {
  it("recognises common legal-file types from their bytes", () => {
    expect(sniffMimeType(enc("%PDF-1.7\n..."))).toBe("application/pdf");
    expect(sniffMimeType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe("image/jpeg");
    expect(sniffMimeType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe("image/png");
    expect(sniffMimeType(enc("{\\rtf1 hello}"))).toBe("application/rtf");
    expect(sniffMimeType(enc("<!DOCTYPE html><p>x"))).toBe("text/html");
    expect(sniffMimeType(enc("Plain words"))).toBe("text/plain");
    expect(sniffMimeType(enc("a,b\n1,2"), "text/csv")).toBe("text/csv");
    expect(sniffMimeType(enc("From: a@b.c\nSubject: x"), null, "mail.eml")).toBe("message/rfc822");
  });
  it("identifies DOCX inside a zip", () => {
    const fake = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...enc("....word/document.xml....")]);
    expect(sniffMimeType(fake)).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  });
  it("sees through a lying declared type", () => {
    expect(sniffMimeType(new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03]), "application/pdf")).toBe("application/x-msdownload");
  });
  it("returns null for unknown binary", () => {
    expect(sniffMimeType(new Uint8Array([0x00, 0x01, 0x02, 0x03, 0xfe]))).toBeNull();
  });
});

describe("sanitizeFilename", () => {
  it("strips paths, control and reserved characters", () => {
    expect(sanitizeFilename("C:\\Users\\x\\Final Decree.pdf")).toBe("Final Decree.pdf");
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("a<b>:c|d?.pdf")).toBe("abcd.pdf");
    expect(sanitizeFilename("...hidden")).toBe("hidden");
    expect(sanitizeFilename("")).toBe("Untitled");
    expect(sanitizeFilename(null)).toBe("Untitled");
  });
  it("caps length but keeps the extension", () => {
    const n = sanitizeFilename("x".repeat(400) + ".pdf");
    expect(n.length).toBe(180);
    expect(n.endsWith(".pdf")).toBe(true);
  });
});

describe("checkUpload", () => {
  it("accepts an allowed file and reports size, hash and real type", () => {
    const r = checkUpload({ bytes: enc("%PDF-1.4 x"), filename: "a.pdf", declaredMimeType: "application/pdf" }, policy);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.detectedMimeType).toBe("application/pdf");
      expect(r.sizeBytes).toBe(10);
      expect(r.mismatchWarning).toBeNull();
    }
  });
  it("warns when the declared type is wrong but the real type is allowed", () => {
    const r = checkUpload({ bytes: enc("%PDF-1.4 x"), filename: "a.txt", declaredMimeType: "text/plain" }, policy);
    expect(r.ok && r.mismatchWarning).toContain("does not match");
  });
  it("refuses empty, oversize, disallowed, unknown and damaged files", () => {
    expect(checkUpload({ bytes: new Uint8Array(), filename: "a", declaredMimeType: null }, policy)).toMatchObject({ ok: false, code: "empty" });
    expect(checkUpload({ bytes: new Uint8Array(2000).fill(65), filename: "a", declaredMimeType: null }, policy)).toMatchObject({
      ok: false,
      code: "too_large",
    });
    expect(checkUpload({ bytes: new Uint8Array([0x4d, 0x5a, 1, 2]), filename: "x.pdf", declaredMimeType: "application/pdf" }, policy)).toMatchObject({
      ok: false,
      code: "type_not_allowed",
    });
    expect(checkUpload({ bytes: new Uint8Array([0, 1, 2, 0xfe]), filename: "x", declaredMimeType: null }, policy)).toMatchObject({
      ok: false,
      code: "unknown_type",
    });
    expect(
      checkUpload({ bytes: enc("hello"), filename: "a.txt", declaredMimeType: "text/plain", expectedSha256: sha256Hex(enc("other")) }, policy)
    ).toMatchObject({ ok: false, code: "checksum_mismatch" });
  });
  it("accepts a matching expected checksum in any case", () => {
    const r = checkUpload({ bytes: enc("hello"), filename: "a.txt", declaredMimeType: null, expectedSha256: sha256Hex(enc("hello")).toUpperCase() }, policy);
    expect(r.ok).toBe(true);
  });
});

describe("planVersion", () => {
  const sha = sha256Hex(enc("v1"));
  it("starts a new group", () => {
    expect(planVersion(null, sha)).toEqual({ kind: "new_group", version: 1 });
  });
  it("never creates a duplicate of the current version", () => {
    expect(planVersion({ groupDocumentId: UUID, latestVersion: 3, currentSha256: sha, currentStatus: "draft" }, sha)).toEqual({
      kind: "identical_to_current",
    });
  });
  it("adds latest+1 and supersedes the previous one unless it was filed", () => {
    const other = sha256Hex(enc("v2"));
    expect(planVersion({ groupDocumentId: UUID, latestVersion: 3, currentSha256: sha, currentStatus: "attorney_approved" }, other)).toEqual({
      kind: "new_version",
      version: 4,
      supersedePrevious: true,
    });
    expect(planVersion({ groupDocumentId: UUID, latestVersion: 1, currentSha256: sha, currentStatus: "filed" }, other)).toMatchObject({
      supersedePrevious: false,
    });
  });
});

describe("storageKeyFor", () => {
  it("builds an opaque key from ids only", () => {
    expect(storageKeyFor({ tenantId: UUID, matterId: UUID, groupId: UUID, version: 2, objectId: UUID })).toBe(
      `t/${UUID}/m/${UUID}/g/${UUID}/v2-${UUID}`
    );
  });
  it("refuses anything that is not an id", () => {
    expect(() => storageKeyFor({ tenantId: "../x", matterId: UUID, groupId: UUID, version: 1, objectId: UUID })).toThrow();
    expect(() => storageKeyFor({ tenantId: UUID, matterId: UUID, groupId: UUID, version: 0, objectId: UUID })).toThrow();
  });
});

describe("titleFromFilename", () => {
  it("drops the extension", () => {
    expect(titleFromFilename("Final Decree.pdf")).toBe("Final Decree");
    expect(titleFromFilename("README")).toBe("README");
  });
});
