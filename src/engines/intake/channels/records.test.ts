import { describe, it, expect } from "vitest";
import { canRecord, caseDetailsLock, hasUsableContact, isIntakeChannel, normalizeEmail, normalizePhone, planReplies, suggestDuplicates } from "./records";

describe("c65 channel records", () => {
  it("normalises phones and emails", () => {
    expect(normalizePhone("(512) 555-0100")).toBe("+15125550100");
    expect(normalizePhone("1 512 555 0100")).toBe("+15125550100");
    expect(normalizePhone("+52 55 1234 5678")).toBe("+525512345678");
    expect(normalizePhone("123")).toBeNull();
    expect(normalizeEmail(" Ana@Example.COM ")).toBe("ana@example.com");
    expect(normalizeEmail("not-an-email")).toBeNull();
    expect(hasUsableContact({ email: null, phone: "5125550100" })).toBe(true);
    expect(hasUsableContact({})).toBe(false);
    expect(isIntakeChannel("sms")).toBe(true);
    expect(isIntakeChannel("fax")).toBe(false);
  });

  it("case details stay locked until disclosures, conflict minimum and a clear check", () => {
    const base = { disclosuresAcknowledgedAt: null, conflictMinimum: {}, conflictState: "none" as const, status: "active" };
    expect(caseDetailsLock(base).reasons).toEqual(["disclosures_not_acknowledged", "conflict_minimum_missing", "conflict_check_not_run"]);
    const ready = { disclosuresAcknowledgedAt: new Date(), conflictMinimum: { fullName: "Ana", otherPartyNames: ["Bo"] }, status: "active" };
    expect(caseDetailsLock({ ...ready, conflictState: "possible_pending" }).reasons).toEqual(["conflict_not_clear"]);
    expect(caseDetailsLock({ ...ready, conflictState: "clear" })).toEqual({ locked: false, reasons: [] });
    expect(caseDetailsLock({ ...ready, conflictState: "attorney_cleared" }).locked).toBe(false);
    expect(caseDetailsLock({ ...ready, conflictState: "clear", status: "paused_emergency" }).reasons).toEqual(["emergency_pause"]);
  });

  it("a new session gets the channel's opening then the AI acknowledgement", () => {
    const base = { isNewSession: true, safetyDetected: false, urgentDetected: false, pausedForEmergency: false, safeContactAsked: false, isStop: false };
    expect(planReplies({ ...base, channel: "web_chat" })).toEqual(["channel_disclosure", "ai_acknowledgement"]);
    expect(planReplies({ ...base, channel: "phone_ai" })).toEqual(["recording_prompt", "ai_acknowledgement"]);
    expect(planReplies({ ...base, channel: "sms" })).toEqual(["sms_first_reply", "ai_acknowledgement"]);
    expect(planReplies({ ...base, channel: "email" })).toEqual(["email_auto_reply", "ai_acknowledgement"]);
    expect(planReplies({ ...base, channel: "walk_in" })).toEqual([]);
  });

  it("safety comes first: 911 message, the safe-contact question once, no acknowledgement", () => {
    const base = { channel: "web_chat" as const, isNewSession: true, urgentDetected: false, pausedForEmergency: false, isStop: false };
    expect(planReplies({ ...base, safetyDetected: true, safeContactAsked: false })).toEqual(["safety_911", "safe_contact_question", "channel_disclosure"]);
    expect(planReplies({ ...base, isNewSession: false, safetyDetected: true, safeContactAsked: true })).toEqual(["safety_911"]);
  });

  it("while paused for an emergency only 'a person has been alerted' is said; STOP gets nothing", () => {
    const base = { channel: "sms" as const, isNewSession: false, safetyDetected: false, urgentDetected: false, safeContactAsked: true };
    expect(planReplies({ ...base, pausedForEmergency: true, isStop: false })).toEqual(["person_alerted"]);
    expect(planReplies({ ...base, pausedForEmergency: false, isStop: true })).toEqual([]);
  });

  it("suggests possible duplicates, strongest first, never merges", () => {
    const out = suggestDuplicates({ normalizedName: "ana lopez", email: "ana@x.com", phone: null }, [
      { id: "b", normalizedName: "ana lopez", email: null, phone: null },
      { id: "a", normalizedName: "someone", email: "ANA@x.com", phone: null },
      { id: "c", normalizedName: "other", email: null, phone: null },
    ]);
    expect(out.map((o) => o.id)).toEqual(["a", "b"]);
    expect(out[0]!.matchedOn).toEqual(["email"]);
  });

  it("recording only after consent", () => {
    expect(canRecord("consented")).toBe(true);
    expect(canRecord("pending")).toBe(false);
    expect(canRecord("declined")).toBe(false);
  });
});
