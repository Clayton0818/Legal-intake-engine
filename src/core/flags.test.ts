import { describe, it, expect } from "vitest";
import {
  DEFAULT_CLIENT_FLAG_COPY,
  INTERNAL_FLAG_TEMPLATE,
  planFlagNotifications,
  validateFlagInput,
  type RaiseFlagInput,
} from "./flags";
import { assertClientVisible, clientVisible, isClientVisible } from "./visibility";

const internalFlag: RaiseFlagInput = {
  tenantId: "t-1",
  type: "task.overdue",
  severity: "warning",
  audience: "internal",
  title: "Reply to Ana is overdue",
  recipients: { userIds: ["u-lawyer"] },
};

describe("validateFlagInput", () => {
  it("accepts a valid internal flag", () => {
    expect(validateFlagInput(internalFlag)).toEqual([]);
  });

  it("never addresses an internal flag to a client (founder rule)", () => {
    const errors = validateFlagInput({ ...internalFlag, recipients: { userIds: ["u-1"], partyIds: ["p-1"] } });
    expect(errors.join(" ")).toMatch(/never be addressed to a client/);
  });

  it("client-side flags need a client recipient and a defined wording gate", () => {
    expect(validateFlagInput({ ...internalFlag, audience: "both" }).join(" ")).toMatch(/client party recipient/);
    expect(
      validateFlagInput({ ...internalFlag, audience: "both", recipients: { userIds: ["u-1"], partyIds: ["p-1"] } })
    ).toEqual([]);
    expect(
      validateFlagInput({
        ...internalFlag,
        audience: "both",
        clientCopyKey: "copy.not.defined",
        recipients: { partyIds: ["p-1"] },
      }).join(" ")
    ).toMatch(/not a defined approval gate/);
  });

  it("audience 'client' is client-only", () => {
    expect(
      validateFlagInput({ ...internalFlag, audience: "client", recipients: { userIds: ["u-1"], partyIds: ["p-1"] } }).join(" ")
    ).toMatch(/audience 'both'/);
  });

  it("a flag must go somewhere, and must be well formed", () => {
    expect(validateFlagInput({ ...internalFlag, recipients: {} }).join(" ")).toMatch(/at least one recipient/);
    expect(validateFlagInput({ ...internalFlag, type: "overdue" }).join(" ")).toMatch(/namespaced/);
    expect(validateFlagInput({ ...internalFlag, severity: "urgent" as never }).join(" ")).toMatch(/severity/);
    expect(validateFlagInput({ ...internalFlag, title: "" }).join(" ")).toMatch(/title/);
  });
});

describe("planFlagNotifications (c51: in-app + email to every affected party)", () => {
  const row = {
    id: "f-1",
    type: "task.overdue",
    severity: "high",
    title: "Reply to Ana is overdue",
    summary: "Message received Fri 6pm; 24 business hours passed.",
    recipientUserIds: ["u-1", "u-2"],
    recipientPartyIds: [] as string[],
    clientCopyKey: null,
    audience: "internal",
  };

  it("sends staff an in-app row and an email each", () => {
    const planned = planFlagNotifications(row);
    expect(planned).toHaveLength(4);
    expect(planned.map((p) => p.channel).sort()).toEqual(["email", "email", "in_app", "in_app"]);
    expect(planned.every((p) => p.recipient.type === "user" && p.templateKey === INTERNAL_FLAG_TEMPLATE)).toBe(true);
    expect(planned[0]?.payload).toMatchObject({ subject: "[HIGH] Reply to Ana is overdue" });
  });

  it("never plans a client notification for an internal flag, even if party ids slipped in", () => {
    const planned = planFlagNotifications({ ...row, recipientPartyIds: ["p-1"] });
    expect(planned.some((p) => p.recipient.type === "party")).toBe(false);
  });

  it("gives clients only the approved-wording key and the flag id — no internal text", () => {
    const planned = planFlagNotifications({ ...row, audience: "both", recipientUserIds: [], recipientPartyIds: ["p-1"] });
    expect(planned).toHaveLength(2);
    for (const p of planned) {
      expect(p.recipient).toEqual({ type: "party", partyId: "p-1" });
      expect(p.templateKey).toBe(DEFAULT_CLIENT_FLAG_COPY);
      expect(p.payload).toEqual({ flagId: "f-1" });
      expect(JSON.stringify(p)).not.toContain("overdue");
    }
  });

  it("respects the channel list and a recipient subset (escalation notifies only new people)", () => {
    const planned = planFlagNotifications(row, ["email"], { userIds: ["u-9"] });
    expect(planned).toEqual([expect.objectContaining({ channel: "email", recipient: { type: "user", userId: "u-9" } })]);
  });
});

describe("visibility boundary (clientVisible)", () => {
  const flags = [
    { id: 1, audience: "internal" },
    { id: 2, audience: "client" },
    { id: 3, audience: "both" },
    { id: 4, audience: "something-new" },
  ];
  const tasks = [
    { id: "a", visibility: "internal" },
    { id: "b", visibility: "client" },
  ];

  it("drops internal and unknown rows", () => {
    expect(clientVisible(flags).map((f) => f.id)).toEqual([2, 3]);
    expect(clientVisible(tasks).map((t) => t.id)).toEqual(["b"]);
    expect(isClientVisible({ audience: "internal" })).toBe(false);
  });

  it("assertClientVisible throws when an internal row reaches a client path", () => {
    expect(() => assertClientVisible(flags)).toThrow(/Visibility violation: 2/);
    expect(assertClientVisible([{ audience: "both" }])).toHaveLength(1);
  });
});
