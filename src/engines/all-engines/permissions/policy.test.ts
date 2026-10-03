import { describe, expect, it } from "vitest";
import { clientShareableDocuments, clientVisible } from "@/core";
import {
  FIRM_ROLES,
  RIGHTS,
  RIGHT_KEYS,
  STAFF_ROLES,
  assertCan,
  baseRolesFor,
  buildMatrix,
  can,
  combineRoles,
  decide,
  effectiveRights,
  filterAllowed,
  isRight,
  planOverrideChange,
  roleHolds,
  validateOverride,
  validateRoleGrant,
  validateRoleRevoke,
  PermissionDeniedError,
  type FirmRole,
  type PermissionOverride,
  type PolicyActor,
  type RightDef,
} from "./policy";

const U1 = "00000000-0000-4000-8000-000000000001";
const U2 = "00000000-0000-4000-8000-000000000002";
const P1 = "00000000-0000-4000-8000-0000000000a1";
const P2 = "00000000-0000-4000-8000-0000000000a2";

const staff = (roles: FirmRole[], userId: string | null = U1, status = "active"): PolicyActor => ({ kind: "staff", userId, roles, status });
const client = (partyId = P1): PolicyActor => ({ kind: "client", partyId });
const defs = RIGHTS as readonly RightDef[];

/** The role → rights table the card asks for, written out so a change to the defaults is a deliberate test edit. */
const EXPECTED_DEFAULTS: Record<FirmRole, string[]> = {
  owner: [
    "matters.view", "matters.access_all", "matters.edit", "intake.view", "intake.manage", "contacts.view", "contacts.edit",
    "contacts.safe_contact", "conflicts.run", "conflicts.log", "documents.view", "documents.upload", "documents.privileged",
    "templates.manage", "calendar.view", "calendar.edit", "flags.internal", "flags.acknowledge", "billing.view", "billing.edit",
    "invoices.approve", "trust.view", "trust.reconcile", "reports.operational", "reports.financial", "settings.manage",
    "practice_areas.manage", "permissions.manage", "users.manage", "audit.view", "data_import.run",
  ],
  admin: [
    "matters.view", "matters.access_all", "matters.edit", "intake.view", "intake.manage", "contacts.view", "contacts.edit",
    "conflicts.run", "documents.view", "documents.upload", "templates.manage", "calendar.view", "calendar.edit", "flags.internal",
    "flags.acknowledge", "billing.view", "reports.operational", "settings.manage", "practice_areas.manage", "permissions.manage",
    "users.manage", "audit.view", "data_import.run",
  ],
  lawyer: [
    "matters.view", "matters.access_all", "matters.edit", "matters.open", "matters.close", "intake.view", "intake.manage",
    "contacts.view", "contacts.edit", "contacts.safe_contact", "conflicts.run", "documents.view", "documents.upload",
    "documents.privileged", "documents.approve", "documents.share_with_client", "templates.manage", "calendar.view",
    "calendar.edit", "deadlines.confirm", "flags.internal", "flags.acknowledge", "time.record", "billing.view",
    "invoices.approve", "trust.view", "trust.approve_disbursement", "reports.operational",
  ],
  paralegal: [
    "matters.view", "matters.access_all", "matters.edit", "intake.view", "intake.manage", "contacts.view", "contacts.edit",
    "contacts.safe_contact", "conflicts.run", "documents.view", "documents.upload", "documents.privileged", "calendar.view",
    "calendar.edit", "flags.internal", "flags.acknowledge", "time.record",
  ],
  intake_staff: [
    "matters.view", "matters.access_all", "matters.edit", "intake.view", "intake.manage", "contacts.view", "contacts.edit",
    "contacts.safe_contact", "conflicts.run", "documents.view", "documents.upload", "calendar.view", "calendar.edit",
    "flags.internal", "flags.acknowledge",
  ],
  bookkeeper: [
    "matters.view", "matters.access_all", "contacts.view", "documents.view", "calendar.view", "flags.internal",
    "billing.view", "billing.edit", "trust.view", "trust.record", "trust.reconcile", "reports.financial",
  ],
  // Without the lawyer role a conflicts attorney holds no attorney-only rights (see the combined case below).
  conflicts_attorney: [
    "matters.view", "matters.access_all", "contacts.view", "conflicts.run", "conflicts.party_index", "conflicts.log",
    "documents.view", "documents.privileged", "calendar.view", "flags.internal", "time.record",
  ],
  read_only: ["matters.view", "matters.access_all", "intake.view", "contacts.view", "documents.view", "calendar.view", "flags.internal"],
  client: ["portal.view_matter", "portal.view_documents", "portal.upload_documents", "portal.view_tasks", "portal.message_firm", "portal.pay"],
};

