import { describe, expect, it } from "vitest";
import { chicago } from "../testFixtures";
import { buildDeadlineContext, isDeadlineEvent } from "./context";

describe("buildDeadlineContext (c44 §4.6 — what the lawyer sees)", () => {
  const now = chicago(5, 10);
  const row = (id: string, eventType: string, startsAt: Date, status: string, isDeadline = false) => ({
    id,
    title: id,
    eventType,
    startsAt,
    isDeadline,
    status,
  });

  it("only CONFIRMED deadline-type entries feed the safety net; proposals are shown as unconfirmed", () => {
    const ctx = buildDeadlineContext(
      [
        row("hearing", "hearing", chicago(7, 9), "confirmed"),
        row("meeting", "client_meeting", chicago(6, 9), "confirmed"),
        row("ai-guess", "filing_deadline", chicago(6, 9), "proposed"),
        row("far", "trial", chicago(30, 9), "confirmed"),
        row("cancelled", "hearing", chicago(6, 9), "cancelled"),
      ],
      now,
      14
    );
    expect(ctx.confirmed.map((e) => e.id)).toEqual(["hearing", "meeting", "far"]);
    expect(ctx.unconfirmed).toEqual([expect.objectContaining({ id: "ai-guess", label: "unconfirmed" })]);
    expect(ctx.relevant.map((d) => d.title)).toEqual(["hearing"]);
    expect(ctx.relevant[0]).toMatchObject({ source: "calendar", calendarEventId: "hearing" });
  });

  it("a deadline from the last 48 hours still counts (a question about yesterday's hearing)", () => {
    const ctx = buildDeadlineContext([row("y", "hearing", chicago(4, 9), "confirmed")], now, 14);
    expect(ctx.relevant).toHaveLength(1);
  });

  it("isDeadline marks any event type as a deadline", () => {
    expect(isDeadlineEvent({ eventType: "other", isDeadline: true })).toBe(true);
    expect(isDeadlineEvent({ eventType: "client_meeting", isDeadline: false })).toBe(false);
  });
});
