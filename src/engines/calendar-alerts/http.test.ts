import { describe, expect, it } from "vitest";
import { requireApproval } from "@/compliance/approvals";
import { VENDOR_GATES } from "@/compliance/gates";
import { AlertRuleError } from "./common";
import { mapHandledError, oneOf, parseInboundCourtEmail, reqString } from "./http";

describe("calendar-alerts http helpers", () => {
  it("maps pending approvals to 423 with the visible placeholder, rule errors to their status", () => {
    let caught: unknown;
    try {
      requireApproval(VENDOR_GATES.mailboxAccess.key, { action: "test" });
    } catch (err) {
      caught = err;
    }
    expect(mapHandledError(caught)).toMatchObject({ status: 423, body: { error: "pending_approval", gate: "vendor.mailbox_access" } });
    expect(mapHandledError(new AlertRuleError("nope", 409))).toEqual({ status: 409, body: { error: "nope" } });
    expect(mapHandledError(new Error("boom"))).toBeNull();
  });

  it("validates bodies with readable 422s", () => {
    expect(() => reqString({ a: " " }, "a")).toThrow(/'a' is required/);
    expect(() => oneOf({ c: "fax" }, "c", ["portal", "email"] as const)).toThrow(/must be one of/);
  });

  it("parses an adapter's court email, normalising auth verdicts", () => {
    const parsed = parseInboundCourtEmail({
      externalId: "m-1",
      fromAddress: "a@efiletexas.gov",
      subject: "Notice",
      bodyText: "Body",
      receivedAt: "2026-10-05T14:00:00Z",
      auth: { spf: "PASS", dkim: "pass", dkimDomain: "efiletexas.gov", dmarc: "Pass" },
      attachments: [{ filename: "order.pdf", sizeBytes: 1200 }],
    });
    expect(parsed.auth).toEqual({ spf: "pass", dkim: "pass", dkimDomain: "efiletexas.gov", dmarc: "pass" });
    expect(parsed.attachments).toEqual([{ filename: "order.pdf", mimeType: null, sizeBytes: 1200, sha256: null }]);
    expect(() => parseInboundCourtEmail({ externalId: "x", fromAddress: "a@b.c", subject: "s", receivedAt: "nope" })).toThrow(/ISO date-time/);
  });
});