describe("rights catalogue", () => {
  it("has unique keys, eligible ⊇ default, and well-formed keys", () => {
    expect(new Set(RIGHT_KEYS).size).toBe(RIGHT_KEYS.length);
    for (const d of defs) {
      expect(d.key).toMatch(/^[a-z_]+\.[a-z_]+$/);
      for (const r of d.defaultRoles) expect(d.eligibleRoles).toContain(r);
      expect(d.defaultRoles.length).toBeGreaterThan(0);
    }
  });

  it("portal rights belong to clients only and staff rights never to clients", () => {
    for (const d of defs) {
      if (d.clientRight) {
        expect(d.eligibleRoles).toEqual(["client"]);
        expect(d.locked).toBe(true);
      } else {
        expect(d.eligibleRoles).not.toContain("client");
      }
    }
  });

  it("every attorney-only right is a decision, and the four guardrail decisions are locked", () => {
    for (const d of defs) if (d.attorneyOnly) expect(d.decision).toBe(true);
    for (const k of ["conflicts.decide", "deadlines.confirm", "documents.approve", "trust.approve_disbursement"]) {
      const d = defs.find((x) => x.key === k)!;
      expect(d.locked && d.decision && d.attorneyOnly).toBe(true);
    }
  });

  it("isRight", () => {
    expect(isRight("matters.view")).toBe(true);
    expect(isRight("matters.destroy")).toBe(false);
    expect(isRight(3)).toBe(false);
  });
});

describe("role defaults (exhaustive role × right)", () => {
  for (const role of FIRM_ROLES) {
    it(`${role} holds exactly the expected rights`, () => {
      const actor: PolicyActor = role === "client" ? client() : staff([role]);
      const held = [...effectiveRights(actor)].sort();
      expect(held).toEqual([...EXPECTED_DEFAULTS[role]].sort());
      // can() on the firm resource agrees with effectiveRights for every right.
      for (const key of RIGHT_KEYS) expect(can(actor, key)).toBe(held.includes(key));
    });
  }

  it("lawyer + conflicts attorney can decide conflicts; a conflicts attorney alone cannot", () => {
    expect(can(staff(["lawyer", "conflicts_attorney"]), "conflicts.decide")).toBe(true);
    expect(decide(staff(["conflicts_attorney"]), "conflicts.decide")).toEqual({ allowed: false, right: "conflicts.decide", reason: "attorney_only" });
    expect(can(staff(["lawyer"]), "conflicts.decide")).toBe(false);
  });

  it("only the bookkeeper and owner see trust reconciliation; only the conflicts role sees the party index", () => {
    const recon = STAFF_ROLES.filter((r) => can(staff([r]), "trust.reconcile"));
    expect(recon.sort()).toEqual(["bookkeeper", "owner"]);
    const index = STAFF_ROLES.filter((r) => can(staff([r]), "conflicts.party_index"));
    expect(index).toEqual(["conflicts_attorney"]);
  });

  it("an owner who is not a lawyer cannot confirm deadlines, approve documents or disbursements", () => {
    const owner = staff(["owner"]);
    for (const k of ["deadlines.confirm", "documents.approve", "trust.approve_disbursement", "matters.open"]) {
      expect(can(owner, k)).toBe(false);
    }
    const ownerLawyer = staff(["owner", "lawyer"]);
    for (const k of ["deadlines.confirm", "documents.approve", "trust.approve_disbursement", "trust.reconcile"]) {
      expect(can(ownerLawyer, k)).toBe(true);
    }
  });

  it("roles are additive", () => {
    const both = effectiveRights(staff(["paralegal", "bookkeeper"]));
    expect(both.has("documents.privileged")).toBe(true);
    expect(both.has("trust.reconcile")).toBe(true);
  });
});

