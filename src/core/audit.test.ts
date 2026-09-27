import { describe, it, expect } from "vitest";
import { buildAuditRow } from "./audit";

describe("buildAuditRow", () => {
  it("shapes a one-line audit call into a row", () => {
    const row = buildAuditRow({
      tenantId: "t-1",
      engine: "conflict-check",
      action: "check.run",
      matterId: "m-1",
      actor: { type: "user", userId: "u-1" },
      payload: { outcome: "possible" },
    });
    expect(row).toMatchObject({
      tenantId: "t-1",
      engine: "conflict-check",
      action: "check.run",
      matterId: "m-1",
      actorType: "user",
      actorUserId: "u-1",
      actorPartyId: null,
      payload: { outcome: "possible" },
    });
  });

  it("defaults to the system actor and records the AI model", () => {
    expect(buildAuditRow({ tenantId: "t", engine: "core", action: "x.y" }).actorType).toBe("system");
    const ai = buildAuditRow({ tenantId: "t", engine: "intake", action: "triage.suggested", actor: { type: "ai", model: "m-1" } });
    expect(ai).toMatchObject({ actorType: "ai", payload: { aiModel: "m-1" } });
    const client = buildAuditRow({ tenantId: "t", engine: "document", action: "doc.uploaded", actor: { type: "client", partyId: "p" } });
    expect(client).toMatchObject({ actorType: "client", actorPartyId: "p" });
  });

  it("rejects missing tenant, engine or malformed actions", () => {
    expect(() => buildAuditRow({ tenantId: "", engine: "core", action: "a" })).toThrow(/tenantId/);
    expect(() => buildAuditRow({ tenantId: "t", engine: " ", action: "a" })).toThrow(/engine/);
    expect(() => buildAuditRow({ tenantId: "t", engine: "core", action: "Task Completed" })).toThrow(/dotted/);
  });
});
