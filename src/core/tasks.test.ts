import { describe, it, expect } from "vitest";
import { computeTaskTiming, resolveDue, validateNewTask, type NewTaskInput } from "./tasks";
import { fromLocal, type BusinessCalendar } from "./businessHours";

const nineToFive = [{ start: "09:00", end: "17:00" }];
const cal: BusinessCalendar = {
  timeZone: "America/Chicago",
  weekly: { mon: nineToFive, tue: nineToFive, wed: nineToFive, thu: nineToFive, fri: nineToFive },
  holidays: [],
};
const chi = (y: number, mo: number, d: number, h = 0, mi = 0) => fromLocal(y, mo, d, h, mi, "America/Chicago");
const settings = { dueSoonBusinessHours: 8, overdueGraceBusinessHours: 8 };

const base: NewTaskInput = {
  tenantId: "00000000-0000-0000-0000-000000000001",
  kind: "calendar-alerts.firm_reply_due",
  title: "Reply to the client's message",
  owner: { type: "user", userId: "u-1" },
  due: { hours: 24, clock: "business" },
};

describe("validateNewTask", () => {
  it("accepts a well-formed task", () => {
    expect(validateNewTask(base)).toEqual([]);
  });

  it("requires a namespaced kind and a title", () => {
    expect(validateNewTask({ ...base, kind: "reply" })[0]).toMatch(/namespaced/);
    expect(validateNewTask({ ...base, title: "  " })).toContain("title is required.");
  });

  it("only a client's own task can be client-visible (c45/c46 boundary)", () => {
    expect(validateNewTask({ ...base, visibility: "client" }).join(" ")).toMatch(/client-visible/);
    expect(validateNewTask({ ...base, owner: { type: "client", partyId: "p-1" }, visibility: "client" })).toEqual([]);
  });

  it("deadline-critical tasks cannot run on business hours", () => {
    expect(validateNewTask({ ...base, deadlineCritical: true }).join(" ")).toMatch(/real clock/);
    expect(validateNewTask({ ...base, deadlineCritical: true, due: { hours: 24, clock: "real" } })).toEqual([]);
  });

  it("rejects negative relative due times", () => {
    expect(validateNewTask({ ...base, due: { hours: -1, clock: "business" } }).join(" ")).toMatch(/zero or more/);
  });
});

describe("resolveDue", () => {
  const friEvening = chi(2026, 9, 25, 18);

  it("counts firm business hours by default (founder decision)", () => {
    const r = resolveDue({ hours: 24, clock: "business" }, cal, friEvening);
    expect(r).toEqual({ dueAt: chi(2026, 9, 30, 17), usesBusinessHours: true });
  });

  it("uses the real clock when asked", () => {
    const r = resolveDue({ hours: 24, clock: "real" }, cal, friEvening);
    expect(r).toEqual({ dueAt: chi(2026, 9, 26, 18), usesBusinessHours: false });
  });

  it("forces the real clock for deadline-critical tasks", () => {
    const r = resolveDue({ hours: 24, clock: "business" }, cal, friEvening, true);
    expect(r.usesBusinessHours).toBe(false);
    expect(r.dueAt).toEqual(chi(2026, 9, 26, 18));
  });

  it("keeps an exact instant as given", () => {
    const at = chi(2026, 10, 2, 10);
    expect(resolveDue({ at }, cal, friEvening)).toEqual({ dueAt: at, usesBusinessHours: true });
    expect(resolveDue({ at, clock: "real" }, cal, friEvening).usesBusinessHours).toBe(false);
  });

  it("measures from an explicit start", () => {
    const r = resolveDue({ hours: 2, clock: "business", from: chi(2026, 9, 21, 16) }, cal, friEvening);
    expect(r.dueAt).toEqual(chi(2026, 9, 22, 10));
  });
});

describe("computeTaskTiming (c45)", () => {
  const due = chi(2026, 9, 23, 12); // Wed noon
  const task = { dueAt: due, status: "open", usesBusinessHours: true, deadlineCritical: false };

  it("is not due well before the due time", () => {
    const t = computeTaskTiming(task, chi(2026, 9, 21, 12), cal, settings); // Mon noon: 16 business hours away
    expect(t.state).toBe("not_due");
    expect(t.severity).toBeNull();
    expect(t.hoursUntilDue).toBe(16);
  });

  it("warns 'due soon' within one business day", () => {
    const t = computeTaskTiming(task, chi(2026, 9, 22, 12), cal, settings);
    expect(t.state).toBe("due_soon");
    expect(t.severity).toBe("info");
  });

  it("flags overdue to the assignee, then escalates after the grace period (business hours)", () => {
    const overdue = computeTaskTiming(task, chi(2026, 9, 23, 16), cal, settings);
    expect(overdue).toMatchObject({ state: "overdue", severity: "warning", overdueHours: 4, clock: "business" });
    const escalate = computeTaskTiming(task, chi(2026, 9, 24, 12), cal, settings);
    expect(escalate).toMatchObject({ state: "overdue_escalate", severity: "high", overdueHours: 8 });
  });

  it("does not count the weekend toward the grace period", () => {
    const friTask = { ...task, dueAt: chi(2026, 9, 25, 16) }; // Fri 4pm
    const t = computeTaskTiming(friTask, chi(2026, 9, 27, 12), cal, settings); // Sunday
    expect(t).toMatchObject({ state: "overdue", overdueHours: 1 });
  });

  it("deadline-critical tasks are critical immediately on the real clock", () => {
    const critical = { ...task, usesBusinessHours: false, deadlineCritical: true };
    const t = computeTaskTiming(critical, chi(2026, 9, 23, 12, 1), cal, settings);
    expect(t.state).toBe("overdue_escalate");
    expect(t.severity).toBe("critical");
    expect(t.clock).toBe("real");
  });

  it("closed tasks are never flagged", () => {
    expect(computeTaskTiming({ ...task, status: "done" }, chi(2026, 10, 30, 12), cal, settings).state).toBe("closed");
    expect(computeTaskTiming({ ...task, status: "cancelled" }, chi(2026, 10, 30, 12), cal, settings).severity).toBeNull();
  });
});
