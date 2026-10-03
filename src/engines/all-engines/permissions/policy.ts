// c99 — detailed permissions for each role. THE policy layer.
//
// Pure and SELF-CONTAINED on purpose: this file imports nothing (not even
// @/core), so the Foundation can move it to src/core/permissions.ts as a
// straight copy and every engine and tenantRoute can call
// `can(actor, right, resource)` without importing this engine (see
// docs/product/features/all-engines/c99-permissions.md, "Foundation requests").
//
// Model
//   effectiveRights(actor) = ⋃ ROLE DEFAULTS of every role the actor holds
//                            + per-firm overrides (grant/deny, per role × right)
//                            − anything the INVARIANTS below forbid.
//   can(actor, right, resource) = right ∈ effectiveRights(actor)
//                                 ∧ the resource rules (matter team, screens,
//                                   restricted matters, internal-only flags,
//                                   privileged documents, client scope) allow it.
//
// Invariants (no firm override can break these; they are enforced at
// evaluation time as well as when an override is saved):
//   1. "Decision" rights (clear a conflict, confirm a deadline, approve a
//      document, approve a trust disbursement, open/close a matter) are never
//      held by the system or the AI, only by a person.
//   2. "Attorney-only" rights additionally need the lawyer role, whatever
//      else the actor holds (an owner who is not a lawyer cannot confirm a
//      deadline).
//   3. Locked rights cannot be overridden at all (e.g. trust reconciliation:
//      bookkeeper and owner only; party index: conflicts attorney (+ owner,
//      if the firm grants it)).
//   4. Overrides may only grant a right to a role listed as eligible for it.
//   5. A client actor only ever holds portal rights, only on matters where
//      it is the client, and never sees internal flags/tasks or privileged
//      documents. A user holding a staff role and the client role at once is
//      treated as holding nothing (fail closed).
//   6. An ethical screen (c60) beats every role, including owner.
//   7. The owner can never lose `permissions.manage` (no lock-out).
//   8. Inactive users hold nothing.

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

export const FIRM_ROLES = [
  "owner",
  "admin",
  "lawyer",
  "paralegal",
  "intake_staff",
  "bookkeeper",
  "conflicts_attorney",
  "read_only",
  "client",
] as const;
export type FirmRole = (typeof FIRM_ROLES)[number];

export const STAFF_ROLES: readonly FirmRole[] = FIRM_ROLES.filter((r) => r !== "client");

export const ROLE_INFO: Readonly<Record<FirmRole, { label: string; description: string }>> = {
  owner: { label: "Owner", description: "Firm owner: everything a firm admin can do, plus trust reconciliation and financial reports." },
  admin: { label: "Firm admin", description: "Runs the firm's settings, users and day-to-day operations. Not a lawyer by role." },
  lawyer: { label: "Lawyer", description: "Licensed attorney: the only role that can make legal decisions in the product." },
  paralegal: { label: "Paralegal", description: "Works matters under a lawyer's supervision; cannot make legal decisions." },
  intake_staff: { label: "Intake staff", description: "Handles new inquiries, contacts and scheduling." },
  bookkeeper: { label: "Bookkeeper", description: "Records billing and trust ledger entries and reconciles trust. Recording is not moving money." },
  conflicts_attorney: { label: "Conflicts attorney", description: "The lawyer who searches the party index and decides possible conflicts." },
  read_only: { label: "Read only", description: "Can look, cannot change anything." },
  client: { label: "Client", description: "A client using the portal: only their own matters and only what the firm shared." },
};

export function isFirmRole(v: unknown): v is FirmRole {
  return typeof v === "string" && (FIRM_ROLES as readonly string[]).includes(v);
}

export function isStaffRole(v: unknown): v is FirmRole {
  return isFirmRole(v) && v !== "client";
}

// ---------------------------------------------------------------------------
// Rights catalogue
// ---------------------------------------------------------------------------

export type RightArea =
  | "matters"
  | "intake"
  | "contacts"
  | "conflicts"
  | "documents"
  | "calendar"
  | "billing"
  | "trust"
  | "reports"
  | "administration"
  | "portal";

export interface RightDef {
  key: string;
  area: RightArea;
  label: string;
  description: string;
  /** Roles that hold it out of the box. */
  defaultRoles: readonly FirmRole[];
  /** Roles a firm override may grant it to (always ⊇ defaultRoles). */
  eligibleRoles: readonly FirmRole[];
  /** No firm override at all (grant or deny). */
  locked?: boolean;
  /** A human decision: never held by the system or the AI. */
  decision?: boolean;
  /** Needs the lawyer role on top of whichever role grants it. */
  attorneyOnly?: boolean;
  /** A client-portal right (the only kind a client can hold). */
  clientRight?: boolean;
}

