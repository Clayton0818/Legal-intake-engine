import { describe, expect, it } from "vitest";
import { compareNames, dedupeHits, editDistance, expandOrgLinkHits, matchIndex, relatedOrgParties, similarity } from "./matching";
import { entry, hit, inquiryInv, matterInv } from "./testFixtures";

describe("compareNames", () => {
  it("finds exact, suffix-only and reordered matches", () => {
    expect(compareNames("jane doe", "jane doe")?.kind).toBe("exact");
    expect(compareNames("acme holdings llc", "acme holdings")?.kind).toBe("exact");
    expect(compareNames("doe jane", "jane doe")?.kind).toBe("reordered");
  });

  it("allows common nicknames, including Spanish diminutives", () => {
    expect(compareNames("bill smith", "william smith")?.kind).toBe("nickname");
    expect(compareNames("chuy garcia", "jesus garcia")?.kind).toBe("nickname");
  });

  it("matches a missing middle name or second surname", () => {
    const cmp = compareNames("maria garcia", "maria elena garcia lopez");
    expect(cmp?.kind).toBe("subset");
  });

  it("matches a first initial with the same surname", () => {
    expect(compareNames("j smith", "john smith")?.kind).toBe("initial");
  });

  it("catches typos", () => {
    expect(compareNames("jonathan smiht", "jonathan smith")?.kind).toBe("fuzzy");
  });

  it("matches a single given name only when the name is partial", () => {
    expect(compareNames("maria", "maria lopez")?.kind).toBe("single_token");
    expect(compareNames("maria lopez", "maria gonzalez")).toBeNull();
  });

  it("returns null for unrelated names", () => {
    expect(compareNames("jane doe", "robert brown")).toBeNull();
    expect(compareNames("", "robert brown")).toBeNull();
  });
});

describe("editDistance / similarity", () => {
  it("computes Levenshtein distance", () => {
    expect(editDistance("kitten", "sitting")).toBe(3);
    expect(editDistance("", "abc")).toBe(3);
    expect(similarity("abc", "abc")).toBe(1);
  });
});

describe("matchIndex", () => {
  const jane = entry({ displayName: "Jane Doe", involvements: [matterInv("m1", "client", "current")] });
  const maiden = entry({
    displayName: "Ann Carter",
    names: [
      { normalized: "ann carter", type: "legal" },
      { normalized: "ann miller", type: "maiden" },
    ],
  });

  it("finds a party by a former (maiden) name and says so", () => {
    const hits = matchIndex([{ name: "Ann Miller", role: "opposing_party" }], [maiden]);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.matchKind).toBe("variant");
    expect(hits[0]!.reasons[0]).toContain("maiden");
  });

  it("never matches a name the caller refused to give", () => {
    expect(matchIndex([{ name: "", role: "opposing_party", nameUnknown: true }], [jane])).toEqual([]);
  });

  it("matches on email or phone even when the name changed", () => {
    const e = entry({ displayName: "Old Name", emails: ["x@example.com"], phones: ["(512) 555-0100"] });
    const byEmail = matchIndex([{ name: "Completely Different", role: "opposing_party", email: "X@example.com" }], [e]);
    expect(byEmail[0]?.matchKind).toBe("email");
    const byPhone = matchIndex([{ name: "Someone Else", role: "opposing_party", phone: "+1 512 555 0100" }], [e]);
    expect(byPhone[0]?.matchKind).toBe("phone");
  });

  it("does not report a party known only from the matter being checked", () => {
    const onlyHere = entry({ displayName: "Jane Doe", involvements: [inquiryInv("session-1")] });
    expect(matchIndex([{ name: "Jane Doe", role: "prospective_client" }], [onlyHere], { exclude: { kind: "inquiry", id: "session-1" } })).toEqual([]);
  });

  it("still reports the same person's OTHER involvements", () => {
    const both = entry({ displayName: "Jane Doe", involvements: [inquiryInv("session-1"), matterInv("m9", "opposing_party", "former")] });
    const hits = matchIndex([{ name: "Jane Doe", role: "prospective_client" }], [both], { exclude: { kind: "inquiry", id: "session-1" } });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.involvements).toEqual([matterInv("m9", "opposing_party", "former")]);
  });

  it("keeps lateral-list and interest entries even without involvements", () => {
    const lateral = entry({ displayName: "Jane Doe", sourceType: "lateral_list", sourceId: "lp1", partyId: null, involvements: [], ownerUserId: "u-hire" });
    const hits = matchIndex([{ name: "Jane Doe", role: "opposing_party" }], [lateral]);
    expect(hits[0]?.sourceType).toBe("lateral_list");
    expect(hits[0]?.ownerUserId).toBe("u-hire");
  });

  it("drops weak hits below the threshold and sorts strongest first", () => {
    const entries = [entry({ displayName: "John Smith", sourceId: "a" }), entry({ displayName: "J Smith", sourceId: "b" })];
    const hits = matchIndex([{ name: "John Smith", role: "opposing_party" }], entries);
    expect(hits.map((h) => h.sourceId)).toEqual(["a", "b"]);
    expect(matchIndex([{ name: "John Smith", role: "opposing_party" }], entries, { minStrength: 0.9 }).map((h) => h.sourceId)).toEqual(["a"]);
  });
});

describe("dedupeHits", () => {
  it("keeps the strongest hit per searched name and party", () => {
    const out = dedupeHits([hit({ strength: 0.6 }), hit({ strength: 0.9 }), hit({ searchedIndex: 1, strength: 0.5 })]);
    expect(out).toHaveLength(2);
    expect(out.find((h) => h.searchedIndex === 0)?.strength).toBe(0.9);
  });
});

describe("organisation links", () => {
  const links = [
    { parentPartyId: "parent", childPartyId: "sub" },
    { parentPartyId: "sub", childPartyId: "subsub" },
  ];

  it("walks links up and down to the requested depth", () => {
    expect([...relatedOrgParties("sub", links, 1).keys()].sort()).toEqual(["parent", "subsub"]);
    expect(relatedOrgParties("parent", links, 2).get("subsub")).toBe(2);
    expect(relatedOrgParties("parent", links, 1).has("subsub")).toBe(false);
  });

  it("adds weaker hits for linked organisations that the firm has dealt with", () => {
    const parentEntry = entry({ displayName: "Parent Co", sourceId: "parent", partyId: "parent" });
    const out = expandOrgLinkHits([hit({ partyId: "sub", sourceId: "sub", displayName: "Sub Co", strength: 1 })], links, new Map([["parent", parentEntry]]), 1);
    const linked = out.find((h) => h.partyId === "parent");
    expect(linked?.matchKind).toBe("org_link");
    expect(linked?.strength).toBe(0.8);
    expect(linked?.viaOrgLinkFromPartyId).toBe("sub");
  });

  it("does nothing at depth 0", () => {
    expect(expandOrgLinkHits([hit()], links, new Map(), 0)).toHaveLength(1);
  });
});
