import { describe, it, expect } from "vitest";
import { CAL, chi } from "../__tests__/fixtures";
import {
  availabilitySource,
  bookingBlockReasons,
  canTransition,
  consultEventTitle,
  feeStepFor,
  freeSlots,
  meetingTypeFor,
  noShowAction,
  reminderTimes,
  stageForOutcome,
} from "./slots";

describe("c67 when booking is offered", () => {
  const ok = { conflict: "clear" as const, fitOutcome: "fit", safetySuppressed: false, terminalState: null, status: "active" };
  it("only after a clear conflict result or a lawyer's clearing decision", () => {
    expect(bookingBlockReasons(ok)).toEqual([]);
    expect(bookingBlockReasons({ ...ok, conflict: "attorney_cleared" })).toEqual([]);
    expect(bookingBlockReasons({ ...ok, conflict: "possible_pending" })).toEqual(["conflict_not_clear"]);
    expect(bookingBlockReasons({ ...ok, conflict: "none" })).toEqual(["conflict_not_checked"]);
  });

  it("never for no-fit, unconfirmed safety contact, closed or emergency-paused inquiries", () => {
    expect(bookingBlockReasons({ ...ok, fitOutcome: "no_fit" })).toEqual(["not_a_fit"]);
    expect(bookingBlockReasons({ ...ok, safetySuppressed: true })).toEqual(["safety_contact_unconfirmed"]);
    expect(bookingBlockReasons({ ...ok, terminalState: "abandoned", status: "paused_emergency" })).toEqual(["session_closed", "emergency_pause"]);
  });
});

describe("c67 free slots", () => {
  const rules = { durationMinutes: 60, bufferMinutes: 15, stepMinutes: 30, earliest: chi(2026, 10, 5, 13, 10), horizonEnd: chi(2026, 10, 5, 23) };

  it("slots align to opening time, stay inside business hours and after the lead time", () => {
    const slots = freeSlots(CAL, [], rules);
    expect(slots[0]!.start).toEqual(chi(2026, 10, 5, 13, 30));
    expect(slots.at(-1)!.start).toEqual(chi(2026, 10, 5, 16, 0));
    expect(slots.at(-1)!.end).toEqual(chi(2026, 10, 5, 17, 0));
  });

  it("busy time plus buffer is avoided", () => {
    const busy = [{ start: chi(2026, 10, 5, 14, 30), end: chi(2026, 10, 5, 15, 0) }];
    const starts = freeSlots(CAL, busy, rules).map((s) => s.start.getTime());
    expect(starts).not.toContain(chi(2026, 10, 5, 14, 0).getTime()); // would end 15:00 but buffer overlaps
    expect(starts).not.toContain(chi(2026, 10, 5, 13, 30).getTime()); // 13:30–14:30 + 15 min buffer overlaps 14:30
    expect(starts).toContain(chi(2026, 10, 5, 15, 30).getTime());
  });

  it("no slots on weekends or holidays", () => {
    expect(freeSlots(CAL, [], { ...rules, earliest: chi(2026, 11, 26, 8), horizonEnd: chi(2026, 11, 26, 20) })).toEqual([]);
  });
});

describe("c67 availability and fees", () => {
  const now = chi(2026, 10, 5, 12);
  it("internal calendar when no connection; external only when fresh and the vendor is approved", () => {
    expect(availabilitySource({ hasConnection: false, lastSyncedAt: null, now, staleMinutes: 5, syncApproved: false })).toMatchObject({ usable: true, source: "internal" });
    expect(availabilitySource({ hasConnection: true, lastSyncedAt: now, now, staleMinutes: 5, syncApproved: false }).usable).toBe(false);
    expect(availabilitySource({ hasConnection: true, lastSyncedAt: new Date(now.getTime() - 10 * 60_000), now, staleMinutes: 5, syncApproved: true }).usable).toBe(false);
    expect(availabilitySource({ hasConnection: true, lastSyncedAt: new Date(now.getTime() - 60_000), now, staleMinutes: 5, syncApproved: true })).toMatchObject({ usable: true, source: "external" });
  });

  it("consult fees are never collected in-product before the reviews (acceptance 5)", () => {
    expect(meetingTypeFor("family_custody", ["FAMILY_CUSTODY"])).toBe("paid_consult");
    expect(meetingTypeFor(null, ["x"])).toBe("initial_meeting");
    const base = { meetingType: "paid_consult" as const, feeCents: 15000, destination: null, feeTermsApproved: false, processorApproved: false, trustRulesApproved: false };
    expect(feeStepFor({ ...base, meetingType: "initial_meeting" }).step).toBe("not_required");
    const out = feeStepFor(base);
    expect(out.step).toBe("outside_system");
    expect(out.note).toMatch(/outside the system/);
    expect(feeStepFor({ ...base, destination: "trust", feeTermsApproved: true, processorApproved: true }).note).toMatch(/trust-accounting/);
    expect(feeStepFor({ ...base, destination: "operating", feeTermsApproved: true, processorApproved: true }).step).toBe("blocked_pending_review");
  });
});

describe("c67 reminders, no-shows and outcomes", () => {
  it("reminders at 24 h and 2 h before, real clock, future only", () => {
    const start = chi(2026, 10, 7, 10);
    expect(reminderTimes(start, [2, 24, 24], chi(2026, 10, 5, 12)).map((r) => r.at)).toEqual([chi(2026, 10, 6, 10), chi(2026, 10, 7, 8)]);
    expect(reminderTimes(start, [24, 2], chi(2026, 10, 6, 12)).map((r) => r.offsetHours)).toEqual([2]);
  });

  it("one re-book offer, then staff are flagged (acceptance 4)", () => {
    expect(noShowAction({ rebookOffers: 1, previousWasNoShow: false })).toBe("offer_rebook");
    expect(noShowAction({ rebookOffers: 1, previousWasNoShow: true })).toBe("flag_staff");
    expect(noShowAction({ rebookOffers: 0, previousWasNoShow: false })).toBe("flag_staff");
  });

  it("outcomes move the matter stage; status transitions are enforced", () => {
    expect(stageForOutcome("retain_offered")).toBe("consult_completed_manual_follow_up");
    expect(stageForOutcome("client_declined")).toBe("did_not_hire_referred_out");
    expect(canTransition("held", "booked")).toBe(true);
    expect(canTransition("completed", "booked")).toBe(false);
    expect(canTransition("booked", "no_show")).toBe(true);
  });

  it("calendar titles carry initials only, never case facts (acceptance 7)", () => {
    expect(consultEventTitle("ana maria lopez garcia")).toBe("Consult - AML");
    expect(consultEventTitle(null)).toBe("Consult");
  });
});
