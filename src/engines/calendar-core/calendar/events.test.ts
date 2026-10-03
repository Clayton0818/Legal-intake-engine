import { describe, expect, it } from "vitest";
import {
  agendaByDay,
  canCancelAs,
  canConfirmAs,
  deadlineTaskOwner,
  initialStatus,
  inView,
  planReschedule,
  validateEventDraft,
  type CalendarEventRow,
  type EventDraft,
} from "./events";
import { afterPush, planLinkOp, pulls, pushes, StubCalendarSyncProvider, toExternalPayload } from "./sync";

const MATTER = "11111111-1111-4111-8111-111111111111";
const U1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const lawyer = { userId: U1, role: "attorney" };
const admin = { userId: U1, role: "firm_admin" };
const staff = { userId: U1, role: "intake_staff" };

function draft(over: Partial<EventDraft> = {}): EventDraft {
  return { matterId: MATTER, eventType: "hearing", title: "Temporary orders hearing", startsAt: new Date("2026-10-14T15:00:00Z"), source: "lawyer_entry", ...over };
}

function row(over: Partial<CalendarEventRow> = {}): CalendarEventRow {
  return {
    id: "e1",
    tenantId: "t",
    matterId: MATTER,
    eventType: "hearing",
    title: "Hearing",
    description: null,
    startsAt: new Date("2026-10-14T15:00:00Z"),
    endsAt: null,
    allDay: false,
    location: null,
    courtName: null,
    causeNumber: null,
    isDeadline: false,
    source: "lawyer_entry",
    sourceRef: null,
    status: "proposed",
    confirmedByUserId: null,
    confirmedAt: null,
    createdByUserId: null,
    assignedUserIds: [],
    externalRefs: {},
    cancelledAt: null,
    cancelReason: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

describe("validateEventDraft", () => {
  it("accepts a normal hearing", () => expect(validateEventDraft(draft())).toEqual([]));
  it("needs a title, a matter for deadlines/court dates, and an end after the start", () => {
    expect(validateEventDraft(draft({ title: "" }))).toContain("A title is required.");
    expect(validateEventDraft(draft({ matterId: null }))).toContain("A court date must belong to a matter.");
    expect(validateEventDraft(draft({ eventType: "filing_deadline", matterId: null }))).toContain("A deadline must belong to a matter.");
    expect(validateEventDraft(draft({ endsAt: new Date("2026-10-14T14:00:00Z") }))).toContain("The event must end after it starts.");
  });
  it("limitation dates only come from the lawyer's limitation tracker", () => {
    expect(validateEventDraft(draft({ eventType: "limitation_date", source: "staff_entry" })).join()).toMatch(/limitation tracker/);
  });
});

describe("confirmation (the AI never decides a date)", () => {
  it("AI suggestions, court notices and calculator results always start proposed", () => {
    for (const source of ["ai_suggestion", "court_notice", "deadline_calculator", "external_sync"] as const) {
      expect(initialStatus({ source, eventType: "hearing" }, lawyer, true)).toBe("proposed");
    }
  });
  it("a lawyer's own entry may be confirmed at once; staff entries wait for a lawyer", () => {
    expect(initialStatus({ source: "lawyer_entry", eventType: "hearing" }, lawyer, true)).toBe("confirmed");
    expect(initialStatus({ source: "staff_entry", eventType: "hearing" }, staff, true)).toBe("proposed");
  });
  it("only an attorney confirms deadlines and court dates; an admin may confirm a meeting", () => {
    expect(canConfirmAs(admin, { status: "proposed", eventType: "hearing", isDeadline: false }).ok).toBe(false);
    expect(canConfirmAs(admin, { status: "proposed", eventType: "client_meeting", isDeadline: false }).ok).toBe(true);
    expect(canConfirmAs(lawyer, { status: "proposed", eventType: "filing_deadline", isDeadline: true }).ok).toBe(true);
    expect(canConfirmAs(staff, { status: "proposed", eventType: "client_meeting", isDeadline: false }).ok).toBe(false);
    expect(canConfirmAs(lawyer, { status: "confirmed", eventType: "hearing", isDeadline: false }).ok).toBe(false);
  });
});

describe("changing a confirmed date", () => {
  const confirmed = { status: "confirmed", eventType: "filing_deadline", isDeadline: true };
  it("a lawyer re-confirms in their own name, with a reason", () => {
    expect(planReschedule(confirmed, lawyer)).toEqual({ status: "confirmed", confirmedByUserId: U1, reasonRequired: true });
  });
  it("anyone else sends it back to proposed for a lawyer", () => {
    expect(planReschedule(confirmed, staff)).toEqual({ status: "proposed", confirmedByUserId: null, reasonRequired: true });
    expect(planReschedule(confirmed, admin).status).toBe("proposed");
  });
  it("only a lawyer cancels a confirmed deadline", () => {
    expect(canCancelAs(staff, confirmed).ok).toBe(false);
    expect(canCancelAs(lawyer, confirmed).ok).toBe(true);
    expect(canCancelAs(staff, { ...confirmed, status: "proposed" }).ok).toBe(true);
  });
});

describe("views and agenda", () => {
  it("filters firm / lawyer / matter views", () => {
    const e = row({ assignedUserIds: [U1] });
    expect(inView(e, { kind: "firm" })).toBe(true);
    expect(inView(e, { kind: "lawyer", userId: U1 })).toBe(true);
    expect(inView(e, { kind: "lawyer", userId: "x" })).toBe(false);
    expect(inView(e, { kind: "matter", matterId: MATTER })).toBe(true);
  });
  it("groups by local day in the firm zone; deadlines first on ties; proposed marked", () => {
    const days = agendaByDay(
      [
        row({ id: "b", title: "B", startsAt: new Date("2026-10-15T04:30:00Z") }), // Oct 14 23:30 Chicago
        row({ id: "a", title: "A", startsAt: new Date("2026-10-14T15:00:00Z") }),
        row({ id: "d", title: "D", startsAt: new Date("2026-10-14T15:00:00Z"), isDeadline: true, status: "confirmed" }),
      ],
      "America/Chicago"
    );
    expect(days).toHaveLength(1);
    expect(days[0]!.date).toBe("2026-10-14");
    expect(days[0]!.items.map((i) => i.id)).toEqual(["d", "a", "b"]);
    expect(days[0]!.items[1]!.needsConfirmation).toBe(true);
  });
  it("deadline task goes to the first assigned person, else the matter's lawyer, else the firm", () => {
    expect(deadlineTaskOwner({ assignedUserIds: [U1] }, "m")).toEqual({ type: "user", userId: U1 });
    expect(deadlineTaskOwner({ assignedUserIds: [] }, "m")).toEqual({ type: "user", userId: "m" });
    expect(deadlineTaskOwner({ assignedUserIds: [] }, null)).toEqual({ type: "firm" });
  });
});

describe("external sync (vendor-gated adapter)", () => {
  it("pushes minimal content and marks proposed dates", () => {
    const p = toExternalPayload(row({ description: "privileged notes", location: "Courtroom 3" }));
    expect(p.title).toMatch(/^\[Proposed/);
    expect(JSON.stringify(p)).not.toMatch(/privileged/);
  });
  it("plans create / update / delete", () => {
    expect(planLinkOp("confirmed", null)).toBe("create");
    expect(planLinkOp("confirmed", { externalId: "x" })).toBe("update");
    expect(planLinkOp("cancelled", { externalId: "x" })).toBe("delete");
    expect(planLinkOp("cancelled", { externalId: null })).toBe("none");
  });
  it("directions and retry", () => {
    expect(pushes("pull_only")).toBe(false);
    expect(pulls("push_only")).toBe(false);
    expect(afterPush({ outcome: "failed", detail: "x" }, 2, 5).status).toBe("pending");
    expect(afterPush({ outcome: "failed", detail: "x" }, 5, 5).status).toBe("failed");
    expect(afterPush({ outcome: "held", detail: "x" }, 1, 5).status).toBe("held");
    expect(afterPush({ outcome: "ok", externalId: "e", etag: null }, 1, 5).status).toBe("synced");
  });
  it("the stub records and never sends", async () => {
    const stub = new StubCalendarSyncProvider();
    const r = await stub.push({ id: "c", userId: U1, provider: "google", tokenRef: null, externalCalendarId: null }, "create", toExternalPayload(row()), null);
    expect(r.outcome).toBe("held");
    expect(stub.pushes).toHaveLength(1);
  });
});
