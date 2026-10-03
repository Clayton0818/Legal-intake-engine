import { describe, expect, it } from "vitest";
import { planDefaultAdoptions } from "./service";
import { FAMILY_LAW_PACK } from "../packs/family";
import { worker } from "../worker";
import { buildRegistry } from "@/worker/hooks";

describe("planDefaultAdoptions", () => {
  const acc = new Map([["family" as const, { version: "0.1.0", contentHash: "h" }]]);
  const pub = { family: { practiceArea: "family" as const, version: "0.1.0", contentHash: "h", acceptedAt: "x", pack: FAMILY_LAW_PACK } };

  it("adopts an enabled area with a pack and no acceptance", () => {
    expect(planDefaultAdoptions({ enabled: ["family"], accepted: new Map(), published: {}, available: ["family"] })).toEqual({ adopt: ["family"], republish: true });
  });
  it("never adopts areas without a pack", () => {
    expect(planDefaultAdoptions({ enabled: ["immigration"], accepted: new Map(), published: {}, available: ["family"] })).toEqual({ adopt: [], republish: false });
  });
  it("does nothing when accepted and published agree, and never auto-accepts updates", () => {
    expect(planDefaultAdoptions({ enabled: ["family"], accepted: acc, published: pub, available: ["family"] })).toEqual({ adopt: [], republish: false });
  });
  it("republishes when the snapshot drifted", () => {
    expect(planDefaultAdoptions({ enabled: ["family"], accepted: acc, published: {}, available: ["family"] })).toEqual({ adopt: [], republish: true });
  });
});

describe("worker module", () => {
  it("registers with the shared worker registry", () => {
    const reg = buildRegistry([{ slug: "all-engines", module: worker }]);
    expect(reg.hooks.map((h) => h.name)).toContain("all-engines.publish_practice_area_packs");
  });
});