describe("actor invariants", () => {
  it("the AI holds nothing, ever", () => {
    const ai: PolicyActor = { kind: "ai", model: "x" };
    expect(effectiveRights(ai).size).toBe(0);
    for (const k of RIGHT_KEYS) expect(decide(ai, k)).toMatchObject({ allowed: false, reason: "ai_never_authorised" });
  });

  it("the system holds every non-decision staff right and no decision or portal right", () => {
    const sys: PolicyActor = { kind: "system" };
    for (const d of defs) {
      expect(can(sys, d.key)).toBe(!d.decision && !d.clientRight);
      if (d.decision) expect(decide(sys, d.key)).toMatchObject({ reason: "decision_needs_a_person" });
    }
  });

  it("inactive users hold nothing", () => {
    for (const status of ["disabled", "invited"]) {
      expect(effectiveRights(staff(["owner", "lawyer"], U1, status)).size).toBe(0);
      expect(decide(staff(["owner"], U1, status), "matters.view")).toMatchObject({ reason: "inactive_user" });
    }
  });

  it("a staff role mixed with the client role fails closed", () => {
    const mixed: PolicyActor = { kind: "staff", userId: U1, roles: ["lawyer", "client"] };
    expect(effectiveRights(mixed).size).toBe(0);
    expect(decide(mixed, "matters.view")).toMatchObject({ reason: "invalid_role_mix" });
  });

  it("staff never hold portal rights; clients never hold staff rights, whatever the overrides", () => {
    const evil: PermissionOverride[] = [
      { role: "client", right: "matters.view", effect: "grant" },
      { role: "lawyer", right: "portal.pay", effect: "grant" },
    ];
    expect(can(client(), "matters.view", { type: "firm" }, { overrides: evil })).toBe(false);
    expect(decide(staff(["lawyer"]), "portal.pay", { type: "firm" }, { overrides: evil })).toMatchObject({ reason: "client_portal_only" });
  });

  it("unknown rights and roles are denied", () => {
    expect(decide(staff(["owner"]), "matters.destroy")).toMatchObject({ reason: "unknown_right" });
    expect(effectiveRights({ kind: "staff", userId: U1, roles: ["superuser"] }).size).toBe(0);
  });

  it("assertCan throws a 403-style error", () => {
    expect(() => assertCan(staff(["paralegal"]), "trust.reconcile")).toThrow(PermissionDeniedError);
    try {
      assertCan(staff(["paralegal"]), "trust.reconcile");
    } catch (e) {
      expect((e as PermissionDeniedError).status).toBe(403);
      expect((e as PermissionDeniedError).decision.reason).toBe("role_lacks_right");
    }
    expect(() => assertCan(staff(["bookkeeper"]), "trust.reconcile")).not.toThrow();
  });
});

