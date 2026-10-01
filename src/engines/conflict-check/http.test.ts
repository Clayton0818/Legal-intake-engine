import { afterEach, describe, expect, it } from "vitest";
import { PendingApprovalError, requireApproval, resetApprovalStateForTests, setBlockedActionSink } from "@/compliance/approvals";
import { RULE_GATES } from "@/compliance/gates";
import { conflictRoute } from "@/app/api/conflict-check/_lib/route";
import { AccessDeniedError } from "./access";
import { mapHandledError, oneOf, optDate, parseInquiryParties, readBody, reqUuid, resolveActingUserId, uuidList } from "./http";
import { LetterNotNeutralError } from "./letters";
import { ConflictError } from "./util";

const USER = "7d3c5a0e-3f4b-4b8a-9d61-2f0b1c9e8a11";
const headers = (h: Record<string, string>) => new Headers(h);

afterEach(() => resetApprovalStateForTests());

describe("resolveActingUserId (dev stand-in until c34 sign-in)", () => {
  it("reads the x-user-id header outside production", () => {
    expect(resolveActingUserId(headers({ "x-user-id": USER }), { NODE_ENV: "development" })).toEqual({ ok: true, userId: USER });
  });
  it("requires the header and a valid id", () => {
    expect(resolveActingUserId(headers({}), { NODE_ENV: "test" })).toMatchObject({ ok: false, status: 401 });
    expect(resolveActingUserId(headers({ "x-user-id": "admin" }), { NODE_ENV: "test" })).toMatchObject({ ok: false, status: 400 });
  });
  it("refuses the header in production unless an operator opts in", () => {
    expect(resolveActingUserId(headers({ "x-user-id": USER }), { NODE_ENV: "production" })).toMatchObject({ ok: false, status: 401 });
    expect(resolveActingUserId(headers({ "x-user-id": USER }), { NODE_ENV: "production", ALLOW_DEV_USER_HEADER: "1" }).ok).toBe(true);
  });
});

describe("mapHandledError", () => {
  it("maps a pending approval to 423 with the visible placeholder", () => {
    setBlockedActionSink(() => {});
    let err: unknown;
    try {
      requireApproval(RULE_GATES.conflictRules.key);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PendingApprovalError);
    const mapped = mapHandledError(err)!;
    expect(mapped.status).toBe(423);
    expect(String(mapped.body.message)).toContain("PENDING");
  });
  it("maps access, neutrality and validation errors; leaves the rest to a 500", () => {
    expect(mapHandledError(new AccessDeniedError("decide", "u"))?.status).toBe(403);
    expect(mapHandledError(new LetterNotNeutralError(["mentions 'conflict'"]))?.status).toBe(422);
    expect(mapHandledError(new ConflictError("Nope", 409, ["a"]))).toEqual({ status: 409, body: { error: "Nope", details: ["a"] } });
    expect(mapHandledError(new Error("boom"))).toBeNull();
  });
});

describe("body readers", () => {
  it("rejects non-JSON and non-object bodies", async () => {
    await expect(readBody(new Request("http://x", { method: "POST", body: "nope" }))).rejects.toThrow(ConflictError);
    await expect(readBody(new Request("http://x", { method: "POST", body: "[1]" }))).rejects.toThrow(ConflictError);
    expect(await readBody(new Request("http://x", { method: "POST", body: '{"a":1}' }))).toEqual({ a: 1 });
  });
  it("validates ids, enums, lists and dates", () => {
    expect(reqUuid({ id: USER }, "id")).toBe(USER);
    expect(() => reqUuid({ id: "x" }, "id")).toThrow(ConflictError);
    expect(oneOf({ d: "cleared" }, "d", ["cleared", "declined"] as const)).toBe("cleared");
    expect(() => oneOf({ d: "maybe" }, "d", ["cleared"] as const)).toThrow(ConflictError);
    expect(uuidList({}, "ids")).toEqual([]);
    expect(() => uuidList({ ids: ["x"] }, "ids")).toThrow(ConflictError);
    expect(optDate({ at: "2026-10-01T10:00:00Z" }, "at")?.toISOString()).toBe("2026-10-01T10:00:00.000Z");
    expect(() => optDate({ at: "soon" }, "at")).toThrow(ConflictError);
  });
});

describe("parseInquiryParties", () => {
  it("keeps known fields and normalises kind/completeness", () => {
    const [p] = parseInquiryParties([{ name: "Pat", role: "prospective_client", kind: "robot", variants: [{ name: "Patty", type: "nickname" }], extra: "ignored" }]);
    expect(p).toMatchObject({ name: "Pat", role: "prospective_client", kind: "person", completeness: "full", variants: [{ name: "Patty", type: "nickname" }] });
    expect(p).not.toHaveProperty("extra");
  });
  it("rejects bad shapes", () => {
    expect(() => parseInquiryParties("x")).toThrow(ConflictError);
    expect(() => parseInquiryParties([{ name: "Pat", role: "boss" }])).toThrow(ConflictError);
    expect(() => parseInquiryParties([{ name: 5, role: "prospective_client" }])).toThrow(ConflictError);
    expect(() => parseInquiryParties([{ name: "P", role: "prospective_client", variants: [{ name: "Q", type: "stage" }] }])).toThrow(ConflictError);
  });
});

describe("conflictRoute", () => {
  it("answers 401 before touching the database when no user is given", async () => {
    const res = await conflictRoute("TEST", new Request("http://x"), async () => "never");
    expect(res.status).toBe(401);
  });
});
