import { describe, expect, it } from "vitest";
import type { TenantTx } from "@/tenancy/withTenant";
import {
  collectScope,
  collectScreens,
  decideDocumentAccess,
  hiddenTagsForRole,
  predicateScreenSource,
  type AccessContext,
  type ClientViewer,
  type DocumentFacts,
  type StaffViewer,
} from "./policy";

const M1 = "m1";
const M2 = "m2";
const lawyer: StaffViewer = { kind: "staff", userId: "u-lawyer", role: "attorney", permissions: ["documents.read", "documents.write", "documents.approve"] };
const staff: StaffViewer = { kind: "staff", userId: "u-staff", role: "intake_staff", permissions: ["documents.read"] };
const admin: StaffViewer = { kind: "staff", userId: "u-admin", role: "firm_admin", permissions: ["documents.read", "documents.write"] };
const integration: StaffViewer = { kind: "staff", userId: "u-int", role: "integration_service", permissions: ["matters.read"] };
const devPrincipal: StaffViewer = { kind: "staff", userId: null, role: "firm_admin", permissions: ["documents.read", "documents.write"] };

const ctx = (over: Partial<AccessContext> = {}): AccessContext => ({
  screenedMatterIds: new Set(),
  allowedMatterIds: null,
  restrictedTags: { sealed: ["attorney", "firm_admin"] },
  staffMayDownloadUnscanned: true,
  ...over,
});
const doc = (over: Partial<DocumentFacts> = {}): DocumentFacts => ({
  matterId: M1,
  privilegeTag: "none",
  clientVisible: false,
  scanStatus: "clean",
  ...over,
});

describe("staff access", () => {
  it("needs documents.read to see and documents.write to change", () => {
    expect(decideDocumentAccess(staff, "view", doc(), ctx())).toEqual({ allowed: true });
    expect(decideDocumentAccess(staff, "upload", doc(), ctx())).toEqual({ allowed: false, reason: "no_permission" });
    expect(decideDocumentAccess(integration, "view", doc(), ctx())).toEqual({ allowed: false, reason: "no_permission" });
    expect(decideDocumentAccess(lawyer, "edit", doc(), ctx())).toEqual({ allowed: true });
  });

  it("an ethical screen beats every role, including firm admin", () => {
    const screened = ctx({ screenedMatterIds: new Set([M1]) });
    for (const v of [lawyer, staff, admin]) {
      expect(decideDocumentAccess(v, "view", doc(), screened)).toEqual({ allowed: false, reason: "screened" });
      expect(decideDocumentAccess(v, "search", doc(), screened)).toEqual({ allowed: false, reason: "screened" });
    }
    expect(decideDocumentAccess(lawyer, "view", doc({ matterId: M2 }), screened)).toEqual({ allowed: true });
  });

  it("applies a matter scope when one is provided", () => {
    const scoped = ctx({ allowedMatterIds: new Set([M2]) });
    expect(decideDocumentAccess(lawyer, "view", doc(), scoped)).toEqual({ allowed: false, reason: "outside_matter_scope" });
    expect(decideDocumentAccess(lawyer, "view", doc({ matterId: M2 }), scoped)).toEqual({ allowed: true });
  });

  it("restricts sealed documents to the listed roles", () => {
    const sealed = doc({ privilegeTag: "sealed" });
    expect(decideDocumentAccess(staff, "view", sealed, ctx())).toEqual({ allowed: false, reason: "restricted_tag" });
    expect(decideDocumentAccess(lawyer, "view", sealed, ctx())).toEqual({ allowed: true });
    expect(decideDocumentAccess(staff, "view", doc({ privilegeTag: "privileged" }), ctx())).toEqual({ allowed: true });
  });

  it("never serves infected or still-scanning bytes; unscanned per firm setting", () => {
    expect(decideDocumentAccess(lawyer, "download", doc({ scanStatus: "infected" }), ctx())).toEqual({ allowed: false, reason: "quarantined" });
    expect(decideDocumentAccess(lawyer, "download", doc({ scanStatus: "pending" }), ctx())).toEqual({ allowed: false, reason: "scan_pending" });
    expect(decideDocumentAccess(lawyer, "download", doc({ scanStatus: "error" }), ctx())).toEqual({ allowed: false, reason: "scan_pending" });
    expect(decideDocumentAccess(lawyer, "download", doc({ scanStatus: "not_scanned" }), ctx())).toEqual({ allowed: true });
    expect(decideDocumentAccess(lawyer, "download", doc({ scanStatus: "not_scanned" }), ctx({ staffMayDownloadUnscanned: false }))).toEqual({
      allowed: false,
      reason: "not_scanned",
    });
    // metadata view does not touch the bytes
    expect(decideDocumentAccess(lawyer, "view", doc({ scanStatus: "infected" }), ctx())).toEqual({ allowed: true });
  });

  it("does not apply per-user screens to the synthetic dev principal (it has no user id)", () => {
    expect(decideDocumentAccess(devPrincipal, "view", doc(), ctx({ screenedMatterIds: new Set([M1]) }))).toEqual({ allowed: true });
  });
});