describe("firm overrides", () => {
  it("locked rights cannot be overridden either way", () => {
    for (const d of defs.filter((x) => x.locked)) {
      for (const role of FIRM_ROLES) {
        expect(validateOverride({ role, right: d.key, effect: "grant" }).length).toBeGreaterThan(0);
        expect(validateOverride({ role, right: d.key, effect: "deny" }).length).toBeGreaterThan(0);
      }
    }
  });

  it("grants are limited to eligible roles", () => {
    for (const d of defs.filter((x) => !x.locked)) {
      for (const role of STAFF_ROLES) {
        const ok = validateOverride({ role, right: d.key, effect: "grant" }).length === 0;
        expect(ok).toBe(d.eligibleRoles.includes(role));
      }
    }
  });

  it("the owner can never be denied permissions.manage (no lock-out)", () => {
    expect(validateOverride({ role: "owner", right: "permissions.manage", effect: "deny" })[0]).toMatch(/lock/);
    expect(validateOverride({ role: "admin", right: "permissions.manage", effect: "deny" })).toEqual([]);
    // Even a bad row in the database is ignored at evaluation time.
    const bad: PermissionOverride[] = [{ role: "owner", right: "permissions.manage", effect: "deny" }];
    expect(can(staff(["owner"]), "permissions.manage", { type: "firm" }, { overrides: bad })).toBe(true);
  });

  it("rejects malformed overrides", () => {
    expect(validateOverride({ role: "x", right: "matters.view", effect: "grant" })).toHaveLength(1);
    expect(validateOverride({ role: "owner", right: "x", effect: "grant" })).toHaveLength(1);
    expect(validateOverride({ role: "owner", right: "matters.view", effect: "maybe" })).toHaveLength(1);
    expect(validateOverride({ role: "client", right: "matters.view", effect: "grant" })[0]).toMatch(/Client/);
  });

  it("grant and deny change effective rights; invalid rows are ignored", () => {
    const overrides: PermissionOverride[] = [
      { role: "owner", right: "conflicts.party_index", effect: "grant" },
      { role: "paralegal", right: "documents.privileged", effect: "deny" },
      { role: "read_only", right: "trust.reconcile", effect: "grant" }, // locked: ignored
    ];
    const cfg = { overrides };
    expect(can(staff(["owner"]), "conflicts.party_index", { type: "firm" }, cfg)).toBe(true);
    expect(can(staff(["paralegal"]), "documents.privileged", { type: "firm" }, cfg)).toBe(false);
    expect(can(staff(["read_only"]), "trust.reconcile", { type: "firm" }, cfg)).toBe(false);
    expect(roleHolds("paralegal", "documents.privileged", overrides)).toBe(false);
    expect(roleHolds("paralegal", "nope", overrides)).toBe(false);
  });

  it("an override grant of an attorney-only right still needs the lawyer role", () => {
    const cfg = { overrides: [{ role: "owner", right: "matters.open", effect: "grant" as const }] };
    expect(decide(staff(["owner"]), "matters.open", { type: "firm" }, cfg)).toMatchObject({ allowed: false, reason: "attorney_only" });
    expect(can(staff(["owner", "lawyer"]), "matters.open", { type: "firm" }, cfg)).toBe(true);
  });

  it("a deny on one role does not remove a right another held role grants", () => {
    const cfg = { overrides: [{ role: "paralegal", right: "documents.privileged", effect: "deny" as const }] };
    expect(can(staff(["paralegal", "lawyer"]), "documents.privileged", { type: "firm" }, cfg)).toBe(true);
  });
});

describe("planOverrideChange", () => {
  it("records a real change with before/after", () => {
    const p = planOverrideChange([], { role: "owner", right: "conflicts.party_index", effect: "grant" });
    expect(p).toMatchObject({ ok: true, changed: true, before: { effective: false, override: null }, after: { effective: true, override: "grant" } });
    expect(p.next).toEqual([{ role: "owner", right: "conflicts.party_index", effect: "grant" }]);
  });

  it("normalises an override equal to the default into a clear", () => {
    const p = planOverrideChange([], { role: "lawyer", right: "matters.view", effect: "grant" });
    expect(p).toMatchObject({ ok: true, changed: false, next: [] });
    const cur: PermissionOverride[] = [{ role: "paralegal", right: "documents.privileged", effect: "deny" }];
    const back = planOverrideChange(cur, { role: "paralegal", right: "documents.privileged", effect: "grant" });
    expect(back).toMatchObject({ ok: true, changed: true, next: [], after: { effective: true, override: null } });
  });

  it("clears an override", () => {
    const cur: PermissionOverride[] = [{ role: "owner", right: "conflicts.party_index", effect: "grant" }];
    const p = planOverrideChange(cur, { role: "owner", right: "conflicts.party_index", effect: null });
    expect(p).toMatchObject({ ok: true, changed: true, next: [], after: { effective: false, override: null } });
  });

  it("refuses invalid changes and drops invalid stored rows from `next`", () => {
    const cur: PermissionOverride[] = [{ role: "owner", right: "trust.reconcile", effect: "deny" }];
    expect(planOverrideChange(cur, { role: "paralegal", right: "trust.reconcile", effect: "grant" }).ok).toBe(false);
    expect(planOverrideChange(cur, { role: "nobody", right: "matters.view", effect: null }).ok).toBe(false);
    const p = planOverrideChange(cur, { role: "admin", right: "conflicts.log", effect: "grant" });
    expect(p.next).toEqual([{ role: "admin", right: "conflicts.log", effect: "grant" }]);
  });
});

