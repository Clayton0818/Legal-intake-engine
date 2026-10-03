import { describe, expect, it } from "vitest";
import { PendingApprovalError, defineGate, gateStatus, resetApprovalStateForTests } from "@/compliance/approvals";
import { PermissionDeniedError } from "../permissions/policy";
import { isUuid, optString, readBody, reqBool, reqString, reqStringList, reqUuid } from "./body";
import { AllEnginesError, mapHandledError } from "./errors";

const json = (body: unknown) => new Request("http://x", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });

describe("body readers", () => {
  it("reads JSON objects only", async () => {
    await expect(readBody(json({ a: 1 }))).resolves.toEqual({ a: 1 });
    await expect(readBody(json("nope"))).rejects.toMatchObject({ status: 400 });
    await expect(readBody(json([1]))).rejects.toMatchObject({ status: 400 });
  });

  it("validates fields", () => {
    expect(reqString({ a: " x " }, "a")).toBe("x");
    expect(() => reqString({ a: " " }, "a")).toThrow(AllEnginesError);
    expect(optString({}, "a")).toBeNull();
    expect(optString({ a: " " }, "a")).toBeNull();
    expect(() => optString({ a: 1 }, "a")).toThrow(/text/);
    const id = "00000000-0000-4000-8000-000000000001";
    expect(isUuid(id)).toBe(true);
    expect(reqUuid({ a: id }, "a")).toBe(id);
    expect(() => reqUuid({ a: "x" }, "a")).toThrow(/id/);
    expect(reqStringList({ a: ["x"] }, "a")).toEqual(["x"]);
    expect(() => reqStringList({ a: [1] }, "a")).toThrow(/list/);
    expect(reqBool({ a: false }, "a")).toBe(false);
    expect(() => reqBool({ a: "no" }, "a")).toThrow(/true or false/);
  });
});

describe("mapHandledError", () => {
  it("maps known errors and leaves the rest", () => {
    resetApprovalStateForTests();
    defineGate({ key: "rules.all-engines.test_only_gate", cardIds: ["c99"], reviewers: ["attorney"], description: "test" });
    const pending = new PendingApprovalError(gateStatus("rules.all-engines.test_only_gate"), "x");
    expect(mapHandledError(pending)?.status).toBe(423);
    expect(mapHandledError(new PermissionDeniedError({ allowed: false, right: "trust.reconcile", reason: "role_lacks_right" }))).toMatchObject({ status: 403, body: { right: "trust.reconcile" } });
    expect(mapHandledError(new AllEnginesError("bad", 409, ["d"]))).toEqual({ status: 409, body: { error: "bad", details: ["d"] } });
    expect(mapHandledError(new Error("boom"))).toBeNull();
  });
});
