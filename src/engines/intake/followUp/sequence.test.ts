import { describe, it, expect } from "vitest";
import { CAL, chi } from "../__tests__/fixtures";
import { closingFor, detectStop, followUpEligibility, stepDueAt, type FollowUpContext } from "./sequence";

const ok: FollowUpContext = {
  trigger: "not_booked",
  enabled: true,
  outreachApproved: true,
  templateApproved: true,
  inboundFirst: true,
  stopped: false,
  declined: false,
  conflict: "clear",
  safetySuppressed: false,
  represented: false,
  practiceArea: "family",
  personalInjuryApproved: false,
  booked: false,
  signed: false,
  continued: false,
  humanReplied: false,
  hasChannel: true,
};

describe("c70 STOP detection", () => {
  it("keywords end follow-ups on any channel, English and Spanish", () => {
    for (const w of ["STOP", "stop.", "Unsubscribe", "ALTO", "cancelar"]) expect(detectStop(w).stop).toBe(true);
    expect(detectStop("please don't text me again")).toEqual({ stop: true, kind: "natural_language" });
    expect(detectStop("no me contacten")).toMatchObject({ stop: true });
    expect(detectStop("can I stop by the office tomorrow?").stop).toBe(false);
    expect(detectStop("basta", []).stop).toBe(true);
    expect(detectStop("enough", ["enough"]).stop).toBe(true);
  });
});

describe("c70 eligibility", () => {
  it("an eligible lead", () => {
    expect(followUpEligibility(ok)).toEqual({ eligible: true });
  });

  it("blocked until the barratry/advertising review and the template review are approved", () => {
    expect(followUpEligibility({ ...ok, outreachApproved: false })).toEqual({ eligible: false, reason: "outreach_pending_review" });
    expect(followUpEligibility({ ...ok, templateApproved: false })).toEqual({ eligible: false, reason: "template_pending_review" });
    expect(followUpEligibility({ ...ok, enabled: false })).toEqual({ eligible: false, reason: "disabled" });
  });

  it("never cold, never after STOP, decline, conflict or safety flag", () => {
    expect(followUpEligibility({ ...ok, inboundFirst: false })).toMatchObject({ reason: "not_inbound_first" });
    expect(followUpEligibility({ ...ok, stopped: true })).toMatchObject({ reason: "stopped" });
    expect(followUpEligibility({ ...ok, declined: true })).toMatchObject({ reason: "declined" });
    expect(followUpEligibility({ ...ok, conflict: "definite" })).toMatchObject({ reason: "conflict" });
    expect(followUpEligibility({ ...ok, conflict: "possible_pending" })).toMatchObject({ reason: "conflict_pending" });
    expect(followUpEligibility({ ...ok, safetySuppressed: true })).toMatchObject({ reason: "safety" });
    expect(followUpEligibility({ ...ok, represented: true })).toMatchObject({ reason: "represented" });
    expect(followUpEligibility({ ...ok, practiceArea: "personal_injury" })).toMatchObject({ reason: "personal_injury" });
  });

  it("stops once the goal is reached", () => {
    expect(followUpEligibility({ ...ok, booked: true })).toMatchObject({ reason: "booked" });
    expect(followUpEligibility({ ...ok, trigger: "not_signed", booked: true })).toEqual({ eligible: true });
    expect(followUpEligibility({ ...ok, signed: true })).toMatchObject({ reason: "signed" });
    expect(followUpEligibility({ ...ok, trigger: "abandoned_chat", continued: true })).toMatchObject({ reason: "continued" });
    expect(followUpEligibility({ ...ok, humanReplied: true })).toMatchObject({ reason: "human_replied" });
    expect(followUpEligibility({ ...ok, hasChannel: false })).toMatchObject({ reason: "no_channel" });
  });
});

describe("c70 timing", () => {
  it("steps land in firm business hours", () => {
    const fri = chi(2026, 10, 9, 20); // Friday 20:00
    expect(stepDueAt(fri, [1, 4, 10], 0, CAL)).toEqual(chi(2026, 10, 12, 9)); // Saturday → Monday 09:00
    expect(stepDueAt(chi(2026, 10, 5, 10), [1, 4, 10], 1, CAL)).toEqual(chi(2026, 10, 9, 10));
    expect(stepDueAt(fri, [1], 1, CAL)).toBeNull();
  });

  it("closing the lead after the last step", () => {
    expect(closingFor("not_booked")).toEqual({ terminalState: "did_not_schedule", lawyerDecision: false });
    expect(closingFor("not_signed")).toEqual({ terminalState: null, lawyerDecision: true });
    expect(closingFor("abandoned_chat").terminalState).toBe("abandoned");
  });
});
