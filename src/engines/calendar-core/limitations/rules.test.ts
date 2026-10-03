import { describe, expect, it } from "vitest";
import {
  checkVerifierIndependence,
  dailyDedupeKey,
  daysRemaining,
  dedupePrefix,
  filingTaskDueAt,
  reminderLevel,
  reminderRecipients,
  remindersDue,
  suggestLimitationDate,
  unverifiedLevel,
  validateLimitationEntry,
  verificationOutcome,
} from "./rules";
import { DEFAULT_CALENDAR_CORE_SETTINGS } from "../settings";

const S = DEFAULT_CALENDAR_CORE_SETTINGS;
const LAWYER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LAWYER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const STAFF = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

describe("validateLimitationEntry", () => {
  it("accepts a well-formed entry", () => {
    expect(validateLimitationEntry({ claimDescription: "Negligence", limitationDate: "2028-03-01", accrualDate: "2026-03-01" }, "2026-10-03")).toEqual({ errors: [], warnings: [] });
  });
  it("rejects missing claim, impossible dates and accrual after the limitation date", () => {
    expect(validateLimitationEntry({ claimDescription: " ", limitationDate: "2027-02-30" }, "2026-10-03").errors).toHaveLength(2);
    expect(validateLimitationEntry({ claimDescription: "x", limitationDate: "2027-01-01", accrualDate: "2027-06-01" }, "2026-10-03").errors[0]).toMatch(/after the accrual/);
  });
  it("warns (but allows) a date already passed or very close", () => {
    expect(validateLimitationEntry({ claimDescription: "x", limitationDate: "2026-10-01" }, "2026-10-03").warnings[0]).toMatch(/passed 2 day/);
    expect(validateLimitationEntry({ claimDescription: "x", limitationDate: "2026-10-13" }, "2026-10-03").warnings[0]).toMatch(/Only 10 day/);
  });
});

describe("independent verification", () => {
  const record = { enteredByUserId: LAWYER_A, lastChangedByUserId: null, status: "unverified" };
  it("another lawyer may verify", () => {
    expect(checkVerifierIndependence(record, { userId: LAWYER_B, role: "attorney" }, [])).toEqual({ ok: true });
  });
  it("the entering lawyer never verifies their own date", () => {
    expect(checkVerifierIndependence(record, { userId: LAWYER_A, role: "attorney" }, []).ok).toBe(false);
  });
  it("the lawyer who last changed it cannot verify either", () => {
    expect(checkVerifierIndependence({ ...record, lastChangedByUserId: LAWYER_B }, { userId: LAWYER_B, role: "attorney" }, []).ok).toBe(false);
  });
  it("staff verify only when the firm lists them as trained", () => {
    expect(checkVerifierIndependence(record, { userId: STAFF, role: "intake_staff" }, []).ok).toBe(false);
    expect(checkVerifierIndependence(record, { userId: STAFF, role: "intake_staff" }, [STAFF]).ok).toBe(true);
    expect(checkVerifierIndependence(record, { userId: STAFF, role: "read_only" }, [STAFF]).ok).toBe(false);
  });
  it("nothing to verify once verified or closed; disputed can be re-verified", () => {
    expect(checkVerifierIndependence({ ...record, status: "verified" }, { userId: LAWYER_B, role: "attorney" }, []).ok).toBe(false);
    expect(checkVerifierIndependence({ ...record, status: "disputed" }, { userId: LAWYER_B, role: "attorney" }, []).ok).toBe(true);
  });
  it("match only on the exact same date", () => {
    expect(verificationOutcome("2028-03-01", "2028-03-01")).toBe("match");
    expect(verificationOutcome("2028-03-01", "2028-03-02")).toBe("mismatch");
  });
});

describe("escalating reminders", () => {
  const T = [180, 90, 60, 30, 14, 7];
  it("sends nothing before the first threshold", () => {
    expect(remindersDue(T, 200, new Set())).toEqual({ send: null, skip: [] });
  });
  it("sends each threshold once, in order", () => {
    expect(remindersDue(T, 180, new Set())).toEqual({ send: 180, skip: [] });
    expect(remindersDue(T, 150, new Set([180]))).toEqual({ send: null, skip: [] });
    expect(remindersDue(T, 90, new Set([180]))).toEqual({ send: 90, skip: [] });
  });
  it("a late entry sends only the most urgent crossed threshold and skips the rest", () => {
    expect(remindersDue(T, 20, new Set())).toEqual({ send: 30, skip: [60, 90, 180] });
    expect(remindersDue(T, 5, new Set([180, 90, 60, 30]))).toEqual({ send: 7, skip: [14] });
  });
  it("a passed date is left to the daily 'passed' flag", () => {
    expect(remindersDue(T, -1, new Set())).toEqual({ send: null, skip: [] });
  });
  it("gets louder as the date nears", () => {
    expect(reminderLevel(180, S).severity).toBe("info");
    expect(reminderLevel(60, S).severity).toBe("warning");
    expect(reminderLevel(30, S)).toMatchObject({ severity: "high", escalate: true, allAdmins: false });
    expect(reminderLevel(7, S)).toMatchObject({ severity: "critical", escalate: true, allAdmins: true, urgent: true });
  });
  it("unverified dates are high, critical when close or disputed", () => {
    expect(unverifiedLevel(200, "unverified", S).severity).toBe("high");
    expect(unverifiedLevel(20, "unverified", S).severity).toBe("critical");
    expect(unverifiedLevel(200, "disputed", S).severity).toBe("critical");
  });
  it("recipients: responsible lawyer + entering lawyer, escalation users, then admins", () => {
    const base = { responsibleUserId: LAWYER_A, enteredByUserId: LAWYER_B, escalationUserIds: [], adminUserIds: [STAFF] };
    expect(reminderRecipients({ ...base, level: { escalate: false, allAdmins: false } })).toEqual([LAWYER_A, LAWYER_B]);
    expect(reminderRecipients({ ...base, level: { escalate: true, allAdmins: false } })).toEqual([LAWYER_A, LAWYER_B, STAFF]);
    expect(reminderRecipients({ ...base, responsibleUserId: null, level: { escalate: false, allAdmins: false } })).toEqual([LAWYER_B]);
  });
});

describe("dates and keys", () => {
  it("counts whole days on the calendar", () => {
    expect(daysRemaining("2026-10-10", "2026-10-03")).toBe(7);
    expect(daysRemaining("2026-10-01", "2026-10-03")).toBe(-2);
  });
  it("filing task falls due at the firm-set local time on the date (DST-aware)", () => {
    expect(filingTaskDueAt("2026-11-02", "America/Chicago", "00:00").toISOString()).toBe("2026-11-02T06:00:00.000Z");
    expect(filingTaskDueAt("2026-07-01", "America/Chicago", "00:00").toISOString()).toBe("2026-07-01T05:00:00.000Z");
  });
  it("daily keys share a per-record prefix", () => {
    expect(dailyDedupeKey("t", "id", "2026-10-03").startsWith(dedupePrefix("t", "id"))).toBe(true);
  });
});

describe("suggestLimitationDate (gated suggestion only)", () => {
  it("adds the firm's period and says it is not a decision", () => {
    const s = suggestLimitationDate("2024-02-29", { key: "k", label: "Example", years: 2, months: 0, days: 0, citation: "firm table" });
    expect(s.suggestedDate).toBe("2026-02-28");
    expect(s.warnings.join(" ")).toMatch(/not legal advice/);
    expect(s.explanation.at(-1)).toMatch(/firm table/);
  });
});
