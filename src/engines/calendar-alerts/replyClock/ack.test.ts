import { afterEach, describe, expect, it } from "vitest";
import { InMemoryApprovalSource, isPlaceholder, refreshApprovals, resetApprovalStateForTests, setApprovalSource } from "@/compliance/approvals";
import { ALERT_COPY_GATES } from "../gates";
import { TZ, chicago } from "../testFixtures";
import { composeAcknowledgement } from "./ack";
import { toClientThread, type MessageRow } from "./service";

async function approve(...keys: Array<{ key: string; text?: string }>) {
  const src = new InMemoryApprovalSource();
  for (const k of keys) src.approve({ gateKey: k.key, reviewerKind: "attorney", approvedByName: "Atty", approvedText: k.text ?? null });
  setApprovalSource(src);
  await refreshApprovals();
}

describe("composeAcknowledgement (c43 rule 6 / c44 rule 5)", () => {
  afterEach(() => resetApprovalStateForTests());
  const promiseAt = chicago(7, 17);

  it("is HELD with a visible placeholder until the attorney approves the wording", () => {
    const ack = composeAcknowledgement({ tier: "standard", promiseAt, timeZone: TZ, imminent: false, firmPhone: null });
    expect(ack.deliverable).toBe(false);
    expect(isPlaceholder(ack.text)).toBe(true);
    expect(ack.heldBecause).toEqual([`pending review: ${ALERT_COPY_GATES.replyAck.key}`]);
  });

  it("states a concrete reply-by time once approved", async () => {
    await approve({ key: ALERT_COPY_GATES.replyAck.key });
    const ack = composeAcknowledgement({ tier: "standard", promiseAt, timeZone: TZ, imminent: false, firmPhone: null });
    expect(ack.deliverable).toBe(true);
    expect(ack.text).toContain("Wednesday, October 7 at 5:00 PM CDT");
  });

  it("adds the urgent-call line only when the client says the event is imminent and a phone is set", async () => {
    await approve({ key: ALERT_COPY_GATES.deadlineReplyAck.key }, { key: ALERT_COPY_GATES.urgentCallLine.key });
    const ack = composeAcknowledgement({ tier: "deadline", promiseAt, timeZone: TZ, imminent: true, firmPhone: "512-555-0100" });
    expect(ack.deliverable).toBe(true);
    expect(ack.text).toContain("512-555-0100");
    expect(composeAcknowledgement({ tier: "deadline", promiseAt, timeZone: TZ, imminent: true, firmPhone: null }).text).not.toContain("call our office");
  });

  it("refuses approved deadline wording that would state a date (code guard, not only review)", async () => {
    await approve({ key: ALERT_COPY_GATES.deadlineReplyAck.key, text: "Your hearing is on Oct 14. We will reply by {replyBy}." });
    const ack = composeAcknowledgement({ tier: "deadline", promiseAt, timeZone: TZ, imminent: false, firmPhone: null });
    expect(ack.deliverable).toBe(false);
    expect(ack.heldBecause.join(" ")).toMatch(/deadline guard/);
  });
});

describe("toClientThread", () => {
  const base = {
    tenantId: "t",
    matterId: "m",
    threadKey: "main",
    senderUserId: null,
    senderPartyId: null,
    isAutoAck: false,
    autoSubmitted: false,
    expectsReply: false,
    replyWindowHours: null,
    relatedCalendarEventId: null,
    deadlineRelated: true,
    deadlineTagSource: "rules",
    deadlineTagDetail: { secret: true },
    clientStatedEventAt: null,
    urgent: true,
    inReplyToMessageId: null,
    inReplyToUpdateId: null,
    createdAt: chicago(5, 9),
    occurredAt: chicago(5, 9),
  } satisfies Omit<MessageRow, "id" | "direction" | "senderType" | "clientPartyId" | "channel" | "body" | "deliveryState">;

  it("hides held acknowledgements, phone logs, other clients' messages and every internal tag", () => {
    const rows: MessageRow[] = [
      { ...base, id: "1", direction: "inbound", senderType: "client", clientPartyId: "p1", channel: "portal", body: "When is my hearing?", deliveryState: "logged" },
      { ...base, id: "2", direction: "outbound", senderType: "system", clientPartyId: "p1", channel: "portal", body: "[PENDING …]", deliveryState: "held", isAutoAck: true },
      { ...base, id: "3", direction: "outbound", senderType: "user", clientPartyId: "p1", channel: "phone_log", body: "Called", deliveryState: "logged" },
      { ...base, id: "4", direction: "outbound", senderType: "user", clientPartyId: "p2", channel: "portal", body: "Other client", deliveryState: "delivered" },
      { ...base, id: "5", direction: "outbound", senderType: "user", clientPartyId: "p1", channel: "portal", body: "Reply", deliveryState: "delivered" },
    ];
    const view = toClientThread(rows, "p1");
    expect(view.map((v) => v.id)).toEqual(["1", "5"]);
    expect(Object.keys(view[0]!)).toEqual(["id", "direction", "fromFirm", "body", "occurredAt"]);
  });
});
