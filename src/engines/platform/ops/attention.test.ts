import { describe, expect, it } from "vitest";
import { DEFAULT_WEEKLY_HOURS } from "@/db/tables/foundation";
import type { BusinessCalendar } from "@/core/businessHours";
import {
  buildAttentionQueue,
  DEFAULT_OPS_SETTINGS,
  flagAttention,
  notificationAttention,
  scheduledTaskAttention,
  sortAttention,
  taskAttention,
  type OpsSlaSettings,
} from "./attention";
import { planBacklogFlag } from "../worker";

const cal: BusinessCalendar = { timeZone: "America/Chicago", weekly: DEFAULT_WEEKLY_HOURS, holidays: [] };
const settings: OpsSlaSettings = { dueSoonBusinessHours: 8, overdueGraceBusinessHours: 8, ...DEFAULT_OPS_SETTINGS };
// Wednesday 2026-09-30 11:00 Chicago (16:00Z) — inside business hours.
const NOW = new Date("2026-09-30T16:00:00Z");
const h = (n: number) => new Date(NOW.getTime() + n * 3_600_000);

const task = (o: Partial<Parameters<typeof taskAttention>[0][number]> = {}) => ({
  id: "t1",
  kind: "intake.first_response_due",
  title: "Reply to new inquiry",
  matterId: null,
  dueAt: h(1),
  status: "open",
  usesBusinessHours: true,
  deadlineCritical: false,
  ownerType: "user",
  ...o,
});

const flag = (o: Partial<Parameters<typeof flagAttention>[0][number]> = {}) => ({
  id: "f1",
  type: "calendar.task_overdue",
  severity: "warning",
  title: "Overdue",
  summary: null,
  matterId: "m1",
  urgent: false,
  acknowledgedAt: null,
  resolvedAt: null,
  checkBackAt: null,
  createdAt: h(-1),
  ...o,
});

describe("task attention", () => {
  it("lists due-soon and overdue tasks, skipping not-due and closed ones", () => {
    const items = taskAttention(
      [task({ id: "soon" }), task({ id: "late", dueAt: h(-2) }), task({ id: "far", dueAt: h(24 * 6) }), task({ id: "done", status: "done", dueAt: h(-2) })],
      NOW,
      cal,
      settings
    );
    expect(items.map((i) => [i.id, i.reason])).toEqual([
      ["soon", "task_due_soon"],
      ["late", "task_overdue"],
    ]);
    expect(items[1]!.clock).toBe("business");
    expect(items[1]!.breached).toBe(true);
  });

  it("deadline-critical tasks use the real clock and are critical once overdue", () => {
    const [item] = taskAttention([task({ deadlineCritical: true, dueAt: h(-0.5) })], NOW, cal, settings);
    expect(item).toMatchObject({ severity: "critical", clock: "real", reason: "task_overdue_escalate" });
  });
});

describe("flag attention", () => {
  it("marks unacknowledged flags past their SLA", () => {
    const items = flagAttention(
      [
        flag({ id: "fresh", severity: "high", createdAt: h(-1) }),
        flag({ id: "stale", severity: "high", createdAt: h(-3) }),
        flag({ id: "acked", severity: "high", createdAt: h(-3), acknowledgedAt: h(-2) }),
      ],
      NOW,
      cal,
      settings
    );
    expect(items.find((i) => i.id === "fresh")).toMatchObject({ reason: "flag_open", breached: false, canAcknowledge: true });
    expect(items.find((i) => i.id === "stale")).toMatchObject({ reason: "flag_unacknowledged", breached: true });
    expect(items.find((i) => i.id === "acked")).toMatchObject({ reason: "flag_open", canAcknowledge: false });
  });

  it("critical flags count real minutes; others business minutes (overnight doesn't count)", () => {
    // Created 17:30 Chicago yesterday; now 11:00 → ~2 business hours but ~17.5 real hours.
    const created = new Date("2026-09-29T22:30:00Z");
    const [warn] = flagAttention([flag({ severity: "warning", createdAt: created })], NOW, cal, settings);
    expect(warn!.clock).toBe("business");
    expect(warn!.hours).toBeLessThan(4);
    expect(warn!.breached).toBe(false);
    const [crit] = flagAttention([flag({ severity: "critical", createdAt: created })], NOW, cal, settings);
    expect(crit!.clock).toBe("real");
    expect(crit!.breached).toBe(true);
  });

  it("surfaces resolved flags whose check-back date has arrived", () => {
    const items = flagAttention(
      [flag({ id: "cb", resolvedAt: h(-48), checkBackAt: h(-1), severity: "info" }), flag({ id: "later", resolvedAt: h(-48), checkBackAt: h(5) })],
      NOW,
      cal,
      settings
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: "cb", reason: "flag_check_back_due", severity: "warning" });
  });
});

