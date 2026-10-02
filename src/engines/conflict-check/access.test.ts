import { describe, expect, it } from "vitest";
import { assertCan, AccessDeniedError, capabilitiesFor, pickReviewer, type ConflictAccess } from "./access";

describe("capabilitiesFor (c56 rule 3, c63 rule 1, c97 rule 1)", () => {
  it("gives a user without the conflicts role nothing", () => {
    expect([...capabilitiesFor({ userRole: "attorney", userStatus: "active", grant: null, ownerSeesPartyDetails: false })]).toEqual([]);
    expect([...capabilitiesFor({ userRole: "intake_staff", userStatus: "active", grant: null, ownerSeesPartyDetails: true })]).toEqual([]);
  });

  it("lets conflicts staff search and view but not decide", () => {
    const caps = capabilitiesFor({ userRole: "intake_staff", userStatus: "active", grant: { role: "conflicts_staff" }, ownerSeesPartyDetails: false });
    expect(caps.has("index.search")).toBe(true);
    expect(caps.has("log.view_interests")).toBe(true);
    expect(caps.has("decide")).toBe(false);
  });

  it("lets a conflicts attorney decide", () => {
    expect(capabilitiesFor({ userRole: "attorney", userStatus: "active", grant: { role: "conflicts_attorney" }, ownerSeesPartyDetails: false }).has("decide")).toBe(true);
  });

  it("gives the firm admin counts, the log and role management, but party details only when the firm allows it", () => {
    const admin = capabilitiesFor({ userRole: "firm_admin", userStatus: "active", grant: null, ownerSeesPartyDetails: false });
    expect(admin.has("health.view")).toBe(true);
    expect(admin.has("roles.manage")).toBe(true);
    expect(admin.has("log.view")).toBe(true);
    expect(admin.has("index.search")).toBe(false);
    expect(admin.has("log.view_interests")).toBe(false); // c97: never by admin role alone
    expect(admin.has("decide")).toBe(false);
    expect(capabilitiesFor({ userRole: "firm_admin", userStatus: "active", grant: null, ownerSeesPartyDetails: true }).has("index.search")).toBe(true);
  });

  it("gives an inactive user nothing, whatever their grant", () => {
    expect(capabilitiesFor({ userRole: "attorney", userStatus: "disabled", grant: { role: "conflicts_attorney" }, ownerSeesPartyDetails: false }).size).toBe(0);
  });

  it("assertCan throws AccessDeniedError", () => {
    const access: ConflictAccess = { userId: "u", userRole: "attorney", grant: null, caps: new Set() };
    expect(() => assertCan(access, "decide")).toThrow(AccessDeniedError);
  });
});

describe("pickReviewer (c59 §4.1.2, §4.7)", () => {
  const attorneys = { designated: "d", backups: ["b"], all: ["d", "b"] };

  it("picks the designated attorney, supervised by the backup", () => {
    expect(pickReviewer(attorneys, ["admin"])).toEqual({ userId: "d", supervisorUserId: "b", fallback: "none" });
  });

  it("skips the designated attorney when the hit concerns them", () => {
    expect(pickReviewer(attorneys, ["admin"], ["d"])).toEqual({ userId: "b", supervisorUserId: "admin", fallback: "backup" });
  });

  it("falls back to the firm admin, then to nobody", () => {
    expect(pickReviewer({ designated: null, backups: [], all: [] }, ["admin"])).toEqual({ userId: "admin", supervisorUserId: null, fallback: "admin" });
    expect(pickReviewer({ designated: null, backups: [], all: [] }, [])).toEqual({ userId: null, supervisorUserId: null, fallback: "unassigned" });
  });
});
