import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  defineGate,
  gateStatus,
  getGate,
  hashDraft,
  InMemoryApprovalSource,
  interpolate,
  isApproved,
  isPlaceholder,
  legalCopy,
  legalCopyStatus,
  listGates,
  PendingApprovalError,
  placeholderFor,
  refreshApprovals,
  requireApproval,
  resetApprovalStateForTests,
  runGated,
  setApprovals,
  setApprovalSource,
  setBlockedActionSink,
  ensureApprovalsLoaded,
  UnknownGateError,
  type BlockedActionEvent,
} from "./approvals";

// Gates used only by this test file (keys are namespaced to avoid clashes).
const COPY = defineGate({
  key: "test.copy.greeting",
  cardIds: ["c72"],
  reviewers: ["attorney"],
  description: "Greeting shown before intake",
  draft: "Hello {name}, you are chatting with {firmName}'s automated assistant.",
});
const TRUST = defineGate({
  key: "test.rules.trust_move",
  cardIds: ["c75"],
  reviewers: ["attorney", "cpa"],
  description: "Move money out of trust",
});
const VENDOR = defineGate({
  key: "test.vendor.mailer",
  cardIds: ["c51"],
  reviewers: ["vendor_dpa"],
  description: "Test mail vendor",
});

beforeEach(() => {
  resetApprovalStateForTests();
  setBlockedActionSink(() => {});
});

describe("defineGate", () => {
  it("registers gates and lists them sorted", () => {
    expect(getGate(COPY.key)).toBe(COPY);
    const keys = listGates().map((g) => g.key);
    expect(keys).toEqual([...keys].sort());
    expect(keys).toContain("test.rules.trust_move");
  });

  it("is idempotent for identical definitions and rejects conflicting ones", () => {
    const again = defineGate({
      key: "test.vendor.mailer",
      cardIds: ["c51"],
      reviewers: ["vendor_dpa"],
      description: "Test mail vendor",
    });
    expect(again).toBe(VENDOR);
    expect(() =>
      defineGate({ key: "test.vendor.mailer", cardIds: ["c51"], reviewers: ["attorney"], description: "Different" })
    ).toThrow(/different definition/);
  });

  it("validates keys, reviewers and descriptions", () => {
    expect(() => defineGate({ key: "NoDots", cardIds: [], reviewers: ["attorney"], description: "x" })).toThrow(/Invalid gate key/);
    expect(() => defineGate({ key: "test.empty", cardIds: [], reviewers: [], description: "x" })).toThrow(/reviewer/);
    expect(() =>
      defineGate({ key: "test.bad_reviewer", cardIds: [], reviewers: ["judge" as never], description: "x" })
    ).toThrow(/unknown reviewer/);
    expect(() => defineGate({ key: "test.blank", cardIds: [], reviewers: ["cpa"], description: "  " })).toThrow(/description/);
  });

  it("throws UnknownGateError for undefined keys", () => {
    expect(() => legalCopy("test.nope")).toThrow(UnknownGateError);
    expect(() => requireApproval("test.nope")).toThrow(UnknownGateError);
  });
});

describe("fail-safe default", () => {
  it("nothing is approved until approvals are loaded", () => {
    expect(isApproved(COPY.key)).toBe(false);
    expect(isApproved(TRUST.key)).toBe(false);
    expect(isApproved(VENDOR.key)).toBe(false);
  });

  it("refreshApprovals() with no source approves nothing", async () => {
    setApprovals([{ gateKey: VENDOR.key, reviewerKind: "vendor_dpa", approvedByName: "x", approvedAt: new Date() }]);
    expect(isApproved(VENDOR.key)).toBe(true);
    await refreshApprovals();
    expect(isApproved(VENDOR.key)).toBe(false);
  });
});

