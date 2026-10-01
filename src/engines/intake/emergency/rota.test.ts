import { describe, it, expect } from "vitest";
import { chi } from "../__tests__/fixtures";
import { escalationStep, findCoverageGaps, onCallAt, shiftCovers, type RotaShift } from "./rota";

const TZ = "America/Chicago";
const weekly = (userId: string, role: RotaShift["role"], weekday: string, startTime: string, endTime: string): RotaShift => ({
  userId,
  role,
  active: true,
  startsAt: null,
  endsAt: null,
  weekday,
  startTime,
  endTime,
});

describe("c66 on-call rota (real clock)", () => {
  it("weekly shifts cover their local hours, including overnight shifts", () => {
    const night = weekly("u1", "primary", "mon", "17:00", "09:00");
    expect(shiftCovers(night, chi(2026, 10, 5, 22), TZ)).toBe(true); // Monday 22:00
    expect(shiftCovers(night, chi(2026, 10, 6, 3), TZ)).toBe(true); // Tuesday 03:00
    expect(shiftCovers(night, chi(2026, 10, 6, 10), TZ)).toBe(false);
    expect(shiftCovers({ ...night, active: false }, chi(2026, 10, 5, 22), TZ)).toBe(false);
  });

  it("one-off shifts cover [start, end)", () => {
    const s: RotaShift = { userId: "u", role: "backup", active: true, startsAt: chi(2026, 10, 10, 0), endsAt: chi(2026, 10, 11, 0), weekday: null, startTime: null, endTime: null };
    expect(shiftCovers(s, chi(2026, 10, 10, 12), TZ)).toBe(true);
    expect(shiftCovers(s, chi(2026, 10, 11, 0), TZ)).toBe(false);
  });

  it("escalates on-call → backup → owners → whole chain; empty steps fall to owners", () => {
    const onCall = onCallAt([weekly("p", "primary", "mon", "00:00", "24:00"), weekly("s", "staff", "mon", "00:00", "24:00"), weekly("b", "backup", "mon", "00:00", "24:00")], chi(2026, 10, 5, 12), TZ);
    expect(escalationStep(0, onCall, ["o"], "safety").userIds).toEqual(["p", "s"]);
    expect(escalationStep(0, onCall, ["o"], "urgent_legal").userIds).toEqual(["p"]);
    expect(escalationStep(1, onCall, ["o"], "urgent_legal").userIds).toEqual(["b"]);
    expect(escalationStep(2, onCall, ["o"], "urgent_legal")).toMatchObject({ userIds: ["o"], label: "owners" });
    expect(escalationStep(3, onCall, ["o"], "urgent_legal").userIds.sort()).toEqual(["b", "o", "p", "s"]);
    const empty = { primary: [], backup: [], staff: [] };
    expect(escalationStep(0, empty, ["o"], "safety")).toEqual({ step: 0, userIds: ["o"], label: "owners", rotaGap: true });
  });

  it("finds coverage gaps with no primary on call", () => {
    const shifts = [weekly("p", "primary", "mon", "09:00", "17:00")];
    const gaps = findCoverageGaps(shifts, chi(2026, 10, 5, 8), chi(2026, 10, 5, 18), TZ, 30);
    expect(gaps).toEqual([
      { start: chi(2026, 10, 5, 8), end: chi(2026, 10, 5, 9) },
      { start: chi(2026, 10, 5, 17), end: chi(2026, 10, 5, 18) },
    ]);
  });
});
