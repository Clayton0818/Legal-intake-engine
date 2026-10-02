import { describe, it, expect } from "vitest";
import { buildRegistry } from "@/worker/hooks";
import { INTAKE_TASK_TYPES } from "./common/scheduling";
import { worker } from "./worker";

describe("intake worker module", () => {
  it("registers every intake timer and tick hook under the intake namespace", () => {
    const registry = buildRegistry([{ slug: "intake", module: worker }]);
    for (const taskType of Object.values(INTAKE_TASK_TYPES)) expect(registry.handlers.has(taskType)).toBe(true);
    expect(registry.hooks.map((h) => h.name)).toEqual(expect.arrayContaining(["intake.expire_slot_holds", "intake.rota_gap_scan", "intake.follow_up_scan"]));
  });
});
