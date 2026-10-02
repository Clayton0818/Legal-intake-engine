import { describe, expect, it } from "vitest";
import { applyRuleTable, DRAFT_RULE_TABLE, situationForHit, UNAPPLIED_ASSESSMENT, type RuleTableRow } from "./ruleTable";
import { hit, inquiryInv, matterInv } from "./testFixtures";

describe("situationForHit", () => {
  it("the other side of the new matter is a current client", () => {
    expect(situationForHit(hit({ searchedRole: "opposing_party", involvements: [matterInv("m", "client", "current")] }))).toBe("adverse_current_client");
  });
  it("the other side is a former client", () => {
    expect(situationForHit(hit({ searchedRole: "opposing_party", involvements: [matterInv("m", "client", "former")] }))).toBe("adverse_former_client");
  });
  it("the other side once consulted the firm (Rule 1.18)", () => {
    expect(situationForHit(hit({ searchedRole: "opposing_party", involvements: [inquiryInv("s")] }))).toBe("adverse_prospective_client");
  });
  it("the new client was on the other side of one of our matters", () => {
    expect(situationForHit(hit({ searchedRole: "prospective_client", involvements: [matterInv("m", "opposing_party", "current")] }))).toBe("adverse_current_client");
    expect(situationForHit(hit({ searchedRole: "prospective_client", involvements: [matterInv("m", "child", "former", { isAdverse: true })] }))).toBe("adverse_former_client");
  });
  it("same side and related parties", () => {
    expect(situationForHit(hit({ searchedRole: "prospective_client", involvements: [matterInv("m", "client", "former")] }))).toBe("same_side");
    expect(situationForHit(hit({ searchedRole: "related_party", involvements: [matterInv("m", "witness")] }))).toBe("related_party_only");
  });
  it("lateral lists and lawyer interests", () => {
    expect(situationForHit(hit({ sourceType: "lateral_list" }))).toBe("lateral_prior_matter");
    expect(situationForHit(hit({ searchedRole: "lateral_client" }))).toBe("lateral_prior_matter");
    expect(situationForHit(hit({ sourceType: "interest" }))).toBe("lawyer_personal_interest");
    expect(situationForHit(hit({ searchedRole: "lawyer_interest" }))).toBe("lawyer_personal_interest");
  });
  it("takes the most serious involvement", () => {
    const h = hit({ searchedRole: "opposing_party", involvements: [matterInv("a", "witness"), matterInv("b", "client", "current"), inquiryInv("s")] });
    expect(situationForHit(h)).toBe("adverse_current_client");
  });
});

describe("applyRuleTable", () => {
  it("returns the rows that apply and whether the result is definite", () => {
    const a = applyRuleTable([hit({ searchedRole: "opposing_party", involvements: [matterInv("m", "client", "current")] })], DRAFT_RULE_TABLE);
    expect(a.applied).toBe(true);
    expect(a.definite).toBe(true);
    expect(a.rows.map((r) => r.id)).toEqual(["tx-1.06-current-adverse"]);
  });

  it("marks consent unavailable when any row is not waivable", () => {
    const table: RuleTableRow[] = DRAFT_RULE_TABLE.map((r) => (r.situation === "adverse_former_client" ? { ...r, waivability: "not_waivable" } : r));
    const a = applyRuleTable([hit({ involvements: [matterInv("m", "client", "former")] })], table);
    expect(a.consent).toBe("not_waivable");
  });

  it("the unapplied assessment disables nothing and upgrades nothing", () => {
    expect(UNAPPLIED_ASSESSMENT).toEqual({ applied: false, rows: [], definite: false, consent: "unknown" });
  });
});