describe("scheduled task attention", () => {
  const row = (o: Partial<Parameters<typeof scheduledTaskAttention>[0][number]> = {}) => ({
    id: "s1",
    taskType: "calendar-alerts.reminder",
    dueAt: h(-1),
    claimedAt: null,
    completedAt: null,
    cancelledAt: null,
    matterId: null,
    ...o,
  });
  it("flags retry loops and stuck claims, ignoring recent and finished rows", () => {
    const items = scheduledTaskAttention(
      [
        row({ id: "retry", dueAt: h(-0.5) }),
        row({ id: "dead", dueAt: h(-2) }),
        row({ id: "recent", dueAt: new Date(NOW.getTime() - 2 * 60_000) }),
        row({ id: "stuck", claimedAt: h(-1) }),
        row({ id: "done", completedAt: h(-0.5) }),
      ],
      NOW,
      settings
    );
    expect(items.map((i) => [i.id, i.reason, i.severity])).toEqual([
      ["retry", "worker_retrying", "warning"],
      ["dead", "worker_retrying", "high"],
      ["stuck", "worker_stuck", "high"],
    ]);
  });
});

describe("notifications", () => {
  it("lists failures individually and groups held rows", () => {
    const base = { channel: "email", templateKey: "notify.client.flag_update", matterId: null, lastError: null, createdAt: h(-2) };
    const items = notificationAttention(
      [
        { ...base, id: "n1", status: "failed", lastError: "550 mailbox unavailable" },
        { ...base, id: "n2", status: "held", lastError: "[PENDING VENDOR_DPA REVIEW …]" },
        { ...base, id: "n3", status: "held" },
      ],
      NOW
    );
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ reason: "delivery_failed", detail: "550 mailbox unavailable" });
    expect(items[1]).toMatchObject({ reason: "delivery_held", title: "2 notifications held (notify.client.flag_update)", severity: "info" });
  });
});

describe("queue", () => {
  it("sorts by severity, then breach, then wait", () => {
    const { items, summary } = buildAttentionQueue({
      tasks: [task({ id: "late", dueAt: h(-2) }), task({ id: "crit", deadlineCritical: true, dueAt: h(-1) })],
      flags: [flag({ id: "info", severity: "info" })],
      scheduled: [],
      notifications: [],
      now: NOW,
      calendar: cal,
      settings,
    });
    expect(items.map((i) => i.id)).toEqual(["crit", "late", "info"]);
    expect(summary).toMatchObject({ total: 3, bySeverity: { critical: 1, warning: 1, info: 1 }, bySource: { task: 2, flag: 1 } });
    expect(sortAttention([])).toEqual([]);
  });
});

describe("worker backlog flag plan", () => {
  it("raises once, resolves when clear", () => {
    expect(planBacklogFlag({ problemCount: 2, highCount: 1, openFlagId: null, adminIds: ["a"] })).toEqual({ action: "raise", severity: "high" });
    expect(planBacklogFlag({ problemCount: 2, highCount: 0, openFlagId: "f", adminIds: ["a"] })).toEqual({ action: "none" });
    expect(planBacklogFlag({ problemCount: 1, highCount: 0, openFlagId: null, adminIds: [] })).toEqual({ action: "none" });
    expect(planBacklogFlag({ problemCount: 0, highCount: 0, openFlagId: "f", adminIds: [] })).toEqual({ action: "resolve", flagId: "f" });
  });
});
