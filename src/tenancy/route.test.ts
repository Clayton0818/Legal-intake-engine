import { describe, it, expect, vi } from "vitest";
import { errorResponse, HttpError } from "./route";
import { defineGate, requireApproval, resetApprovalStateForTests, setBlockedActionSink } from "@/compliance/approvals";

const GATE = defineGate({ key: "test.route.gate", cardIds: [], reviewers: ["cpa"], description: "Route test gate" });

describe("errorResponse", () => {
  it("maps a pending approval to 423 with the visible placeholder", async () => {
    resetApprovalStateForTests();
    setBlockedActionSink(() => {});
    let err: unknown;
    try {
      requireApproval(GATE.key);
    } catch (e) {
      err = e;
    }
    const res = errorResponse("test", err);
    expect(res.status).toBe(423);
    expect(await res.json()).toEqual({
      error: "pending_approval",
      gate: "test.route.gate",
      pendingReviewers: ["cpa"],
      message: "[PENDING CPA REVIEW — Route test gate (gate: test.route.gate)]",
    });
  });

  it("passes HttpError through and hides other errors", async () => {
    expect(errorResponse("t", new HttpError(404, "Not found")).status).toBe(404);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = errorResponse("t", new Error("db exploded: password=secret"));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("secret");
    spy.mockRestore();
  });
});
