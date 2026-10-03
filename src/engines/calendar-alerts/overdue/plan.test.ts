import { describe, expect, it } from "vitest";
import { CAL, chicago } from "../testFixtures";
import { checkRedate, effectiveDeadlineCritical, overdueRecipients, overdueSummary, planOverdue, type OverdueState } from "./plan";

const S = { dueSoonBusinessHours: 8, overdueGraceBusinessHours: 4, deadlineDueSoonRealHours: 48, clientTaskDueSoonReminder: true };
const fresh: OverdueState = { openFlag: null, dueSoonSent: false, ladderExists: false, linkedEventLive: null };

function task(over: Partial<Parameters<typeof planOverdue>[0]> = {}) {
  return {
    dueAt: chicago(2, 16), // Fri 16:00
    status: "open",
    usesBusinessHours: true,
    deadlineCritical: false,
    relatedCalendarEventId: null,
    ownerType: "user",
    ...over,
  };
}

describe("planOverdue (c45)", () => {
  it("acceptance 1: L1 at the due time, L2 after a 4-business-hour grace on Monday", () => {
    expect(planOverdue(task(), fresh, chicago(2, 15), CAL, S).action.kind).toBe("due_soon");
    expect(planOverdue(task(), { ...fresh, dueSoonSent: true }, chicago(2, 15), CAL, S).action.kind).toBe("none");
    expect(planOverdue(task(), fresh, chicago(2, 16), CAL, S).action.kind).toBe("flag_l1");
    const flagged = { ...fresh, openFlag: { escalationLevel: 0, severity: "warning" } };
    // Fri 16–17 (1h) + Mon 09–12 (3h) = 4 business hours → escalate at Mon 12:00 (09:00–17:00 fixture calendar).
    expect(planOverdue(task(), flagged, chicago(5, 11, 59), CAL, S).action.kind).toBe("none");
    expect(planOverdue(task(), flagged, chicago(5, 12), CAL, S).action.kind).toBe("escalate");
    expect(planOverdue(task(), { ...fresh, openFlag: { escalationLevel: 1, severity: "high" } }, chicago(6, 12), CAL, S).action.kind).toBe("none");
  });

  it("acceptance 2: a deadline task due Saturday is flagged critical at once on the real clock", () => {
    const t = task({ dueAt: chicago(3, 10), usesBusinessHours: false, deadlineCritical: true, relatedCalendarEventId: "ev" });
    const live = { ...fresh, linkedEventLive: true };
    expect(planOverdue(t, live, chicago(1, 11), CAL, S).action.kind).toBe("due_soon"); // 47h before, real clock
    const r = planOverdue(t, live, chicago(3, 10), CAL, S);
    expect(r.action.kind).toBe("flag_l3");
    expect(r.timing.clock).toBe("real");
    // An existing lower flag is escalated to critical; a critical one is left alone.
    expect(planOverdue(t, { ...live, openFlag: { escalationLevel: 0, severity: "warning" } }, chicago(3, 11), CAL, S).action.kind).toBe("escalate");
    expect(planOverdue(t, { ...live, openFlag: { escalationLevel: 0, severity: "critical" } }, chicago(3, 11), CAL, S).action.kind).toBe("none");
  });

  it("rule 15: a cancelled/unconfirmed link drops the task to standard severity", () => {
    const t = task({ deadlineCritical: true, relatedCalendarEventId: "ev", usesBusinessHours: false });
    expect(effectiveDeadlineCritical(t, false)).toBe(false);
    expect(effectiveDeadlineCritical(t, true)).toBe(true);
    expect(effectiveDeadlineCritical({ deadlineCritical: true, relatedCalendarEventId: null }, null)).toBe(true);
    expect(planOverdue(t, { ...fresh, linkedEventLive: false }, chicago(2, 16), CAL, S).action.kind).toBe("flag_l1");
  });

  it("c46: a client's lapsed task starts the chase ladder once; due-soon reminder is optional", () => {
    const t = task({ ownerType: "client" });
    expect(planOverdue(t, fresh, chicago(2, 16), CAL, S).action.kind).toBe("client_lapsed");
    expect(planOverdue(t, { ...fresh, ladderExists: true }, chicago(5, 9), CAL, S).action.kind).toBe("none");
    expect(planOverdue(t, fresh, chicago(2, 15), CAL, S).action.kind).toBe("client_due_soon");
    expect(planOverdue(t, fresh, chicago(2, 15), CAL, { ...S, clientTaskDueSoonReminder: false }).action.kind).toBe("none");
  });

  it("closed tasks are never flagged", () => {
    expect(planOverdue(task({ status: "done" }), fresh, chicago(9, 9), CAL, S).action.kind).toBe("none");
  });
});

describe("overdueRecipients", () => {
  const base = { ownerType: "user", ownerUserId: "O", ownerActive: true, supervisorId: "S", adminIds: ["A"], managingIds: ["M"] };
  it("L1 owner, L2 supervisor + admin, L3 everyone", () => {
    expect(overdueRecipients({ ...base, level: 1 }).userIds).toEqual(["O"]);
    expect(overdueRecipients({ ...base, level: 2 }).userIds).toEqual(["S", "A"]);
    expect(overdueRecipients({ ...base, level: 3 }).userIds).toEqual(["O", "S", "A"]);
  });
  it("pooled or disabled owners go to the admin, then the managing attorney", () => {
    expect(overdueRecipients({ ...base, ownerType: "firm", ownerUserId: null, level: 1 })).toMatchObject({ userIds: ["A"], pooled: true });
    expect(overdueRecipients({ ...base, ownerActive: false, level: 2 }).userIds).toEqual(["M", "A"]);
  });
  it("no supervisor → admin only, noted; never empty while an admin exists", () => {
    expect(overdueRecipients({ ...base, supervisorId: null, level: 2 })).toMatchObject({ userIds: ["A"], noSupervisor: true });
    expect(overdueRecipients({ ...base, supervisorId: "O", level: 2 }).userIds).toEqual(["A"]); // the owner is not their own supervisor
    expect(overdueRecipients({ ...base, ownerUserId: null, ownerType: "firm", adminIds: [], managingIds: [], level: 1 }).userIds).toEqual([]);
  });
});

describe("checkRedate (c45 rule 10)", () => {
  const t = { deadlineCritical: true, relatedCalendarEventId: "ev", status: "open" };
  const hearing = { startsAt: chicago(9, 9), status: "confirmed", cancelledAt: null };
  it("refuses moving a deadline task past its confirmed court date", () => {
    expect(checkRedate(t, chicago(9, 10), hearing)).toMatch(/cannot be due after it/);
    expect(checkRedate(t, chicago(8, 17), hearing)).toBeNull();
    expect(checkRedate({ ...t, deadlineCritical: false }, chicago(12, 9), hearing)).toBeNull();
    expect(checkRedate({ ...t, status: "done" }, chicago(8, 9), hearing)).toMatch(/open task/);
  });
});

describe("overdueSummary", () => {
  it("is factual", () => {
    const text = overdueSummary({ title: "File answer", timing: { state: "overdue", severity: "warning", overdueHours: 3.04, hoursUntilDue: -3.04, clock: "business" }, critical: true, pooled: false, noSupervisor: true });
    expect(text).toBe('"File answer" is 3 business hours past its due time. It is tied to a court date, filing deadline or limitation date. No supervising or responsible lawyer is set.');
  });
});