describe("buildMatrix", () => {
  it("covers every right × role and marks editability consistently with validateOverride", () => {
    const m = buildMatrix([{ role: "owner", right: "conflicts.party_index", effect: "grant" }]);
    expect(m).toHaveLength(RIGHTS.length);
    for (const row of m) {
      expect(row.cells.map((c) => c.role)).toEqual([...FIRM_ROLES]);
      for (const c of row.cells) {
        const effect = c.effective ? "deny" : "grant";
        expect(c.editable).toBe(validateOverride({ role: c.role, right: c.right, effect }).length === 0);
      }
    }
    const cell = m.find((r) => r.right.key === "conflicts.party_index")!.cells.find((c) => c.role === "owner")!;
    expect(cell).toMatchObject({ byDefault: false, effective: true, source: "granted", editable: true });
    const locked = m.find((r) => r.right.key === "trust.reconcile")!.cells.find((c) => c.role === "owner")!;
    expect(locked).toMatchObject({ editable: false, note: "Fixed for safety." });
    const ownerPerm = m.find((r) => r.right.key === "permissions.manage")!.cells.find((c) => c.role === "owner")!;
    expect(ownerPerm.editable).toBe(false);
  });
});

describe("matter-level access", () => {
  const matter = { type: "matter" as const, matterId: "m1", teamUserIds: [U1], screenedUserIds: [] as string[], clientPartyIds: [P1] };

  it("screens beat every role, including owner", () => {
    const screened = { ...matter, screenedUserIds: [U1] };
    for (const roles of [["owner"], ["lawyer", "conflicts_attorney"], ["admin"]] as FirmRole[][]) {
      expect(decide(staff(roles), "matters.view", screened)).toMatchObject({ allowed: false, reason: "screened" });
    }
    // and it applies to rows that belong to the matter
    expect(can(staff(["owner"]), "documents.view", { type: "document", clientVisible: false, privilegeTag: "none", matter: screened })).toBe(false);
    expect(can(staff(["owner"]), "calendar.view", { type: "task", visibility: "internal", matter: screened })).toBe(false);
  });

  it("restricted matters are team-only whatever the role", () => {
    const restricted = { ...matter, restricted: true };
    expect(can(staff(["lawyer"], U1), "matters.view", restricted)).toBe(true);
    expect(decide(staff(["owner"], U2), "matters.view", restricted)).toMatchObject({ reason: "restricted_matter" });
  });

  it("without matters.access_all a person sees only their team's matters", () => {
    const cfg = { overrides: [{ role: "paralegal", right: "matters.access_all", effect: "deny" as const }] };
    expect(can(staff(["paralegal"], U1), "matters.view", matter, cfg)).toBe(true);
    expect(decide(staff(["paralegal"], U2), "matters.view", matter, cfg)).toMatchObject({ reason: "not_on_matter_team" });
    expect(can(staff(["paralegal"], U2), "matters.view", matter)).toBe(true);
    // the synthetic dev principal (no user id) is never "on the team"
    expect(can(staff(["paralegal"], null), "matters.view", matter, cfg)).toBe(false);
  });

  it("the system is not scoped to matter teams", () => {
    expect(can({ kind: "system" }, "matters.view", { ...matter, restricted: true })).toBe(true);
  });

  it("clients see only matters where they are the client", () => {
    expect(can(client(P1), "portal.view_matter", matter)).toBe(true);
    expect(decide(client(P2), "portal.view_matter", matter)).toMatchObject({ reason: "not_clients_matter" });
  });

  it("a right without the role still fails before matter rules", () => {
    expect(decide(staff(["read_only"]), "matters.edit", matter)).toMatchObject({ reason: "role_lacks_right" });
  });
});

