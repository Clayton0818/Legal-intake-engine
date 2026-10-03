# c99 — Detailed permissions for each role

**Builds on:** c34 (staff auth + `users.role` + `user_capabilities`, platform engine). **Code:** `src/engines/all-engines/permissions/policy.ts` (pure), `service.ts` (DB).

## Model

Product roles: **owner, admin, lawyer, paralegal, intake staff, bookkeeper, conflicts attorney, read only, client**. A person can hold several staff roles; rights are the union.

- Roles implied by the c34 account (`baseRolesFor`): `firm_admin → admin`, `attorney → lawyer`, `intake_staff → intake staff`, `read_only → read only`; c34 capabilities `conflicts_attorney` (attorneys only) and `bookkeeper` add those roles. `integration_service` gets no product role.
- Other roles (owner, paralegal, extra bookkeeper / conflicts designations) are assigned here (`firm_role_assignments`, history kept). The first owner can be named by an admin (bootstrap); after that only an owner names or removes an owner, and the last owner cannot be removed.
- Clients are never users: a client actor is `{ kind: "client", partyId }` and only holds portal rights on matters where `matter_parties.role = 'client'`.

`RIGHTS` (47 rights in 11 areas) each have default roles, eligible roles (what a firm override may grant), and flags: `locked` (no override), `decision` (never the system or AI), `attorneyOnly` (needs the lawyer role whatever else grants it), `clientRight`.

`can(actor, right, resource)` = role defaults + firm overrides − invariants, then resource rules.

### Invariants no override can break
1. Clear a conflict, confirm a deadline, approve a document, approve a trust disbursement, open/close a matter are **decisions**: never the system, never the AI (the AI holds no rights at all).
2. Attorney-only rights need the **lawyer** role (an owner who is not a lawyer cannot confirm a deadline; a conflicts attorney must also be a lawyer).
3. **Locked**: trust reconciliation = bookkeeper + owner only; deciding conflicts = conflicts attorney; the four guardrail decisions; all portal rights.
4. Party index: conflicts attorney by default; the firm may extend it to the owner only (mirrors the conflict-check engine's `ownerSeesPartyDetails`).
5. Overrides only grant to eligible roles; invalid stored rows are ignored at evaluation time.
6. Client + staff role on one actor → nothing (fail closed). Inactive users → nothing.
7. The owner always keeps `permissions.manage`; nobody can save a change that removes their own `permissions.manage`.

### Matter-level access
- **Ethical screens (c60)** beat every role, including owner, for the matter and every row (documents, tasks, flags) attached to it.
- **Restricted matters** (`matter_access_settings`): team only, whatever the role.
- Without `matters.access_all` (firm can remove it per role), a person sees only matters whose team they are on (`matters.assigned_user_id` + `matter_team_members`).
- **Internal-only flags/tasks** never reach clients; staff need `flags.internal`. Client document access matches `clientShareableDocuments()` in core; staff need `documents.privileged` for privileged / work-product / sealed documents.

### Audit
Every override, role grant/revoke, matter restriction and team change writes `access_change_log` (append-only; before/after JSON, reason required) and `audit_events`. A refused API attempt writes `all-engines.access.denied` to `audit_events`.

## API and pages
- `GET /api/all-engines/me` — my roles and rights.
- `GET|PUT /api/all-engines/permissions` — matrix; change one cell `{ role, right, effect: grant|deny|null, reason }`.
- `GET /api/all-engines/permissions/log` — change log.
- `GET|POST|DELETE /api/all-engines/roles` — role holders; assign/remove.
- `GET|PUT /api/all-engines/matters/:id/access`, `POST|DELETE /api/all-engines/matters/:id/team`.
- `/admin/all-engines/permissions` — editable matrix (fixed cells greyed with the reason), role holders, recent changes.

## Foundation requests (exact)
1. **Move the policy to core:** copy `src/engines/all-engines/permissions/policy.ts` verbatim to `src/core/permissions.ts` (it has no imports; a test enforces that) and export it from `src/core/index.ts`. Engines then call `can()` instead of their local adapters (`conflict-check/access.ts`, c34 `src/auth/rbac.ts`). This engine would re-export from core.
2. **Expose it in `tenantRoute`:** add an optional `{ right, resource? }` to `tenantRoute(label, handler, opts)` that resolves the principal, loads `permission_overrides` + `firm_role_assignments` (or a `loadPolicyActor(tx, tenantId, principal)` in core) and returns 403 + an `access.denied` audit row when `can()` is false; pass `actor` and `config` to the handler.
3. **Reconcile with c34:** `src/auth/rbac.ts` `permissionsFor()` should become a view over `can()`; capabilities `conflicts_attorney`/`bookkeeper` stay as c34 grants mapped by `baseRolesFor`. `listRoleHolders` cannot read `user_capabilities` (platform table) — the route should pass capabilities, or the table should move to foundation.
4. **Screens in a shared table:** active ethical screens live in `conflict_screens` (conflict-check). For `can()` to enforce them everywhere, expose `screenedUserIds(matterId)` via a shared view/table (e.g. `matter_screens` in foundation) that the conflict-check engine writes.
5. **Matter team/restriction** tables (`matter_team_members`, `matter_access_settings`) are generally useful and could move to foundation with the policy.
6. Later: SQL-level role policies (RLS) for party-index and trust-reconciliation tables evaluating the same matrix.

## Open questions for Clayton / an attorney
- Should paralegals see privileged documents by default (currently yes) and should intake staff see every matter (currently yes; firm can remove)?
- Are children ever to be indexed as parties (c56 OQ3) — affects `contacts.safe_contact` reach?
- Is "owner" always a lawyer at pilot firms? If not, which owner actions should require a lawyer?
