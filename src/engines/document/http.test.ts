import { describe, expect, it } from "vitest";
import { PendingApprovalError, gateStatus } from "@/compliance/approvals";
import { DocumentAccessDeniedError, DocumentError } from "./errors";
import { assertUuidParam, bool, contentDisposition, mapHandledError, readJson, readUpload, str, uuidOrNull } from "./http";
import "./gates";

const ID = "11111111-2222-4333-8444-555555555555";

describe("mapHandledError", () => {
  it("maps pending approvals to 423 with the placeholder", () => {
    const err = new PendingApprovalError(gateStatus("vendor.object_storage"), "document.storage.put");
    expect(mapHandledError(err)).toMatchObject({ status: 423, body: { error: "pending_approval", gate: "vendor.object_storage" } });
  });
  it("never reveals why access was denied", () => {
    const m = mapHandledError(new DocumentAccessDeniedError("screened"));
    expect(m).toEqual({ status: 403, body: { error: "You do not have access to this document." } });
    expect(JSON.stringify(m)).not.toContain("screened");
  });
  it("passes validation details through", () => {
    expect(mapHandledError(new DocumentError("Bad", 422, { errors: ["x"] }))).toEqual({ status: 422, body: { error: "Bad", details: { errors: ["x"] } } });
    expect(mapHandledError(new Error("boom"))).toBeNull();
  });
});

describe("body helpers", () => {
  it("reads and validates JSON", async () => {
    const body = await readJson(new Request("http://x", { method: "POST", body: JSON.stringify({ a: "x", id: ID, b: true }) }));
    expect(str(body, "a")).toBe("x");
    expect(uuidOrNull(body, "id")).toBe(ID);
    expect(bool(body, "b")).toBe(true);
    expect(str(body, "missing")).toBeNull();
    expect(() => str(body, "missing", { required: true })).toThrow("required");
    expect(() => uuidOrNull({ id: "nope" }, "id")).toThrow();
    expect(() => bool({ b: "yes" }, "b")).toThrow();
    await expect(readJson(new Request("http://x", { method: "POST", body: "[1]" }))).rejects.toThrow("object");
    await expect(readJson(new Request("http://x", { method: "POST", body: "{" }))).rejects.toThrow("JSON");
  });
  it("checks uuid params", () => {
    expect(assertUuidParam(ID, "id")).toBe(ID);
    expect(() => assertUuidParam("../x", "id")).toThrow(DocumentError);
  });
});

describe("readUpload", () => {
  it("reads the file and the text fields", async () => {
    const form = new FormData();
    form.set("file", new File([new TextEncoder().encode("hello")], "a.txt", { type: "text/plain" }));
    form.set("documentType", "letter");
    const up = await readUpload(new Request("http://x", { method: "POST", body: form }), 1000);
    expect(Buffer.from(up.bytes).toString()).toBe("hello");
    expect(up).toMatchObject({ filename: "a.txt", declaredMimeType: "text/plain", fields: { documentType: "letter" } });
  });
  it("refuses non-multipart, missing file and oversize bodies", async () => {
    await expect(readUpload(new Request("http://x", { method: "POST", body: "x", headers: { "content-type": "text/plain" } }), 10)).rejects.toMatchObject({ status: 415 });
    const form = new FormData();
    form.set("other", "x");
    await expect(readUpload(new Request("http://x", { method: "POST", body: form }), 1000)).rejects.toMatchObject({ status: 422 });
    await expect(
      readUpload(new Request("http://x", { method: "POST", body: "x", headers: { "content-type": "multipart/form-data; boundary=x", "content-length": "999999999" } }), 10)
    ).rejects.toMatchObject({ status: 413 });
  });
});

describe("contentDisposition", () => {
  it("keeps non-ASCII names safe", () => {
    expect(contentDisposition('Décret "final".pdf')).toBe(`attachment; filename="D_cret _final_.pdf"; filename*=UTF-8''D%C3%A9cret%20%22final%22.pdf`);
  });
});
