// Shared test fixtures (pure; no database).
import { fromLocal, type BusinessCalendar } from "@/core/businessHours";

const nineToFive = [{ start: "09:00", end: "17:00" }];

/** Mon–Fri 09:00–17:00 America/Chicago, one holiday (2026-11-26). */
export const CAL: BusinessCalendar = {
  timeZone: "America/Chicago",
  weekly: { mon: nineToFive, tue: nineToFive, wed: nineToFive, thu: nineToFive, fri: nineToFive },
  holidays: [{ date: "2026-11-26", name: "Thanksgiving" }],
};

/** A Chicago local time as an instant. 2026-10-05 is a Monday. */
export const chi = (y: number, mo: number, d: number, h = 0, mi = 0) => fromLocal(y, mo, d, h, mi, "America/Chicago");

import { getGate, setApprovals, type ApprovalRecord } from "@/compliance/approvals";

/** Approve gates for a test: one record per required reviewer kind. */
export function approveGates(...keys: string[]): void {
  const records: ApprovalRecord[] = keys.flatMap((key) =>
    getGate(key).reviewers.map((reviewerKind) => ({ gateKey: key, reviewerKind, approvedByName: "Test reviewer", approvedAt: new Date("2026-01-01"), draftHash: getGate(key).draftHash }))
  );
  setApprovals(records);
}
