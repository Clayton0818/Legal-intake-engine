import { afterEach, describe, it, expect } from "vitest";
import { resetApprovalStateForTests } from "@/compliance/approvals";
import { approveGates } from "../__tests__/fixtures";
import "../gates";
import { deriveConflictStatus, isConflictCleared } from "./conflictStatus";
import { decideReply, vendorGateFor } from "./conversation";
import { StubCalendarSyncProvider } from "./calendarSync";

afterEach(() => resetApprovalStateForTests());

describe("conflict status adapter (intake never decides a conflict)", () => {
  const base = { id: "r", resolvedAt: null, resolvedByUserId: null, createdAt: new Date("2026-10-01") };
  it("derives the intake view from the latest result", () => {
    expect(deriveConflictStatus(undefined).state).toBe("none");
    expect(deriveConflictStatus({ ...base, outcome: "clear" }).state).toBe("clear");
    expect(deriveConflictStatus({ ...base, outcome: "possible" }).state).toBe("possible_pending");
    expect(deriveConflictStatus({ ...base, outcome: "possible", resolvedAt: new Date(), resolvedByUserId: "u" }).state).toBe("attorney_cleared");
    expect(deriveConflictStatus({ ...base, outcome: "definite" }).state).toBe("definite");
    expect(deriveConflictStatus({ ...base, outcome: "clear" }, "declined_conflict").state).toBe("declined");
    expect(isConflictCleared({ state: "attorney_cleared" })).toBe(true);
    expect(isConflictCleared({ state: "possible_pending" })).toBe(false);
  });
});

describe("conversation replies (vendor + TCPA gates)", () => {
  const args = { copyApproved: true, smsOptIn: true, safetySuppressed: false };
  it("in-page channels always show (placeholder until approved)", () => {
    expect(decideReply({ ...args, channel: "web_chat", copyApproved: false })).toEqual({ mode: "show" });
  });

  it("vendor channels hold until the wording and the vendor are approved", () => {
    expect(decideReply({ ...args, channel: "sms", copyApproved: false })).toMatchObject({ mode: "hold" });
    expect(decideReply({ ...args, channel: "sms" })).toMatchObject({ mode: "hold", reason: expect.stringMatching(/vendor.sms/) });
    approveGates("vendor.sms");
    expect(decideReply({ ...args, channel: "sms" })).toEqual({ mode: "send" });
    expect(decideReply({ ...args, channel: "sms", smsOptIn: false })).toMatchObject({ mode: "hold", reason: expect.stringMatching(/TCPA/) });
  });

  it("safety flag without a safe contact holds everything except the safety replies", () => {
    approveGates("vendor.voice");
    expect(decideReply({ ...args, channel: "phone_ai", safetySuppressed: true })).toMatchObject({ mode: "hold" });
    expect(decideReply({ ...args, channel: "phone_ai", safetySuppressed: true, isSafetyReply: true })).toEqual({ mode: "send" });
    expect(vendorGateFor("web_form")).toBeNull();
  });

  it("the calendar stub records and never fetches", async () => {
    const stub = new StubCalendarSyncProvider();
    const r = await stub.fetchFreeBusy({ userId: "u", provider: "google", tokenRef: null }, new Date(0), new Date(1));
    expect(r.outcome).toBe("held");
    expect(stub.recorded).toHaveLength(1);
  });
});
