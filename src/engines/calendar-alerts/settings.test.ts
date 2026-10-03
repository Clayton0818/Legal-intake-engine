import { describe, expect, it } from "vitest";
import { clientEmailDecision, jobIsDue } from "./common";
import {
  DEFAULT_ALERT_SETTINGS,
  DEFAULT_HEALTH,
  readAlertSettings,
  stallDurationFor,
  validateAlertSettingsPatch,
  validateLadder,
} from "./settings";
import { ALERT_COPY_GATES, ALERT_GATE_KEYS, ALERT_RULE_GATES } from "./gates";
import { isPlaceholder, legalCopy } from "@/compliance/approvals";

const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";

describe("readAlertSettings", () => {
  it("fills defaults and merges nested health settings without dropping keys", () => {
    const s = readAlertSettings({
      engineSettings: { "calendar-alerts": { clientEmailDailyCap: 5, health: { greenAt: 80, weights: { firm: { stalls: 40 } } } } },
    });
    expect(s.clientEmailDailyCap).toBe(5);
    expect(s.ladder).toEqual(DEFAULT_ALERT_SETTINGS.ladder);
    expect(s.health.greenAt).toBe(80);
    expect(s.health.amberAt).toBe(DEFAULT_HEALTH.amberAt);
    expect(s.health.weights.firm.stalls).toBe(40);
    expect(s.health.weights.firm.replyTimes).toBe(DEFAULT_HEALTH.weights.firm.replyTimes);
    expect(s.health.weights.client).toEqual(DEFAULT_HEALTH.weights.client);
  });
});

describe("validateAlertSettingsPatch", () => {
  it("accepts a valid patch", () => {
    expect(
      validateAlertSettingsPatch({
        clientEmailDailyCap: 2,
        managingAttorneyUserIds: [U1],
        backupLawyerByUser: { [U1]: U2 },
        trustedCourtSenders: [{ domain: "efiletexas.gov", label: "eFileTexas", kind: "efiling" }],
        stallDurations: { "intake_session:*": 16 },
        digestTimeLocal: "07:30",
      })
    ).toEqual([]);
  });

  it("rejects unknown keys, bad people maps, bad domains and bad stall keys", () => {
    const errors = validateAlertSettingsPatch({
      // @ts-expect-error unknown key on purpose
      bogus: 1,
      backupLawyerByUser: { [U1]: U1 },
      trustedCourtSenders: [{ domain: "not a domain", label: "", kind: "court" }],
      stallDurations: { "invoice:draft": 8 },
      digestTimeLocal: "25:00",
    });
    expect(errors.join(" ")).toMatch(/Unknown setting 'bogus'/);
    expect(errors.join(" ")).toMatch(/backupLawyerByUser/);
    expect(errors.join(" ")).toMatch(/not a valid sender domain/);
    expect(errors.join(" ")).toMatch(/stallDurations key/);
    expect(errors.join(" ")).toMatch(/digestTimeLocal/);
  });

  it("the ladder always ends with the lawyer deciding, with at most 3 reminders", () => {
    expect(validateLadder([{ action: "reminder", afterBusinessHours: 0 }])).toContain(
      "The last ladder step must be 'lawyer_decides' — the lawyer always decides the next step."
    );
    expect(
      validateLadder([
        { action: "reminder", afterBusinessHours: 0 },
        { action: "reminder", afterBusinessHours: 8 },
        { action: "reminder", afterBusinessHours: 8 },
        { action: "reminder", afterBusinessHours: 8 },
        { action: "lawyer_decides", afterBusinessHours: 8 },
      ]).join(" ")
    ).toMatch(/At most 3/);
    expect(validateLadder([])).toEqual(["ladder must be a non-empty list of steps."]);
  });

  it("health bands must be ordered", () => {
    expect(validateAlertSettingsPatch({ health: { ...DEFAULT_HEALTH, greenAt: 30, amberAt: 40 } }).join(" ")).toMatch(/Health bands/);
  });
});

describe("stallDurationFor", () => {
  it("prefers the exact stage, then the wildcard, else never flagged", () => {
    expect(stallDurationFor(DEFAULT_ALERT_SETTINGS, "intake_session", "existing_caller_handoff")).toBe(8);
    expect(stallDurationFor(DEFAULT_ALERT_SETTINGS, "intake_session", "collect_facts")).toBe(16);
    expect(stallDurationFor(DEFAULT_ALERT_SETTINGS, "matter", "retained")).toBeNull();
  });
});

describe("c51 client email decision", () => {
  it("blocks client email from an unverified domain, caps non-urgent ones, never caps urgent ones", () => {
    expect(clientEmailDecision({ senderDomainVerified: false, urgent: true, sentToday: 0, dailyCap: 3 }).email).toBe(false);
    expect(clientEmailDecision({ senderDomainVerified: true, urgent: false, sentToday: 3, dailyCap: 3 }).email).toBe(false);
    expect(clientEmailDecision({ senderDomainVerified: true, urgent: true, sentToday: 9, dailyCap: 3 }).email).toBe(true);
    expect(clientEmailDecision({ senderDomainVerified: true, urgent: false, sentToday: 2, dailyCap: 3 })).toEqual({ email: true, reason: null });
  });

  it("periodic jobs run when never run or when the interval has passed", () => {
    const now = new Date("2026-10-05T15:00:00Z");
    expect(jobIsDue(null, now, 3_600_000)).toBe(true);
    expect(jobIsDue(new Date("2026-10-05T14:30:00Z"), now, 3_600_000)).toBe(false);
    expect(jobIsDue(new Date("2026-10-05T14:00:00Z"), now, 3_600_000)).toBe(true);
  });
});

describe("gates", () => {
  it("are namespaced to this engine and render as visible placeholders until approved", () => {
    for (const key of ALERT_GATE_KEYS) expect(key).toMatch(/^(copy|rules)\.calendar-alerts\./);
    expect(isPlaceholder(legalCopy(ALERT_COPY_GATES.deadlineReplyAck.key, { replyBy: "Monday" }))).toBe(true);
    expect(ALERT_RULE_GATES.courtNoticeSuggestions.reviewers).toEqual(["attorney"]);
  });
});