const ALL_STAFF = STAFF_ROLES;
const WORKERS: readonly FirmRole[] = ["owner", "admin", "lawyer", "paralegal", "intake_staff"];
const MANAGERS: readonly FirmRole[] = ["owner", "admin"];

function right<K extends string>(
  def: Omit<RightDef, "eligibleRoles" | "key"> & { key: K; eligibleRoles?: readonly FirmRole[] }
): RightDef & { key: K } {
  return { ...def, eligibleRoles: def.eligibleRoles ?? def.defaultRoles };
}

export const RIGHTS = [
  // --- Matters ---
  right({ key: "matters.view", area: "matters", label: "See matters", description: "Open matters they can access (team, screens and restrictions still apply).", defaultRoles: ALL_STAFF, eligibleRoles: ALL_STAFF }),
  right({ key: "matters.access_all", area: "matters", label: "See every matter", description: "Without it, a person only sees matters whose team they are on.", defaultRoles: ALL_STAFF, eligibleRoles: ALL_STAFF }),
  right({ key: "matters.edit", area: "matters", label: "Edit matter details", description: "Change matter fields, parties and stage.", defaultRoles: WORKERS, eligibleRoles: ALL_STAFF.filter((r) => r !== "read_only") }),
  right({ key: "matters.open", area: "matters", label: "Open a matter", description: "Turn a prospect into an open matter once every gate is met (c68).", defaultRoles: ["lawyer"], decision: true, attorneyOnly: true, eligibleRoles: ["lawyer", "conflicts_attorney", "owner"] }),
  right({ key: "matters.close", area: "matters", label: "Close a matter", description: "Close the file (c90).", defaultRoles: ["lawyer"], decision: true, attorneyOnly: true, eligibleRoles: ["lawyer", "conflicts_attorney", "owner"] }),
  // --- Intake ---
  right({ key: "intake.view", area: "intake", label: "See intake queue", description: "New inquiries from every channel.", defaultRoles: [...WORKERS, "read_only"], eligibleRoles: ALL_STAFF }),
  right({ key: "intake.manage", area: "intake", label: "Work intake", description: "Respond to, assign, book and follow up inquiries.", defaultRoles: WORKERS, eligibleRoles: WORKERS }),
  // --- Contacts ---
  right({ key: "contacts.view", area: "contacts", label: "See contacts", description: "Names and roles of people on matters.", defaultRoles: ALL_STAFF, eligibleRoles: ALL_STAFF }),
  right({ key: "contacts.edit", area: "contacts", label: "Edit contacts", description: "Add or correct people and organisations.", defaultRoles: WORKERS, eligibleRoles: WORKERS }),
  right({ key: "contacts.safe_contact", area: "contacts", label: "See safe-contact details", description: "A client's safe address/number and DV-safety notes (c103). Kept to the people who contact clients.", defaultRoles: ["owner", "lawyer", "paralegal", "intake_staff"], eligibleRoles: WORKERS }),
  // --- Conflicts ---
  right({ key: "conflicts.run", area: "conflicts", label: "Run a conflict check", description: "Start a check; results that are not clear go to the conflicts attorney.", defaultRoles: [...WORKERS, "conflicts_attorney"], eligibleRoles: [...WORKERS, "conflicts_attorney"] }),
  right({ key: "conflicts.party_index", area: "conflicts", label: "Search the party index", description: "Browse everyone the firm has dealt with (c56). Conflicts role only; the owner only if the firm turns it on.", defaultRoles: ["conflicts_attorney"], eligibleRoles: ["conflicts_attorney", "owner"] }),
  right({ key: "conflicts.decide", area: "conflicts", label: "Decide a possible conflict", description: "Clear, decline or waive (c59). Never the AI.", defaultRoles: ["conflicts_attorney"], locked: true, decision: true, attorneyOnly: true }),
  right({ key: "conflicts.log", area: "conflicts", label: "Read the conflicts log", description: "Per-check records and exports (c63).", defaultRoles: ["conflicts_attorney", "owner"], eligibleRoles: ["conflicts_attorney", "owner", "admin"] }),
  // --- Documents ---
  right({ key: "documents.view", area: "documents", label: "See documents", description: "Matter documents that are not privileged or sealed.", defaultRoles: ALL_STAFF, eligibleRoles: ALL_STAFF }),
  right({ key: "documents.upload", area: "documents", label: "Upload documents", description: "Add documents and new versions.", defaultRoles: WORKERS, eligibleRoles: [...WORKERS, "bookkeeper"] }),
  right({ key: "documents.privileged", area: "documents", label: "See privileged documents", description: "Documents tagged privileged, work product or sealed (c88).", defaultRoles: ["owner", "lawyer", "paralegal", "conflicts_attorney"], eligibleRoles: ["owner", "admin", "lawyer", "paralegal", "conflicts_attorney"] }),
  right({ key: "documents.approve", area: "documents", label: "Approve a document", description: "Lawyer approval before a document goes to a client or a court.", defaultRoles: ["lawyer"], locked: true, decision: true, attorneyOnly: true }),
  right({ key: "documents.share_with_client", area: "documents", label: "Share with the client", description: "Make a document visible in the client portal.", defaultRoles: ["lawyer"], eligibleRoles: ["lawyer", "paralegal"] }),
  right({ key: "templates.manage", area: "documents", label: "Manage templates", description: "Edit the firm's templates and checklists (each still needs lawyer approval).", defaultRoles: ["owner", "admin", "lawyer"], eligibleRoles: ["owner", "admin", "lawyer", "paralegal"] }),
  // --- Calendar, tasks, flags ---
  right({ key: "calendar.view", area: "calendar", label: "See calendar and tasks", description: "Matter calendar, task lists and stages.", defaultRoles: ALL_STAFF, eligibleRoles: ALL_STAFF }),
  right({ key: "calendar.edit", area: "calendar", label: "Edit calendar and tasks", description: "Add events and tasks; propose deadlines.", defaultRoles: WORKERS, eligibleRoles: [...WORKERS, "bookkeeper"] }),
  right({ key: "deadlines.confirm", area: "calendar", label: "Confirm a deadline", description: "Every computed date is only proposed until a lawyer confirms it.", defaultRoles: ["lawyer"], locked: true, decision: true, attorneyOnly: true }),
  right({ key: "flags.internal", area: "calendar", label: "See internal flags", description: "Overdue and other internal-only flags. Never shown to clients.", defaultRoles: ALL_STAFF, eligibleRoles: ALL_STAFF }),
  right({ key: "flags.acknowledge", area: "calendar", label: "Acknowledge and clear flags", description: "With a reason, logged.", defaultRoles: WORKERS, eligibleRoles: [...WORKERS, "bookkeeper", "conflicts_attorney"] }),
  // --- Billing ---
  right({ key: "time.record", area: "billing", label: "Record time", description: "Time entries on matters they work.", defaultRoles: ["lawyer", "paralegal", "conflicts_attorney"], eligibleRoles: ["owner", "lawyer", "paralegal", "conflicts_attorney", "intake_staff"] }),
  right({ key: "billing.view", area: "billing", label: "See billing", description: "Invoices, balances, payments.", defaultRoles: ["owner", "admin", "lawyer", "bookkeeper"], eligibleRoles: ["owner", "admin", "lawyer", "bookkeeper", "paralegal", "conflicts_attorney"] }),
  right({ key: "billing.edit", area: "billing", label: "Edit billing", description: "Draft invoices, record payments to operating.", defaultRoles: ["owner", "bookkeeper"], eligibleRoles: ["owner", "admin", "bookkeeper", "lawyer"] }),
  right({ key: "invoices.approve", area: "billing", label: "Approve an invoice", description: "Release an invoice to the client.", defaultRoles: ["lawyer", "owner"], decision: true, eligibleRoles: ["lawyer", "owner", "conflicts_attorney"] }),
  // --- Trust ---
  right({ key: "trust.view", area: "trust", label: "See trust balances", description: "Per-matter trust balances and ledger.", defaultRoles: ["owner", "lawyer", "bookkeeper"], eligibleRoles: ["owner", "admin", "lawyer", "bookkeeper", "conflicts_attorney"] }),
  right({ key: "trust.record", area: "trust", label: "Record trust entries", description: "Record ledger entries. Moving trust money still needs the trust-accounting approval and a lawyer.", defaultRoles: ["bookkeeper"], eligibleRoles: ["bookkeeper", "owner"] }),
  right({ key: "trust.reconcile", area: "trust", label: "Trust reconciliation", description: "Three-way reconciliation (c76). Bookkeeper and owner only.", defaultRoles: ["owner", "bookkeeper"], locked: true }),
  right({ key: "trust.approve_disbursement", area: "trust", label: "Approve a trust disbursement", description: "A lawyer's approval for money leaving trust.", defaultRoles: ["lawyer"], locked: true, decision: true, attorneyOnly: true }),
  // --- Reports ---
  right({ key: "reports.operational", area: "reports", label: "Operational reports", description: "Workload, response times, pipeline.", defaultRoles: ["owner", "admin", "lawyer"], eligibleRoles: ["owner", "admin", "lawyer", "paralegal", "intake_staff", "conflicts_attorney"] }),
  right({ key: "reports.financial", area: "reports", label: "Financial reports", description: "Revenue, collections, profitability.", defaultRoles: ["owner", "bookkeeper"], eligibleRoles: ["owner", "bookkeeper", "admin"] }),
  // --- Administration ---
  right({ key: "settings.manage", area: "administration", label: "Firm settings", description: "Business hours, reply windows, engine settings.", defaultRoles: MANAGERS }),
  right({ key: "practice_areas.manage", area: "administration", label: "Practice areas", description: "Turn practice areas on or off and accept pack updates (c102).", defaultRoles: MANAGERS }),
  right({ key: "permissions.manage", area: "administration", label: "Permissions", description: "Change this matrix and who holds which role. Every change is logged.", defaultRoles: MANAGERS }),
  right({ key: "users.manage", area: "administration", label: "Users", description: "Invite, disable and edit staff accounts.", defaultRoles: MANAGERS }),
  right({ key: "audit.view", area: "administration", label: "Audit trail", description: "Read the firm's audit log (c6).", defaultRoles: MANAGERS, eligibleRoles: [...MANAGERS, "lawyer", "conflicts_attorney"] }),
  right({ key: "data_import.run", area: "administration", label: "Data import", description: "Import from a previous system (c98).", defaultRoles: MANAGERS }),
  // --- Client portal (client role only; never overridable) ---
  right({ key: "portal.view_matter", area: "portal", label: "See own matter", description: "Status and client-side items of their own matter.", defaultRoles: ["client"], locked: true, clientRight: true }),
  right({ key: "portal.view_documents", area: "portal", label: "See shared documents", description: "Only documents a lawyer shared, never privileged ones.", defaultRoles: ["client"], locked: true, clientRight: true }),
  right({ key: "portal.upload_documents", area: "portal", label: "Upload requested documents", description: "Into their own matter's requests.", defaultRoles: ["client"], locked: true, clientRight: true }),
  right({ key: "portal.view_tasks", area: "portal", label: "See own tasks and flags", description: "Client-side tasks and flags only.", defaultRoles: ["client"], locked: true, clientRight: true }),
  right({ key: "portal.message_firm", area: "portal", label: "Message the firm", description: "Secure messages on their own matter.", defaultRoles: ["client"], locked: true, clientRight: true }),
  right({ key: "portal.pay", area: "portal", label: "Pay an invoice", description: "Through the gated payment processor.", defaultRoles: ["client"], locked: true, clientRight: true }),
] as const;

