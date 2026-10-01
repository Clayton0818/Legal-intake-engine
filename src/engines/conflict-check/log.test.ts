import { describe, expect, it } from "vitest";
import { normalizeName } from "@/core";
import type { ConflictCapability } from "./access";
import { canSeeRecord, CSV_COLUMNS, involvesInterests, matchesFilter, redactRecord, summarize, toCsv, waitingTimes, type LogRecord } from "./log";
import { CAL, hit } from "./testFixtures";

function record(over: Partial<LogRecord> = {}): LogRecord {
  return {
    checkId: "c1",
    trigger: "intake",
    triggeredByUserId: null,
    createdAt: "2026-10-05T15:00:00.000Z",
    matterId: null,
    intakeSessionId: "s1",
    searched: [{ name: "Pat Prospect", role: "prospective_client" }],
    hits: [hit()],
    outcome: "possible",
    outcomeReasons: ["hits"],
    status: "decided",
    assignedUserId: "atty",
    dueAt: null,
    decisions: [
      {
        id: "d1",
        decision: "proceed_with_consent",
        reasonCode: "consent_permitted",
        reasonText: "Both clients informed",
        ruleTableRefs: [],
        overrideFlag: false,
        decidedByUserId: "atty",
        decidedAt: "2026-10-05T18:00:00.000Z",
        supersedesDecisionId: null,
      },
    ],
    waivers: [{ id: "w1", clientName: "Jane Doe", status: "signed", sentAt: null, signedAt: "2026-10-06T10:00:00.000Z", countersignedAt: null }],
    screens: [{ id: "sc1", screenedUserId: "u2", status: "active", activatedAt: null, noticeSentAt: "2026-10-06T11:00:00.000Z" }],
    letters: [],
    gateHistory: [],
    ...over,
  };
}

const caps = (...c: ConflictCapability[]) => new Set<ConflictCapability>(c);

describe("canSeeRecord (c63 rules 1, 3, 4)", () => {
  it("needs log access", () => {
    expect(canSeeRecord(record(), caps(), new Set())).toBe(false);
    expect(canSeeRecord(record(), caps("log.view"), new Set())).toBe(true);
  });
  it("hides lawyer-interest records from anyone without the conflicts role", () => {
    const r = record({ trigger: "interest" });
    expect(involvesInterests(r)).toBe(true);
    expect(canSeeRecord(r, caps("log.view"), new Set())).toBe(false);
    expect(canSeeRecord(r, caps("log.view", "log.view_interests"), new Set())).toBe(true);
  });
  it("a screen wins over any role", () => {
    expect(canSeeRecord(record(), caps("log.view", "log.view_interests"), new Set(["s1"]))).toBe(false);
  });
});

describe("waitingTimes (business hours, matching the c59 timer)", () => {
  it("counts firm business hours and real hours", () => {
    // Friday 16:00 → Monday 10:00 Chicago: 1 + 1 = 2 business hours, 66 real hours.
    const w = waitingTimes(new Date("2026-10-09T21:00:00Z"), new Date("2026-10-12T15:00:00Z"), CAL);
    expect(w).toEqual({ businessHours: 2, realHours: 66 });
  });
});

describe("redaction and CSV (c63 §4.3)", () => {
  it("summary redaction removes names and free text but keeps the process", () => {
    const r = redactRecord(record(), "summary");
    const text = JSON.stringify(r);
    expect(text).not.toContain("Pat Prospect");
    expect(text).not.toContain("Jane Doe");
    expect(text).not.toContain("Both clients informed");
    expect(r.decisions[0]!.decision).toBe("proceed_with_consent");
    expect(r.waivers[0]!.signedAt).toBe("2026-10-06T10:00:00.000Z");
    expect(redactRecord(record(), "full")).toEqual(record());
  });

  it("writes one row per check with a header, quoting and formula-injection guard", () => {
    const csv = toCsv([record({ searched: [{ name: "=HYPERLINK(\"x\")", role: "opposing_party" }] })], "full");
    const [header, row] = csv.trim().split("\n");
    expect(header).toBe(CSV_COLUMNS.join(","));
    expect(row).toContain("'=HYPERLINK");
    expect(row).toContain("Jane Doe: signed");
  });

  it("summary CSV has counts, not names", () => {
    const csv = toCsv([record()], "summary");
    expect(csv).not.toContain("Pat Prospect");
    expect(csv).not.toContain("Jane Doe");
  });
});

describe("summarize and filter", () => {
  it("counts outcomes, decisions, open checks, waivers and screens", () => {
    const s = summarize([record(), record({ checkId: "c2", status: "open", decisions: [], waivers: [], screens: [] })]);
    expect(s).toEqual({
      total: 2,
      byOutcome: { possible: 2 },
      byDecision: { proceed_with_consent: 1 },
      open: 1,
      overrides: 0,
      waiversSigned: 1,
      screensActive: 1,
    });
  });

  it("filters by date, outcome, status, trigger and name", () => {
    const r = record();
    expect(matchesFilter(r, { from: "2026-10-01", to: "2026-10-31", outcome: "possible", status: "decided", trigger: "intake" }, normalizeName)).toBe(true);
    expect(matchesFilter(r, { outcome: "definite" }, normalizeName)).toBe(false);
    expect(matchesFilter(r, { q: "jane" }, normalizeName)).toBe(true);
    expect(matchesFilter(r, { q: "nobody" }, normalizeName)).toBe(false);
  });
});
