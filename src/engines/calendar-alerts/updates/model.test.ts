import { describe, expect, it } from "vitest";
import { TZ, chicago } from "../testFixtures";
import { draftFromConfirmedEvent, reviewUpdateText, summariseDelivery, toClientHistory, type UpdateRowLike } from "./model";

describe("draftFromConfirmedEvent (c54 rule 4: facts and dates only)", () => {
  const hearing = { eventType: "hearing", status: "confirmed", startsAt: chicago(14, 9, 30), allDay: false, location: "Room 4B", courtName: "Travis County 53rd District Court", cancelledAt: null };

  it("states the confirmed fact and passes the draft checker", () => {
    const d = draftFromConfirmedEvent(hearing, TZ);
    expect("body" in d && d.body).toBe(
      "A hearing has been scheduled for Wednesday, October 14, 2026 at 9:30 AM CDT (Travis County 53rd District Court, Room 4B). Your legal team will contact you about any preparation needed."
    );
    if ("body" in d) expect(reviewUpdateText(d.body, "system_draft")).toEqual([]);
  });

  it("refuses unconfirmed or cancelled entries and deadline-type entries", () => {
    expect(draftFromConfirmedEvent({ ...hearing, status: "proposed" }, TZ)).toHaveProperty("refused");
    expect(draftFromConfirmedEvent({ ...hearing, cancelledAt: chicago(10, 9) }, TZ)).toHaveProperty("refused");
    expect(draftFromConfirmedEvent({ ...hearing, eventType: "filing_deadline" }, TZ)).toHaveProperty("refused");
  });
});

describe("reviewUpdateText", () => {
  it("drafts: no predictions or advice; humans: no internal data; lawyer edits count as human", () => {
    expect(reviewUpdateText("We will likely win at the hearing.", "ai")).toContain("likelihood");
    expect(reviewUpdateText("We will likely win at the hearing.", "user")).toEqual([]);
    expect(reviewUpdateText("Your file was flagged as overdue internally.", "user")).toEqual(expect.arrayContaining(["overdue", "flag"]));
    expect(reviewUpdateText("We will likely win at the hearing.", "ai", true)).toEqual([]);
    expect(reviewUpdateText("  ", "user")).toEqual(["empty"]);
  });
});

describe("toClientHistory (c54 rules 1, 5)", () => {
  const u = (id: string, sentAt: Date | null, over: Partial<UpdateRowLike> = {}): UpdateRowLike => ({
    id,
    matterId: "m",
    recipientPartyIds: ["p1"],
    body: `Update ${id}`,
    status: sentAt ? "sent" : "pending_approval",
    sentAt,
    correctsUpdateId: null,
    authorType: "user",
    language: "en",
    ...over,
  });

  it("newest first, only sent updates addressed to this client, corrections linked both ways", () => {
    const rows = [
      u("a", chicago(1, 9), { body: "Hearing set for Oct 14" }),
      u("b", chicago(3, 9), { correctsUpdateId: "a", body: "Correction: hearing set for Oct 15" }),
      u("draft", null),
      u("other", chicago(4, 9), { recipientPartyIds: ["p2"] }),
    ];
    const view = toClientHistory(rows, "p1");
    expect(view.map((v) => v.id)).toEqual(["b", "a"]);
    expect(view[1]!.correctedBy).toEqual({ id: "b", sentAt: chicago(3, 9) });
    expect(view[0]!.correctsUpdateId).toBe("a");
  });

  it("searches the text (acceptance 4)", () => {
    const rows = [u("a", chicago(1, 9), { body: "Hearing set" }), u("b", chicago(2, 9), { body: "Documents received" })];
    expect(toClientHistory(rows, "p1", "HEARING").map((v) => v.id)).toEqual(["a"]);
  });
});

describe("summariseDelivery", () => {
  it("shows per-recipient in-app and email status with the reason", () => {
    expect(
      summariseDelivery([
        { channel: "in_app", status: "delivered", recipientPartyId: "p1", lastError: null },
        { channel: "email", status: "bounced", recipientPartyId: "p1", lastError: "mailbox full" },
      ])
    ).toEqual([{ partyId: "p1", inApp: "delivered", email: "bounced", emailNote: "mailbox full" }]);
  });
});