export type Right = (typeof RIGHTS)[number]["key"];

const RIGHT_BY_KEY: ReadonlyMap<string, RightDef> = new Map(RIGHTS.map((r) => [r.key, r]));

export const RIGHT_KEYS: readonly Right[] = RIGHTS.map((r) => r.key);

export function isRight(v: unknown): v is Right {
  return typeof v === "string" && RIGHT_BY_KEY.has(v);
}

export function rightDef(key: string): RightDef | undefined {
  return RIGHT_BY_KEY.get(key);
}

// ---------------------------------------------------------------------------
// Firm overrides
// ---------------------------------------------------------------------------

export type OverrideEffect = "grant" | "deny";

export interface PermissionOverride {
  role: string;
  right: string;
  effect: OverrideEffect;
}

/** Why an override is not allowed (empty = allowed). Pure. */
export function validateOverride(o: { role: unknown; right: unknown; effect: unknown }): string[] {
  const errors: string[] = [];
  if (!isFirmRole(o.role)) errors.push(`Unknown role '${String(o.role)}'.`);
  if (!isRight(o.right)) errors.push(`Unknown right '${String(o.right)}'.`);
  if (o.effect !== "grant" && o.effect !== "deny") errors.push("effect must be 'grant' or 'deny'.");
  if (errors.length > 0) return errors;
  const def = rightDef(o.right as string)!;
  const role = o.role as FirmRole;
  if (role === "client") errors.push("Client rights are fixed and cannot be changed.");
  else if (def.locked) errors.push(`'${def.label}' is fixed for safety and cannot be changed by the firm.`);
  else if (def.clientRight) errors.push("Portal rights belong to clients only.");
  if (errors.length > 0) return errors;
  if (o.effect === "grant" && !def.eligibleRoles.includes(role)) {
    errors.push(`'${def.label}' cannot be given to ${ROLE_INFO[role].label}. Allowed: ${def.eligibleRoles.map((r) => ROLE_INFO[r].label).join(", ")}.`);
  }
  if (o.effect === "deny" && role === "owner" && def.key === "permissions.manage") {
    errors.push("The owner always keeps the right to manage permissions, so the firm can never lock itself out.");
  }
  return errors;
}

