import { describe, expect, it } from "vitest";
import { bandFor, compareNames, explainHit, linkTokens, matchIndex } from "./matching";
import { comparableTokens, isNicknamePair, matchKeysForName, normalizeAddress, phoneticKey } from "./nameRules";
import { entry, matterInv } from "./testFixtures";

describe("phoneticKey (c57)", () => {
  it.each([
    ["smith", "smyth"],
    ["gonzalez", "gonzales"],
    ["ybarra", "ibarra"],
    ["hernandez", "ernandez"],
    ["john", "jon"],
    ["stephen", "steven"],
    ["katherine", "kathryn"],
    ["rodriguez", "rodrigues"],
    ["vasquez", "basquez"],
  ])("%s sounds like %s", (a, b) => {
    expect(phoneticKey(a)).toBe(phoneticKey(b));
  });

  it("keeps clearly different names apart", () => {
    expect(phoneticKey("lopez")).not.toBe(phoneticKey("gonzalez"));
    expect(phoneticKey("smith")).not.toBe(phoneticKey("jones"));
  });
});

describe("nicknames and name rules (c57)", () => {
  it("knows English and Spanish nicknames in both directions", () => {
    expect(isNicknamePair("bob", "robert")).toBe(true);
    expect(isNicknamePair("robert", "bob")).toBe(true);
    expect(isNicknamePair("pancho", "francisco")).toBe(true);
    expect(isNicknamePair("lalo", "eduardo")).toBe(true);
    expect(isNicknamePair("alex", "alejandro")).toBe(true);
    expect(isNicknamePair("alex", "alexander")).toBe(true);
    expect(isNicknamePair("bob", "william")).toBe(false);
  });

  it("drops Spanish particles and generational suffixes for people, business suffixes for organisations", () => {
    expect(comparableTokens("maria de la cruz", "person")).toEqual(["maria", "cruz"]);
    expect(comparableTokens("john smith jr", "person")).toEqual(["john", "smith"]);
    expect(comparableTokens("acme holdings llc", "organization")).toEqual(["acme"]);
  });

  it("builds prefilter keys that link nicknames and sound-alikes", () => {
    const bob = matchKeysForName("bob smyth");
    const robert = matchKeysForName("robert smith");
    expect(bob.some((k) => robert.includes(k) && k.startsWith("n:"))).toBe(true);
    expect(bob.some((k) => robert.includes(k) && k.startsWith("p:"))).toBe(true);
  });

  it("normalises addresses", () => {
    expect(normalizeAddress("123 Main St., Apt 4")).toBe(normalizeAddress("123 main street unit 4"));
  });

  it("links tokens by the strongest relation", () => {
    expect(linkTokens("maria", "maria")).toBe("exact");
    expect(linkTokens("bob", "robert")).toBe("nickname");
    expect(linkTokens("smyth", "smith")).toBe("phonetic");
    expect(linkTokens("jones", "garcia")).toBeNull();
  });
});

describe("compareNames near-misses (c57)", () => {
  it("matches sound-alike full names", () => {
    const c = compareNames("jon smyth", "john smith");
    expect(c?.kind).toBe("phonetic");
    expect(c?.evidence.some((e) => e.signal === "phonetic")).toBe(true);
  });

  it("matches a nickname plus a missing middle name", () => {
    expect(compareNames("bob smith", "robert james smith")?.kind).toBe("subset");
  });

  it("matches either Spanish surname used alone, and 'de la' particles", () => {
    expect(compareNames("maria lopez", "maria garcia lopez")?.kind).toBe("subset");
    expect(compareNames("maria garcia", "maria garcia lopez")?.kind).toBe("subset");
    expect(compareNames("juan cruz", "juan de la cruz")?.kind).toBe("exact");
  });

  it("matches business names without their suffix", () => {
    expect(compareNames("acme inc", "acme llc")?.kind).toBe("exact");
  });
});

describe("matchIndex secondary identifiers (c57)", () => {
  const robert = entry({
    displayName: "Robert Smith",
    names: [{ normalized: "robert smith", type: "legal" }],
    dateOfBirth: "1980-02-01",
    addresses: ["12 Elm St"],
    involvements: [matterInv("m1", "opposing_party", "current")],
  });

  it("strengthens a nickname hit when the date of birth matches", () => {
    const [hit] = matchIndex([{ name: "Bob Smith", role: "client", dateOfBirth: "1980-02-01" }], [robert]);
    expect(hit!.strength).toBeGreaterThanOrEqual(0.95);
    expect(hit!.band).toBe("strong");
    expect(hit!.evidence!.map((e) => e.signal)).toEqual(expect.arrayContaining(["nickname", "date_of_birth"]));
  });

  it("keeps but weakens a same-name hit with a different date of birth (over-flag)", () => {
    const [hit] = matchIndex([{ name: "Robert Smith", role: "client", dateOfBirth: "1991-07-07" }], [robert]);
    expect(hit).toBeDefined();
    expect(hit!.strength).toBeLessThan(0.8);
    expect(hit!.reasons.join(" ")).toContain("may be a different person");
  });

  it("finds a married-name change from first name + date of birth", () => {
    const [hit] = matchIndex([{ name: "Roberta Jones", role: "client", dateOfBirth: "1980-02-01" }], [
      entry({ displayName: "Roberta Smith", names: [{ normalized: "roberta smith", type: "legal" }], dateOfBirth: "1980-02-01", involvements: [matterInv("m2", "client", "former")] }),
    ]);
    expect(hit?.matchKind).toBe("name_change");
  });

  it("flags a same-address match as weak", () => {
    const [hit] = matchIndex([{ name: "Pat Nobody", role: "opposing_party", address: "12 Elm Street" }], [robert]);
    expect(hit?.matchKind).toBe("address");
    expect(hit?.band).toBe("weak");
  });

  it("explains every hit in one line", () => {
    const [hit] = matchIndex([{ name: "Bob Smyth", role: "client" }], [robert]);
    expect(hit).toBeDefined();
    const text = explainHit(hit!);
    expect(text).toContain("Robert Smith");
    expect(text).toMatch(/likely|strong|weak/);
  });

  it("bands strengths", () => {
    expect(bandFor(0.9)).toBe("strong");
    expect(bandFor(0.7)).toBe("likely");
    expect(bandFor(0.4)).toBe("weak");
  });
});
