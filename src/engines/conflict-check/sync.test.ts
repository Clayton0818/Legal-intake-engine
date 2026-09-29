import { describe, expect, it } from "vitest";
import { buildRegistry } from "@/worker/hooks";
import { declineTypeForStage, groupNewLinks, searchedNamesForParty, triggerForMatter, validateInquiryParties } from "./sync";
import { worker } from "./worker";

describe("searchedNamesForParty", () => {
  it("searches the legal name and every alias once", () => {
    const out = searchedNamesForParty(
      { id: "p1", fullName: "Ann Carter", aliases: ["Ann Miller", "ann carter", " "], dateOfBirth: "1980-02-02", email: null, phone: null },
      "opposing_party"
    );
    expect(out.map((s) => s.name)).toEqual(["Ann Carter", "Ann Miller"]);
    expect(out.every((s) => s.partyId === "p1" && s.role === "opposing_party" && s.dateOfBirth === "1980-02-02")).toBe(true);
  });
});

describe("groupNewLinks", () => {
  const t0 = new Date("2026-10-05T15:00:00Z");
  const t1 = new Date("2026-10-05T16:00:00Z");

  it("groups by matter and drops parties an existing check already covered", () => {
    const grouped = groupNewLinks(
      [
        { matterId: "m1", partyId: "a", role: "client", addedAt: t0 },
        { matterId: "m1", partyId: "b", role: "opposing_party", addedAt: t0 },
        { matterId: "m2", partyId: "c", role: "child", addedAt: t1 },
        { matterId: "m1", partyId: "b", role: "opposing_party", addedAt: t0 },
      ],
      new Map([["m1", [{ createdAt: t1, partyIds: ["a"] }]]])
    );
    expect([...grouped.keys()]).toEqual(["m1", "m2"]);
    expect(grouped.get("m1")!.map((l) => l.partyId)).toEqual(["b"]);
  });

  it("does not treat a check from BEFORE the link as covering it", () => {
    const grouped = groupNewLinks([{ matterId: "m1", partyId: "a", role: "client", addedAt: t1 }], new Map([["m1", [{ createdAt: t0, partyIds: ["a"] }]]]));
    expect(grouped.get("m1")).toHaveLength(1);
  });
});

describe("triggerForMatter / declineTypeForStage", () => {
  it("first check before engagement is an intake check; later ones are party_added", () => {
    expect(triggerForMatter("prospective", false)).toBe("intake");
    expect(triggerForMatter("prospective", true)).toBe("party_added");
    expect(triggerForMatter("retained", false)).toBe("party_added");
  });
  it("maps declined stages to letter types", () => {
    expect(declineTypeForStage("declined_conflict")).toBe("conflict");
    expect(declineTypeForStage("did_not_hire_referred_out")).toBe("did_not_hire");
    expect(declineTypeForStage("retained")).toBeNull();
  });
});

describe("validateInquiryParties", () => {
  it("needs a named prospective client", () => {
    expect(validateInquiryParties([])).not.toEqual([]);
    expect(validateInquiryParties([{ role: "opposing_party", name: "X" }])).toContain("One party must be the prospective client.");
    expect(validateInquiryParties([{ role: "prospective_client", nameUnknown: true }]).join(" ")).toContain("must be named");
  });
  it("accepts an unnamed other party (the check will not be clear)", () => {
    expect(validateInquiryParties([{ role: "prospective_client", name: "Pat" }, { role: "opposing_party", nameUnknown: true }])).toEqual([]);
  });
  it("rejects unknown roles and name types", () => {
    expect(validateInquiryParties([{ role: "prospective_client", name: "Pat", variants: [{ name: "P", type: "stage" as never }] }]).length).toBe(1);
    expect(validateInquiryParties([{ role: "prospective_client", name: "Pat" }, { role: "boss" as never, name: "B" }]).length).toBe(1);
  });
});

describe("worker module", () => {
  it("registers cleanly with the worker registry", () => {
    const reg = buildRegistry([{ slug: "conflict-check", module: worker }]);
    expect(reg.hooks.map((h) => h.name)).toEqual(
      expect.arrayContaining(["conflict-check.index_sync", "conflict-check.waiver_timers", "conflict-check.lateral_start_dates", "conflict-check.ensure_maintenance"])
    );
    expect([...reg.handlers.keys()].sort()).toEqual(["conflict-check.daily_maintenance", "conflict-check.export_generate"]);
  });
});
