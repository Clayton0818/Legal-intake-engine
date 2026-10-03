import { describe, it, expect } from "vitest";
import { canConfirmEvent } from "./calendarEvents";
import { clientShareableDocuments, isDocumentStatus, isPrivilegeTag } from "./documents";
import { ENGINE_SLUGS, isEngineSlug, isModuleNotFound } from "./engines";

describe("calendar events: a lawyer confirms, never the AI", () => {
  const proposed = { status: "proposed" };
  it("allows attorneys and admins", () => {
    expect(canConfirmEvent({ type: "user", role: "attorney" }, proposed)).toEqual({ ok: true });
    expect(canConfirmEvent({ type: "user", role: "firm_admin" }, proposed)).toEqual({ ok: true });
  });
  it("refuses the AI, the system, clients and non-lawyer staff", () => {
    expect(canConfirmEvent({ type: "ai" }, proposed).ok).toBe(false);
    expect(canConfirmEvent({ type: "system" }, proposed).ok).toBe(false);
    expect(canConfirmEvent({ type: "client" }, proposed).ok).toBe(false);
    expect(canConfirmEvent({ type: "user", role: "intake_staff" }, proposed).ok).toBe(false);
    expect(canConfirmEvent({ type: "user", role: "attorney" }, { status: "confirmed" }).ok).toBe(false);
  });
});

describe("documents vocabulary", () => {
  it("knows statuses and privilege tags", () => {
    expect(isDocumentStatus("filed")).toBe(true);
    expect(isDocumentStatus("shredded")).toBe(false);
    expect(isPrivilegeTag("work_product")).toBe(true);
  });
  it("only shares client-visible, non-privileged documents", () => {
    const docs = [
      { id: 1, clientVisible: true, privilegeTag: "none" },
      { id: 2, clientVisible: false, privilegeTag: "none" },
      { id: 3, clientVisible: true, privilegeTag: "privileged" },
      { id: 4, clientVisible: true, privilegeTag: "sealed" },
      { id: 5, clientVisible: true, privilegeTag: "confidential" },
    ];
    expect(clientShareableDocuments(docs).map((d) => d.id)).toEqual([1, 5]);
  });
});

describe("engines", () => {
  it("lists the eight engine slugs (seven engines + platform)", () => {
    expect(ENGINE_SLUGS).toHaveLength(8);
    expect(isEngineSlug("platform")).toBe(true);
    expect(isEngineSlug("billing-trust")).toBe(true);
    expect(isEngineSlug("billing")).toBe(false);
  });
  it("tells 'module missing' apart from 'module crashed'", () => {
    const missing = Object.assign(new Error("Cannot find module '../engines/intake/worker.ts'"), { code: "ERR_MODULE_NOT_FOUND" });
    expect(isModuleNotFound(missing, "intake/worker")).toBe(true);
    expect(isModuleNotFound(new Error("boom"), "intake/worker")).toBe(false);
    expect(isModuleNotFound(missing, "document/worker")).toBe(false);
    expect(isModuleNotFound(new Error("Unknown variable dynamic import: ../engines/intake/gates.ts"), "intake/gates")).toBe(true);
  });
});
