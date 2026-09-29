import { describe, expect, it } from "vitest";
import { findDuplicatePairs, pairKey, scorePair } from "./dedupe";

describe("scorePair (suggestions only; never auto-merged)", () => {
  it("suggests same name", () => {
    expect(scorePair({ id: "a", names: ["jane doe"] }, { id: "b", names: ["jane doe"] })?.score).toBe(0.7);
  });
  it("scores same email and same DOB highly", () => {
    expect(scorePair({ id: "a", names: ["jane doe"], emails: ["J@x.com"] }, { id: "b", names: ["jane smith"], emails: ["j@x.com"] })?.score).toBe(0.9);
    expect(scorePair({ id: "a", names: ["jane doe"], dateOfBirth: "1990-01-01" }, { id: "b", names: ["jane a doe"], dateOfBirth: "1990-01-01" })?.score).toBe(0.95);
  });
  it("never suggests people with different known dates of birth", () => {
    expect(scorePair({ id: "a", names: ["jane doe"], dateOfBirth: "1990-01-01" }, { id: "b", names: ["jane doe"], dateOfBirth: "1991-01-01" })).toBeNull();
  });
  it("ignores unrelated records and a record paired with itself", () => {
    expect(scorePair({ id: "a", names: ["jane doe"] }, { id: "b", names: ["robert brown"] })).toBeNull();
    expect(scorePair({ id: "a", names: ["jane doe"] }, { id: "a", names: ["jane doe"] })).toBeNull();
  });
});

describe("findDuplicatePairs", () => {
  const people = [
    { id: "b", names: ["jane doe"] },
    { id: "a", names: ["jane doe"] },
    { id: "c", names: ["robert brown"], phones: ["512-555-0100"] },
    { id: "d", names: ["bob browne"], phones: ["+1 (512) 555-0100"] },
  ];

  it("finds pairs through name, email and phone buckets, ordered pair ids", () => {
    const pairs = findDuplicatePairs(people);
    expect(pairs.map((p) => `${p.partyAId}|${p.partyBId}`).sort()).toEqual(["a|b", "c|d"]);
  });

  it("skips pairs already suggested, rejected or merged", () => {
    expect(findDuplicatePairs(people, new Set([pairKey("b", "a").join("|")])).map((p) => p.partyAId)).toEqual(["c"]);
  });
});