describe("internal-only flags, tasks and privileged documents", () => {
  const m = { matterId: "m1", teamUserIds: [U1], clientPartyIds: [P1] };

  it("clients never see internal flags or tasks (agrees with core clientVisible)", () => {
    const flags = [
      { id: 1, audience: "internal" },
      { id: 2, audience: "client" },
      { id: 3, audience: "both" },
      { id: 4, audience: "weird" },
    ];
    const allowed = filterAllowed(client(), "portal.view_tasks", flags, (f) => ({ type: "flag", audience: f.audience, matter: m }));
    expect(allowed.map((f) => f.id)).toEqual(clientVisible(flags).map((f) => f.id));
    const tasks = [
      { id: 1, visibility: "internal" },
      { id: 2, visibility: "client" },
    ];
    expect(filterAllowed(client(), "portal.view_tasks", tasks, (t) => ({ type: "task", visibility: t.visibility, matter: m })).map((t) => t.id)).toEqual([2]);
  });

  it("staff need flags.internal for internal flags", () => {
    const cfg = { overrides: [{ role: "read_only", right: "flags.internal", effect: "deny" as const }] };
    const internal = { type: "flag" as const, audience: "internal", matter: m };
    expect(can(staff(["read_only"]), "matters.view", internal)).toBe(true);
    expect(decide(staff(["read_only"]), "matters.view", internal, cfg)).toMatchObject({ reason: "internal_only" });
    expect(can(staff(["read_only"]), "matters.view", { ...internal, audience: "client" }, cfg)).toBe(true);
  });

  it("clients see only shared, non-privileged documents (agrees with core clientShareableDocuments)", () => {
    const docs = ["none", "confidential", "privileged", "work_product", "sealed"].flatMap((privilegeTag, i) => [
      { id: `${i}a`, clientVisible: true, privilegeTag },
      { id: `${i}b`, clientVisible: false, privilegeTag },
    ]);
    const mine = filterAllowed(client(), "portal.view_documents", docs, (d) => ({ type: "document", ...d, matter: m }));
    expect(mine.map((d) => d.id)).toEqual(clientShareableDocuments(docs).map((d) => d.id));
  });

  it("staff need documents.privileged for privileged, work-product and sealed documents", () => {
    for (const tag of ["privileged", "work_product", "sealed"]) {
      const doc = { type: "document" as const, clientVisible: false, privilegeTag: tag, matter: m };
      expect(decide(staff(["intake_staff"]), "documents.view", doc)).toMatchObject({ reason: "privileged" });
      expect(can(staff(["paralegal"]), "documents.view", doc)).toBe(true);
    }
    expect(can(staff(["intake_staff"]), "documents.view", { type: "document", clientVisible: false, privilegeTag: "confidential", matter: m })).toBe(true);
  });
});

