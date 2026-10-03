import { describe, expect, it } from "vitest";
import { buildRegistry } from "@/worker/hooks";
import { worker, HEALTH_RECOMPUTE_TASK } from "./worker";

describe("calendar-alerts worker module", () => {
  it("registers with the worker: every hook and handler is namespaced to the engine", () => {
    const reg = buildRegistry([{ slug: "calendar-alerts", module: worker }]);
    const names = reg.hooks.map((h) => h.name).filter((n) => n.startsWith("calendar-alerts."));
    expect(names).toEqual([
      "calendar-alerts.court_mail_poll",
      "calendar-alerts.court_notice_escalation",
      "calendar-alerts.reply_clocks",
      "calendar-alerts.overdue_scan",
      "calendar-alerts.client_ladders",
      "calendar-alerts.stall_sweep",
      "calendar-alerts.health",
      "calendar-alerts.delivery_watch",
      "calendar-alerts.digest",
    ]);
    expect(reg.handlers.get(HEALTH_RECOMPUTE_TASK)?.engine).toBe("calendar-alerts");
  });
});
