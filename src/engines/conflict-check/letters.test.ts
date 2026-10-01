import { afterEach, describe, expect, it } from "vitest";
import { InMemoryApprovalSource, isPlaceholder, resetApprovalStateForTests, setApprovals } from "@/compliance/approvals";
import { CONFLICT_COPY_GATES } from "./gates";
import {
  assertNeutralLetter,
  chooseLetterChannel,
  chooseReferral,
  letterRequired,
  LetterNotNeutralError,
  needsIndividualApproval,
  renderNonEngagementLetter,
} from "./letters";

async function approve(...keys: string[]) {
  const src = new InMemoryApprovalSource();
  for (const gateKey of keys) src.approve({ gateKey, reviewerKind: "attorney", approvedByName: "Test Attorney" });
  setApprovals(await src.load());
}

const vars = { prospectName: "Pat Prospect", firmName: "Lone Star Family Law", date: "2026-10-01", contactDate: "2026-09-28" };

afterEach(() => resetApprovalStateForTests());

describe("renderNonEngagementLetter (c62: wording needs attorney review)", () => {
  it("renders the visible placeholder until the wording is approved", () => {
    const r = renderNonEngagementLetter(vars);
    expect(r.approved).toBe(false);
    expect(isPlaceholder(r.text)).toBe(true);
    expect(r.text).toContain("PENDING ATTORNEY REVIEW");
    expect(r.referralIncluded).toBe(false);
  });

  it("renders the approved wording with the prospect's name, and no referral unless that paragraph is approved too", async () => {
    await approve(CONFLICT_COPY_GATES.nonEngagementLetter.key);
    const r = renderNonEngagementLetter({ ...vars, referral: { name: "Travis County Lawyer Referral", contact: "512-555-0199" } });
    expect(r.approved).toBe(true);
    expect(r.text).toContain("Dear Pat Prospect");
    expect(r.text).toContain("No attorney-client relationship");
    expect(r.text).not.toContain("Referral");
    expect(r.referralIncluded).toBe(false);
  });

  it("includes an approved referral paragraph", async () => {
    await approve(CONFLICT_COPY_GATES.nonEngagementLetter.key, CONFLICT_COPY_GATES.nonEngagementReferral.key);
    const r = renderNonEngagementLetter({ ...vars, referral: { name: "Travis County Lawyer Referral", contact: "512-555-0199" } });
    expect(r.referralIncluded).toBe(true);
    expect(r.text).toContain("Travis County Lawyer Referral (512-555-0199)");
  });

  it("the approved draft is neutral: it never says conflict", async () => {
    await approve(CONFLICT_COPY_GATES.nonEngagementLetter.key);
    const r = renderNonEngagementLetter(vars);
    expect(() => assertNeutralLetter(r.text, ["Oscar Opposing"])).not.toThrow();
  });
});

describe("assertNeutralLetter (c62 rule 3)", () => {
  it("refuses a letter that mentions a conflict or names another party", () => {
    expect(() => assertNeutralLetter("We have a conflict of interest.", [])).toThrow(LetterNotNeutralError);
    expect(() => assertNeutralLetter("We already represent Oscar Opposing.", ["Oscar Opposing"])).toThrow(/names another party/);
  });
  it("ignores very short names that would match ordinary words", () => {
    expect(() => assertNeutralLetter("Thank you for contacting us.", ["Al"])).not.toThrow();
  });
});

describe("letter rules", () => {
  it("every decline gets a letter; did-not-hire only when the firm keeps it on", () => {
    expect(letterRequired("conflict", { letterForDidNotHire: false })).toBe(true);
    expect(letterRequired("did_not_hire", { letterForDidNotHire: false })).toBe(false);
    expect(letterRequired("did_not_hire", { letterForDidNotHire: true })).toBe(true);
  });

  it("conflict declines always need a lawyer to approve the individual letter", () => {
    expect(needsIndividualApproval("conflict", { letterAutoSendTypes: ["conflict"] })).toBe(true);
    expect(needsIndividualApproval("out_of_scope", { letterAutoSendTypes: ["out_of_scope"] })).toBe(false);
    expect(needsIndividualApproval("out_of_scope", { letterAutoSendTypes: [] })).toBe(true);
  });

  it("chooses a referral by practice area, then a general one", () => {
    const sources = [
      { name: "General", contact: "1" },
      { name: "Family", contact: "2", practiceArea: "family" },
    ];
    expect(chooseReferral(sources, "family")?.name).toBe("Family");
    expect(chooseReferral(sources, "immigration")?.name).toBe("General");
    expect(chooseReferral([], "family")).toBeNull();
  });
});

describe("chooseLetterChannel (DV-safe delivery)", () => {
  const base = { email: "home@example.com", phone: null, safeContact: {}, dvSensitive: false };

  it("uses the portal when there is one", () => {
    expect(chooseLetterChannel(base, true)).toEqual({ channel: "portal" });
  });
  it("prefers the safe address the prospect chose", () => {
    expect(chooseLetterChannel({ ...base, safeContact: { safeEmail: "safe@example.com" } }, false)).toEqual({ channel: "email", address: "safe@example.com" });
  });
  it("never emails a DV-sensitive prospect at an address they did not choose", () => {
    const r = chooseLetterChannel({ ...base, dvSensitive: true }, false);
    expect(r.channel).toBe("none");
  });
  it("respects 'no sensitive notices by email'", () => {
    expect(chooseLetterChannel({ ...base, safeContact: { sensitiveByEmail: false } }, false).channel).toBe("none");
  });
});