describe("client access", () => {
  const client: ClientViewer = { kind: "client", partyId: "p1", matterIds: [M1] };
  it("only their matters, only client-visible non-privileged documents, only clean bytes", () => {
    expect(decideDocumentAccess(client, "view", doc({ clientVisible: true }), ctx())).toEqual({ allowed: true });
    expect(decideDocumentAccess(client, "view", doc({ clientVisible: false }), ctx())).toMatchObject({ reason: "not_client_visible" });
    expect(decideDocumentAccess(client, "view", doc({ clientVisible: true, privilegeTag: "work_product" }), ctx())).toMatchObject({
      reason: "not_client_visible",
    });
    expect(decideDocumentAccess(client, "view", doc({ clientVisible: true, matterId: M2 }), ctx())).toMatchObject({ reason: "outside_matter_scope" });
    expect(decideDocumentAccess(client, "download", doc({ clientVisible: true, scanStatus: "not_scanned" }), ctx())).toMatchObject({
      reason: "not_scanned",
    });
    expect(decideDocumentAccess(client, "search", doc({ clientVisible: true }), ctx())).toMatchObject({ reason: "no_permission" });
    expect(decideDocumentAccess(client, "upload", doc({ clientVisible: true }), ctx())).toMatchObject({ reason: "no_permission" });
  });
});

describe("hiddenTagsForRole", () => {
  it("lists tags a role may not see", () => {
    expect(hiddenTagsForRole("intake_staff", { sealed: ["attorney"], work_product: ["attorney", "intake_staff"] })).toEqual(["sealed"]);
    expect(hiddenTagsForRole("attorney", { sealed: ["attorney"] })).toEqual([]);
  });
});

describe("hook composition", () => {
  const tx = {} as TenantTx;
  it("unions screen sources and skips users without an id", async () => {
    const a = predicateScreenSource("a", async () => ["m1"]);
    const b = predicateScreenSource("b", async (_t, u) => (u === "u1" ? ["m2"] : []));
    expect([...(await collectScreens([a, b], tx, "t", "u1"))].sort()).toEqual(["m1", "m2"]);
    expect([...(await collectScreens([a, b], tx, "t", null))]).toEqual([]);
  });
  it("fails closed when a source fails", async () => {
    const broken = predicateScreenSource("broken", async () => {
      throw new Error("db down");
    });
    await expect(collectScreens([broken], tx, "t", "u1")).rejects.toThrow("db down");
  });
  it("intersects scope sources; null means unrestricted", async () => {
    const all = { name: "all", allowedMatterIds: async () => null };
    const some = { name: "some", allowedMatterIds: async () => new Set(["m1", "m2"]) };
    const fewer = { name: "fewer", allowedMatterIds: async () => new Set(["m2", "m3"]) };
    expect(await collectScope([all], tx, "t", lawyer)).toBeNull();
    expect([...(await collectScope([all, some, fewer], tx, "t", lawyer))!]).toEqual(["m2"]);
  });
});