describe("role assignment", () => {
  it("maps c34 accounts to product roles", () => {
    expect(baseRolesFor("firm_admin")).toEqual(["admin"]);
    expect(baseRolesFor("attorney", ["conflicts_attorney"])).toEqual(["lawyer", "conflicts_attorney"]);
    expect(baseRolesFor("intake_staff", ["bookkeeper", "conflicts_attorney"])).toEqual(["intake_staff", "bookkeeper"]);
    expect(baseRolesFor("read_only", ["bookkeeper"])).toEqual(["read_only"]);
    expect(baseRolesFor("integration_service", ["bookkeeper"])).toEqual([]);
    expect(baseRolesFor(null)).toEqual([]);
  });

  it("combines roles canonically and never mixes in client", () => {
    expect(combineRoles(["lawyer"], ["owner", "client", "x", "lawyer"])).toEqual(["owner", "lawyer"]);
  });

  const owner = { userId: U1, roles: ["owner"], status: "active" };
  const admin = { userId: U1, roles: ["admin"], status: "active" };
  const grantee = { userId: U2, status: "active", roles: ["lawyer"] };

  it("validates grants", () => {
    expect(validateRoleGrant({ granter: owner, grantee, role: "conflicts_attorney", reason: "designated" })).toEqual([]);
    expect(validateRoleGrant({ granter: admin, grantee, role: "paralegal", reason: "r" })).toEqual([]);
    expect(validateRoleGrant({ granter: admin, grantee, role: "owner", reason: "r" })).toContain("Only an owner can make someone an owner.");
    expect(validateRoleGrant({ granter: admin, grantee, role: "owner", reason: "r", ownerCount: 1 })).toContain("Only an owner can make someone an owner.");
    // bootstrap: a firm with no owner yet lets a permissions manager name the first one
    expect(validateRoleGrant({ granter: admin, grantee, role: "owner", reason: "founding partner", ownerCount: 0 })).toEqual([]);
    expect(validateRoleGrant({ granter: owner, grantee: { ...grantee, roles: ["paralegal"] }, role: "conflicts_attorney", reason: "r" })[0]).toMatch(/must be a lawyer/);
    expect(validateRoleGrant({ granter: owner, grantee, role: "client", reason: "r" })[0]).toMatch(/Clients/);
    expect(validateRoleGrant({ granter: owner, grantee, role: "boss", reason: "r" })[0]).toMatch(/Unknown/);
    expect(validateRoleGrant({ granter: owner, grantee, role: "lawyer", reason: "r" }).join()).toMatch(/already holds|account type/);
    expect(validateRoleGrant({ granter: owner, grantee: { ...grantee, userId: U1 }, role: "paralegal", reason: "r" })).toContain("Nobody can give themselves a role.");
    expect(validateRoleGrant({ granter: owner, grantee: { ...grantee, status: "disabled" }, role: "paralegal", reason: "r" })).toContain("Roles can only be given to active users.");
    expect(validateRoleGrant({ granter: owner, grantee, role: "paralegal", reason: " " })).toContain("A reason is required.");
    expect(validateRoleGrant({ granter: { userId: U1, roles: ["lawyer"] }, grantee, role: "paralegal", reason: "r" })[0]).toMatch(/manages permissions/);
  });

  it("validates revocations, keeping at least one owner", () => {
    const target = { userId: U2, assignedRoles: ["owner", "paralegal"] };
    expect(validateRoleRevoke({ revoker: owner, target, role: "owner", reason: "left", ownerCount: 2 })).toEqual([]);
    expect(validateRoleRevoke({ revoker: owner, target, role: "owner", reason: "left", ownerCount: 1 })).toContain("The firm must keep at least one owner.");
    expect(validateRoleRevoke({ revoker: admin, target, role: "owner", reason: "x", ownerCount: 3 })).toContain("Only an owner can remove an owner.");
    expect(validateRoleRevoke({ revoker: admin, target, role: "lawyer", reason: "x", ownerCount: 3 })[0]).toMatch(/not assigned here/);
    expect(validateRoleRevoke({ revoker: admin, target, role: "paralegal", reason: "", ownerCount: 3 })).toContain("A reason is required.");
    expect(validateRoleRevoke({ revoker: { userId: U1, roles: ["paralegal"] }, target, role: "paralegal", reason: "x", ownerCount: 3 })[0]).toMatch(/manages permissions/);
  });
});

describe("self-containment (so the Foundation can move this file into src/core as a copy)", () => {
  it("policy.ts imports nothing", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./policy.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/^\s*import\s/m);
    expect(src).not.toMatch(/require\(/);
  });
});
