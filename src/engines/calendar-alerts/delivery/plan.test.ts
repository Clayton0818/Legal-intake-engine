import { describe, expect, it } from "vitest";
import { TZ, chicago } from "../testFixtures";
import { FLAG_TYPES } from "../kinds";
import { composeDigest, digestDue, planFollowup } from "./plan";

describe("planFollowup (c51 — a flag never silently goes nowhere)", () => {
  it("acceptance 5: a bounced client email flags the lawyer", () => {
    expect(planFollowup({ channel: "email", recipientType: "party", status: "bounced", lastError: "550" })).toMatchObject({
      kind: "bounced",
      notify: "lawyer",
      flagType: FLAG_TYPES.deliveryBounced,
    });
  });

  it("a bounced staff email or a final failure flags the firm admin", () => {
    expect(planFollowup({ channel: "email", recipientType: "user", status: "bounced", lastError: null })?.notify).toBe("admin");
    expect(planFollowup({ channel: "email", recipientType: "party", status: "failed", lastError: "timeout" })).toMatchObject({ kind: "failed", notify: "admin" });
  });

  it("no safe address flags the lawyer; a deliberate opt-out is respected and not flagged", () => {
    expect(planFollowup({ channel: "email", recipientType: "party", status: "suppressed", lastError: "DV-sensitive client has no safe email on file; in-app only." })?.kind).toBe("suppressed_no_address");
    expect(planFollowup({ channel: "email", recipientType: "party", status: "suppressed", lastError: "No email address on file." })?.kind).toBe("suppressed_no_address");
    expect(planFollowup({ channel: "email", recipientType: "party", status: "suppressed", lastError: "Client has turned off email." })).toBeNull();
    expect(planFollowup({ channel: "email", recipientType: "user", status: "suppressed", lastError: "User has no email." })?.kind).toBe("email_missing");
  });

  it("ignores in-app rows and good deliveries", () => {
    expect(planFollowup({ channel: "in_app", recipientType: "party", status: "bounced", lastError: null })).toBeNull();
    expect(planFollowup({ channel: "email", recipientType: "party", status: "delivered", lastError: null })).toBeNull();
    expect(planFollowup({ channel: "email", recipientType: "party", status: "held", lastError: "[PENDING …]" })).toBeNull();
  });
});

describe("digestDue", () => {
  it("runs once per local day at or after the firm's digest time", () => {
    expect(digestDue(null, chicago(5, 7, 59), TZ, "08:00")).toBe(false);
    expect(digestDue(null, chicago(5, 8), TZ, "08:00")).toBe(true);
    expect(digestDue(chicago(5, 8, 1), chicago(5, 17), TZ, "08:00")).toBe(false);
    expect(digestDue(chicago(5, 8, 1), chicago(6, 8), TZ, "08:00")).toBe(true);
  });
});

describe("composeDigest", () => {
  it("lists titles only and says urgent alerts are never digested", () => {
    const d = composeDigest([{ title: "Task overdue: Draft petition", severity: "warning", resolved: false }], "Smith Law");
    expect(d.subject).toBe("Smith Law: 1 alert in your daily digest");
    expect(d.body).toContain("- [WARNING] Task overdue: Draft petition");
    expect(d.body).toContain("Urgent alerts are always emailed straight away.");
  });
});