describe("placeholders and legalCopy", () => {
  it("renders the exact placeholder format while pending", () => {
    expect(legalCopy(COPY.key, { name: "Ana" })).toBe(
      "[PENDING ATTORNEY REVIEW — Greeting shown before intake (gate: test.copy.greeting)]"
    );
    expect(placeholderFor(TRUST.key)).toBe(
      "[PENDING ATTORNEY + CPA REVIEW — Move money out of trust (gate: test.rules.trust_move)]"
    );
    expect(placeholderFor(VENDOR.key)).toBe("[PENDING VENDOR DPA REVIEW — Test mail vendor (gate: test.vendor.mailer)]");
    expect(isPlaceholder(placeholderFor(VENDOR.key))).toBe(true);
    expect(isPlaceholder("Hello")).toBe(false);
  });

  it("returns the approved draft with variables once approved", async () => {
    const src = new InMemoryApprovalSource();
    src.approve({ gateKey: COPY.key, reviewerKind: "attorney", approvedByName: "Jane Doe, Esq." });
    setApprovalSource(src);
    await refreshApprovals();
    expect(legalCopy(COPY.key, { name: "Ana", firmName: "Smith Family Law" })).toBe(
      "Hello Ana, you are chatting with Smith Family Law's automated assistant."
    );
    expect(legalCopyStatus(COPY.key).approved).toBe(true);
  });

  it("prefers the reviewer's own approved wording over the draft", () => {
    setApprovals([
      {
        gateKey: COPY.key,
        reviewerKind: "attorney",
        approvedByName: "Jane",
        approvedAt: new Date("2026-01-01"),
        approvedText: "Hi {name}. This is an automated assistant, not a lawyer.",
      },
    ]);
    expect(legalCopy(COPY.key, { name: "Ana" })).toBe("Hi Ana. This is an automated assistant, not a lawyer.");
  });

  it("invalidates an approval when the draft it approved has changed", () => {
    setApprovals([
      {
        gateKey: COPY.key,
        reviewerKind: "attorney",
        approvedByName: "Jane",
        approvedAt: new Date(),
        draftHash: hashDraft("an older draft"),
      },
    ]);
    expect(isApproved(COPY.key)).toBe(false);
    expect(isPlaceholder(legalCopy(COPY.key))).toBe(true);
  });

  it("shows the placeholder for a gate approved without any wording on record", () => {
    setApprovals([{ gateKey: VENDOR.key, reviewerKind: "vendor_dpa", approvedByName: "Ops", approvedAt: new Date() }]);
    expect(isApproved(VENDOR.key)).toBe(true);
    expect(legalCopyStatus(VENDOR.key).approved).toBe(false);
  });

  it("leaves unknown template tokens visible", () => {
    expect(interpolate("Dear {name}, see {portalUrl}", { name: "Ana" })).toBe("Dear Ana, see {portalUrl}");
  });
});

describe("multi-reviewer gates and revocation", () => {
  it("needs every reviewer kind", async () => {
    const src = new InMemoryApprovalSource();
    src.approve({ gateKey: TRUST.key, reviewerKind: "attorney", approvedByName: "Jane" });
    setApprovals(await src.load());
    const status = gateStatus(TRUST.key);
    expect(status.approved).toBe(false);
    expect(status.pendingReviewers).toEqual(["cpa"]);
    expect(placeholderFor(TRUST.key)).toContain("[PENDING CPA REVIEW");
  });

  it("closes again when an approval is revoked", async () => {
    const src = new InMemoryApprovalSource();
    src.approve({ gateKey: TRUST.key, reviewerKind: "attorney", approvedByName: "Jane" });
    src.approve({ gateKey: TRUST.key, reviewerKind: "cpa", approvedByName: "Carl CPA" });
    setApprovalSource(src);
    await refreshApprovals();
    expect(isApproved(TRUST.key)).toBe(true);
    src.revoke(TRUST.key, "cpa");
    await refreshApprovals();
    expect(isApproved(TRUST.key)).toBe(false);
  });

  it("ignores approvals from reviewer kinds the gate does not ask for", () => {
    setApprovals([{ gateKey: VENDOR.key, reviewerKind: "attorney", approvedByName: "Jane", approvedAt: new Date() }]);
    expect(isApproved(VENDOR.key)).toBe(false);
  });
});

describe("requireApproval / runGated", () => {
  it("throws PendingApprovalError and logs the blocked attempt", () => {
    const events: BlockedActionEvent[] = [];
    setBlockedActionSink((e) => events.push(e));
    let caught: unknown;
    try {
      requireApproval(TRUST.key, { action: "trust.disburse", tenantId: "t-1", detail: { cents: 1000 } });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PendingApprovalError);
    const err = caught as PendingApprovalError;
    expect(err.gateKey).toBe(TRUST.key);
    expect(err.pendingReviewers).toEqual(["attorney", "cpa"]);
    expect(err.placeholder).toContain("PENDING ATTORNEY + CPA REVIEW");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ gateKey: TRUST.key, action: "trust.disburse", tenantId: "t-1" });
  });

  it("passes once approved", () => {
    setApprovals([{ gateKey: VENDOR.key, reviewerKind: "vendor_dpa", approvedByName: "Ops", approvedAt: new Date() }]);
    expect(() => requireApproval(VENDOR.key)).not.toThrow();
  });

  it("a throwing log sink never hides the block", () => {
    setBlockedActionSink(() => {
      throw new Error("log down");
    });
    expect(() => requireApproval(VENDOR.key)).toThrow(PendingApprovalError);
  });

  it("runGated returns a blocked result without running the action", async () => {
    const fn = vi.fn(() => 42);
    const blocked = await runGated(VENDOR.key, "email.send", fn);
    expect(blocked.ok).toBe(false);
    expect(fn).not.toHaveBeenCalled();

    setApprovals([{ gateKey: VENDOR.key, reviewerKind: "vendor_dpa", approvedByName: "Ops", approvedAt: new Date() }]);
    const done = await runGated(VENDOR.key, "email.send", fn);
    expect(done).toEqual({ ok: true, value: 42 });
  });
});

describe("snapshot caching", () => {
  it("ensureApprovalsLoaded reloads only when stale", async () => {
    const src = new InMemoryApprovalSource();
    const load = vi.spyOn(src, "load");
    setApprovalSource(src);
    await ensureApprovalsLoaded(60_000);
    await ensureApprovalsLoaded(60_000);
    expect(load).toHaveBeenCalledTimes(1);
    await ensureApprovalsLoaded(0);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