function overrideFor(overrides: readonly PermissionOverride[], role: FirmRole, key: string): OverrideEffect | null {
  // Last valid entry wins (callers normally hold one row per role × right).
  let effect: OverrideEffect | null = null;
  for (const o of overrides) {
    if (o.role === role && o.right === key && validateOverride(o).length === 0) effect = o.effect;
  }
  return effect;
}

/** Does `role` hold `key` under these overrides (role-level only, before actor invariants)? Pure. */
export function roleHolds(role: FirmRole, key: string, overrides: readonly PermissionOverride[] = []): boolean {
  const def = rightDef(key);
  if (!def) return false;
  const base = def.defaultRoles.includes(role);
  const o = overrideFor(overrides, role, key);
  if (o === "grant") return true;
  if (o === "deny") return false;
  return base;
}

// ---------------------------------------------------------------------------
// Actors
// ---------------------------------------------------------------------------

export type PolicyActor =
  | { kind: "staff"; userId: string | null; roles: readonly string[]; status?: string | null }
  | { kind: "client"; partyId: string }
  | { kind: "system" }
  | { kind: "ai"; model?: string };

export interface PolicyConfig {
  overrides: readonly PermissionOverride[];
}

export const EMPTY_POLICY_CONFIG: PolicyConfig = Object.freeze({ overrides: Object.freeze([]) as readonly PermissionOverride[] });

function actorRoles(actor: PolicyActor): FirmRole[] {
  if (actor.kind === "client") return ["client"];
  if (actor.kind !== "staff") return [];
  return [...new Set(actor.roles.filter(isFirmRole))];
}

/** Effective rights of an actor (ignores any resource). Pure. */
export function effectiveRights(actor: PolicyActor, config: PolicyConfig = EMPTY_POLICY_CONFIG): Set<Right> {
  const out = new Set<Right>();
  if (actor.kind === "ai") return out;
  if (actor.kind === "system") {
    for (const r of RIGHTS as readonly RightDef[]) if (!r.decision && !r.clientRight) out.add(r.key as Right);
    return out;
  }
  if (actor.kind === "staff" && actor.status && actor.status !== "active") return out;
  const roles = actorRoles(actor);
  if (roles.includes("client") && roles.length > 1) return out; // invariant 5: fail closed
  const isLawyer = roles.includes("lawyer");
  for (const r of RIGHTS as readonly RightDef[]) {
    if (!roles.some((role) => roleHolds(role, r.key, config.overrides))) continue;
    if (r.clientRight && actor.kind !== "client") continue;
    if (!r.clientRight && actor.kind === "client") continue;
    if (r.attorneyOnly && !isLawyer) continue;
    out.add(r.key as Right);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

export interface MatterRef {
  matterId: string;
  /** Users on the matter's team (responsible lawyer, paralegals, assigned staff). */
  teamUserIds?: readonly string[];
  /** Users screened off this matter (c60, active screens only). */
  screenedUserIds?: readonly string[];
  /** Firm-restricted matter (e.g. a staff member's own case): team only, whatever the role. */
  restricted?: boolean;
  /** Parties who are clients on this matter (portal access). */
  clientPartyIds?: readonly string[];
}

export type PolicyResource =
  | { type: "firm" }
  | ({ type: "matter" } & MatterRef)
  | { type: "flag"; audience: string; matter?: MatterRef | null }
  | { type: "task"; visibility: string; matter?: MatterRef | null }
  | { type: "document"; clientVisible: boolean; privilegeTag: string; matter?: MatterRef | null };

export const FIRM: PolicyResource = Object.freeze({ type: "firm" });

export type DenyReason =
  | "unknown_right"
  | "ai_never_authorised"
  | "decision_needs_a_person"
  | "inactive_user"
  | "invalid_role_mix"
  | "attorney_only"
  | "role_lacks_right"
  | "client_portal_only"
  | "screened"
  | "restricted_matter"
  | "not_on_matter_team"
  | "not_clients_matter"
  | "internal_only"
  | "privileged";

export type Decision = { allowed: true; right: Right } | { allowed: false; right: string; reason: DenyReason };

function deny(right: string, reason: DenyReason): Decision {
  return { allowed: false, right, reason };
}

const CLIENT_SAFE_PRIVILEGE = new Set(["none", "confidential"]);
const PRIVILEGED = new Set(["privileged", "work_product", "sealed"]);

function matterOf(resource: PolicyResource): MatterRef | null {
  if (resource.type === "firm") return null;
  if (resource.type === "matter") return resource;
  return resource.matter ?? null;
}

function checkMatter(actor: PolicyActor, key: string, m: MatterRef, rights: Set<Right>): Decision | null {
  if (actor.kind === "client") {
    return (m.clientPartyIds ?? []).includes(actor.partyId) ? null : deny(key, "not_clients_matter");
  }
  if (actor.kind !== "staff") return null; // system: no per-person matter scoping
  const uid = actor.userId;
  if (uid && (m.screenedUserIds ?? []).includes(uid)) return deny(key, "screened");
  const onTeam = uid !== null && (m.teamUserIds ?? []).includes(uid);
  if (m.restricted && !onTeam) return deny(key, "restricted_matter");
  if (!onTeam && !rights.has("matters.access_all")) return deny(key, "not_on_matter_team");
  return null;
}

/** The full decision with a reason. Pure. */
export function decide(
  actor: PolicyActor,
  key: string,
  resource: PolicyResource = FIRM,
  config: PolicyConfig = EMPTY_POLICY_CONFIG
): Decision {
  const def = rightDef(key);
  if (!def) return deny(key, "unknown_right");
  if (actor.kind === "ai") return deny(key, "ai_never_authorised");
  if (actor.kind === "system" && def.decision) return deny(key, "decision_needs_a_person");
  if (actor.kind === "staff" && actor.status && actor.status !== "active") return deny(key, "inactive_user");
  const roles = actorRoles(actor);
  if (roles.includes("client") && roles.length > 1) return deny(key, "invalid_role_mix");
  if (actor.kind === "staff" && def.clientRight) return deny(key, "client_portal_only");
  if (actor.kind === "client" && !def.clientRight) return deny(key, "client_portal_only");

  const rights = effectiveRights(actor, config);
  if (!rights.has(key as Right)) {
    const roleWouldHold = roles.some((r) => roleHolds(r, key, config.overrides));
    return deny(key, def.attorneyOnly && roleWouldHold ? "attorney_only" : "role_lacks_right");
  }

  const matter = matterOf(resource);
  if (matter) {
    const m = checkMatter(actor, key, matter, rights);
    if (m) return m;
  }

  if (resource.type === "flag") {
    const clientSide = resource.audience === "client" || resource.audience === "both";
    if (actor.kind === "client" && !clientSide) return deny(key, "internal_only");
    if (actor.kind === "staff" && !clientSide && !rights.has("flags.internal")) return deny(key, "internal_only");
  }
  if (resource.type === "task" && actor.kind === "client" && resource.visibility !== "client") {
    return deny(key, "internal_only");
  }
  if (resource.type === "document") {
    if (actor.kind === "client") {
      if (!resource.clientVisible || !CLIENT_SAFE_PRIVILEGE.has(resource.privilegeTag)) return deny(key, "privileged");
    } else if (actor.kind === "staff" && PRIVILEGED.has(resource.privilegeTag) && !rights.has("documents.privileged")) {
      return deny(key, "privileged");
    }
  }
  return { allowed: true, right: key as Right };
}

/** `can(actor, right, resource)`: the one question every engine and route asks. Pure. */
export function can(
  actor: PolicyActor,
  key: string,
  resource: PolicyResource = FIRM,
  config: PolicyConfig = EMPTY_POLICY_CONFIG
): boolean {
  return decide(actor, key, resource, config).allowed;
}

export class PermissionDeniedError extends Error {
  readonly status = 403;
  constructor(readonly decision: Extract<Decision, { allowed: false }>) {
    super(`Not allowed: ${rightDef(decision.right)?.label ?? decision.right} (${decision.reason}).`);
    this.name = "PermissionDeniedError";
  }
}

/** Throws PermissionDeniedError when not allowed. */
export function assertCan(
  actor: PolicyActor,
  key: string,
  resource: PolicyResource = FIRM,
  config: PolicyConfig = EMPTY_POLICY_CONFIG
): void {
  const d = decide(actor, key, resource, config);
  if (!d.allowed) throw new PermissionDeniedError(d);
}

/** Keep only the rows the actor may see. `toResource` maps a row to its resource. Pure. */
export function filterAllowed<T>(
  actor: PolicyActor,
  key: string,
  rows: readonly T[],
  toResource: (row: T) => PolicyResource,
  config: PolicyConfig = EMPTY_POLICY_CONFIG
): T[] {
  return rows.filter((row) => can(actor, key, toResource(row), config));
}

// ---------------------------------------------------------------------------
// The matrix (admin page) and diffs (audit trail)
// ---------------------------------------------------------------------------

export type CellSource = "default" | "granted" | "denied";

export interface MatrixCell {
  role: FirmRole;
  right: Right;
  /** Held out of the box. */
  byDefault: boolean;
  /** Held under this firm's overrides (role level, before per-person invariants). */
  effective: boolean;
  source: CellSource;
  /** The firm may change this cell. */
  editable: boolean;
  /** Shown when not editable or when the role holds it only with the lawyer role. */
  note: string | null;
}

export interface MatrixRow {
  right: RightDef;
  cells: MatrixCell[];
}

function cellNote(def: RightDef, role: FirmRole): string | null {
  if (role === "client" || def.clientRight) return def.clientRight && role === "client" ? "Client portal right (fixed)." : "Staff right; clients never hold it.";
  if (def.locked) return "Fixed for safety.";
  if (def.key === "permissions.manage" && role === "owner") return "The owner always keeps this (no lock-out).";
  if (!def.eligibleRoles.includes(role)) return "Not available to this role.";
  if (def.attorneyOnly && role !== "lawyer") return "Also needs the lawyer role.";
  return null;
}

/** The full role × right matrix for one firm. Pure. */
export function buildMatrix(overrides: readonly PermissionOverride[] = []): MatrixRow[] {
  return (RIGHTS as readonly RightDef[]).map((def) => ({
    right: def,
    cells: FIRM_ROLES.map((role): MatrixCell => {
      const byDefault = def.defaultRoles.includes(role);
      const o = overrideFor(overrides, role, def.key);
      const effective = roleHolds(role, def.key, overrides);
      const grantOk = validateOverride({ role, right: def.key, effect: "grant" }).length === 0;
      const denyOk = validateOverride({ role, right: def.key, effect: "deny" }).length === 0;
      return {
        role,
        right: def.key as Right,
        byDefault,
        effective,
        source: o === "grant" ? "granted" : o === "deny" ? "denied" : "default",
        editable: effective ? denyOk : grantOk,
        note: cellNote(def, role),
      };
    }),
  }));
}

export interface OverrideChange {
  role: string;
  right: string;
  /** null clears the override (back to the default). */
  effect: OverrideEffect | null;
}

export interface OverridePlan {
  ok: boolean;
  errors: string[];
  next: PermissionOverride[];
  before: { effective: boolean; override: OverrideEffect | null };
  after: { effective: boolean; override: OverrideEffect | null };
  /** False when the change would not alter anything (no log entry needed). */
  changed: boolean;
}

/**
 * Plan one matrix edit. Setting an override equal to the default is
 * normalised to "clear" so the table only ever holds real differences. Pure.
 */
export function planOverrideChange(current: readonly PermissionOverride[], change: OverrideChange): OverridePlan {
  const role = change.role as FirmRole;
  const valid = current.filter((o) => validateOverride(o).length === 0);
  const existing = isFirmRole(role) ? overrideFor(valid, role, change.right) : null;
  const beforeEffective = isFirmRole(role) ? roleHolds(role, change.right, valid) : false;
  const before = { effective: beforeEffective, override: existing };
  const fail = (errors: string[]): OverridePlan => ({ ok: false, errors, next: [...valid], before, after: before, changed: false });

  if (change.effect !== null) {
    const errors = validateOverride({ role: change.role, right: change.right, effect: change.effect });
    if (errors.length > 0) return fail(errors);
  } else {
    if (!isFirmRole(change.role) || !isRight(change.right)) return fail(validateOverride({ ...change, effect: "deny" }));
  }

  const def = rightDef(change.right)!;
  const byDefault = def.defaultRoles.includes(role);
  let effect = change.effect;
  if (effect === "grant" && byDefault) effect = null;
  if (effect === "deny" && !byDefault) effect = null;

  const rest = valid.filter((o) => !(o.role === role && o.right === change.right));
  const next = effect ? [...rest, { role, right: change.right, effect }] : rest;
  const after = { effective: roleHolds(role, change.right, next), override: effect };
  return { ok: true, errors: [], next, before, after, changed: before.effective !== after.effective || before.override !== after.override };
}

// ---------------------------------------------------------------------------
// Who holds which role
// ---------------------------------------------------------------------------

/**
 * Roles implied by the c34 account (users.role + c34 capabilities). The
 * other product roles (owner, paralegal, extra bookkeeper/conflicts
 * designations) are assigned on top and stored by this engine. Pure.
 */
export function baseRolesFor(userRole: string | null | undefined, capabilities: readonly string[] = []): FirmRole[] {
  const out = new Set<FirmRole>();
  switch (userRole) {
    case "firm_admin":
      out.add("admin");
      break;
    case "attorney":
      out.add("lawyer");
      break;
    case "intake_staff":
      out.add("intake_staff");
      break;
    case "read_only":
      out.add("read_only");
      break;
    default:
      break; // integration_service and unknown values: no product role
  }
  if (capabilities.includes("conflicts_attorney") && userRole === "attorney") out.add("conflicts_attorney");
  if (capabilities.includes("bookkeeper") && userRole !== "integration_service" && userRole !== "read_only" && userRole) out.add("bookkeeper");
  return FIRM_ROLES.filter((r) => out.has(r));
}

/** Base roles ∪ assigned roles, canonical order, client never mixed in. Pure. */
export function combineRoles(base: readonly string[], assigned: readonly string[]): FirmRole[] {
  const set = new Set([...base, ...assigned].filter(isStaffRole));
  return FIRM_ROLES.filter((r) => set.has(r));
}

export interface RoleGrantInput {
  granter: { userId: string | null; roles: readonly string[]; status?: string | null };
  grantee: { userId: string; status: string; roles: readonly string[] };
  role: string;
  reason: string;
  /** Active owners in the firm. With none yet, a permissions manager may name the first owner (bootstrap). */
  ownerCount?: number;
  config?: PolicyConfig;
}

/** Problems with assigning `role` to a user (empty = OK). Pure. */
export function validateRoleGrant(input: RoleGrantInput): string[] {
  const errors: string[] = [];
  const granter: PolicyActor = { kind: "staff", ...input.granter };
  if (!isFirmRole(input.role)) return [`Unknown role '${input.role}'.`];
  if (input.role === "client") return ["Clients are not staff users; portal access comes from the client's matter."];
  if (!can(granter, "permissions.manage", FIRM, input.config)) errors.push("Only someone who manages permissions can assign roles.");
  if (input.role === "owner" && !input.granter.roles.includes("owner") && (input.ownerCount ?? 1) > 0) {
    errors.push("Only an owner can make someone an owner.");
  }
  if (input.granter.userId && input.granter.userId === input.grantee.userId) errors.push("Nobody can give themselves a role.");
  if (input.grantee.status !== "active") errors.push("Roles can only be given to active users.");
  if (input.grantee.roles.includes(input.role)) errors.push("The user already holds this role.");
  if (input.role === "conflicts_attorney" && !input.grantee.roles.includes("lawyer")) {
    errors.push("The conflicts attorney must be a lawyer (give the lawyer role first).");
  }
  if (input.role === "lawyer") {
    errors.push("The lawyer role comes from the user's account type (attorney); change it in user management.");
  }
  if (!input.reason.trim()) errors.push("A reason is required.");
  return errors;
}

export interface RoleRevokeInput {
  revoker: { userId: string | null; roles: readonly string[]; status?: string | null };
  target: { userId: string; assignedRoles: readonly string[] };
  role: string;
  reason: string;
  /** Active owners in the firm, including the target. */
  ownerCount: number;
  config?: PolicyConfig;
}

/** Problems with removing an ASSIGNED role (empty = OK). Pure. */
export function validateRoleRevoke(input: RoleRevokeInput): string[] {
  const errors: string[] = [];
  const revoker: PolicyActor = { kind: "staff", ...input.revoker };
  if (!can(revoker, "permissions.manage", FIRM, input.config)) errors.push("Only someone who manages permissions can remove roles.");
  if (!input.target.assignedRoles.includes(input.role)) {
    errors.push("That role was not assigned here (roles that come from the account type are changed in user management).");
  }
  if (input.role === "owner") {
    if (!input.revoker.roles.includes("owner")) errors.push("Only an owner can remove an owner.");
    if (input.ownerCount <= 1) errors.push("The firm must keep at least one owner.");
  }
  if (!input.reason.trim()) errors.push("A reason is required.");
  return errors;
}
