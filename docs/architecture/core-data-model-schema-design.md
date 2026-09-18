# Core Data Model & Schema Design

**Board card:** `c19` — Core data model & schema design
**Track:** Engineering | **Status:** Design draft — engineering research and a recommended schema, not a finished implementation. No SQL in this document has been run against a real database.
**Depends on:** ADR-0001 (`c18`, PR #5 — merged, especially §D4, §D5, §D6), `c8` (multi-tenant architecture & data isolation, PR #4 — merged), `c9` (encryption & access control review, PR #6 — merged), `c6` (audit log & compliance trail, PR #9 — merged), `c12` (intake flow spec, PR #3 — merged), `c13` (LLM triage classifier spec, PR #8 — merged).
**Consumed by:** `c20` (CI/CD — the cross-tenant isolation test needs real tables to test against), `c21` (core API service scaffold — the first commit that actually runs this schema as a migration), `c24` (admin console), `c3` (conflict-check engine), `c5` (PM-tool integration layer).

## 0. What this card is, and isn't

This is item 9 in `CLAUDE.md`'s dependency order — the last design card before code. ADR-0001 §D2 already named the module layout (`flow/`, `tenancy/`, `integrations/`, `llm/`, `scheduler/`, `audit/`) and §D6 already fixed the shape of four of the tables below. What was still open going into this card: the *rest* of the schema (firms, users, matters, parties, conflict-check results, documents), how those fit *together* with the four workflow tables, and three specific decisions the prior docs deliberately deferred here — config versioning (flagged by `c6`'s audit-log doc §2), the RBAC taxonomy becoming real columns and constraints (flagged by `c9` §4.1), and where PII/sensitivity classification lives on a schema built for a shared, RLS-isolated database (flagged by `c9` §3.2 and §6.1).

Per ADR-0001 §D4 ("migrations are reviewed as generated SQL, never as ORM diffs") and `CLAUDE.md`'s "`src/` stays empty until [...] the first real commit into `src/`" (that commit is `c21`, item 11 — not this card, item 9), the SQL below is **illustrative DDL for review**, written the way a real migration would read, but it is not a committed migration file and nothing in `src/` or a `migrations/` directory changes as part of this PR. `c21` is where this design becomes an actual, runnable first migration.

## 1. Table inventory

| Table | Tenant-scoped? | New in this doc / fixed by prior doc |
|---|---|---|
| `firms` | — (this *is* the tenant) | New |
| `firm_config_versions` | Yes | New — resolves `c6`'s open config-versioning question |
| `users` | Yes | New |
| `parties` | Yes | New |
| `matters` | Yes | New |
| `matter_parties` | Yes | New |
| `conflict_check_results` | Yes | New |
| `documents` | Yes | New |
| `intake_sessions` | Yes | Shape fixed by ADR-0001 §D6; columns detailed here |
| `intake_events` | Yes | Shape fixed by ADR-0001 §D6 and `c6`; columns detailed here |
| `scheduled_tasks` | Yes | Shape fixed by ADR-0001 §D6; columns detailed here |
| `outbox` | Yes | Shape fixed by ADR-0001 §D6; columns detailed here |

Every tenant-scoped table below carries the same four conventions, stated once here rather than repeated twelve times:

1. `tenant_id uuid NOT NULL REFERENCES firms(id)` — no exceptions, no nullable tenant columns anywhere, per `c8` §4.1 and ADR-0001 §D5.
2. Row-Level Security enabled, with a policy of the shape `USING (tenant_id = current_setting('app.tenant_id')::uuid)`, applied for `SELECT`, `INSERT`, `UPDATE`, `DELETE` — set inside `withTenant()`'s `SET LOCAL app.tenant_id` per ADR-0001 §D5. This document does not repeat the `withTenant()` mechanics; it assumes them and only adds the RLS policy text per table where it deviates from the default (`intake_events`, below, is the one table where it deviates).
3. `id uuid PRIMARY KEY DEFAULT gen_random_uuid()`, `created_at timestamptz NOT NULL DEFAULT now()`. Mutable tables also get `updated_at timestamptz NOT NULL DEFAULT now()` maintained by a trigger, not application code — per ADR-0001's "prefer mistakes that are loud" principle, a missed `updated_at` write in application code should not be possible to forget.
4. The application's runtime database role holds no `BYPASSRLS` and is not a superuser, per ADR-0001 §D5 point 3 and `c8` §4.1 — restated here because it is a property of the role, not of any individual table, and every table in this document depends on it holding.

## 2. Firms & configuration

### 2.1 `firms`

The tenant root. Not itself tenant-scoped (there is nothing above it to scope against).

```sql
CREATE TABLE firms (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text NOT NULL,
  slug              text NOT NULL UNIQUE,
  status            text NOT NULL DEFAULT 'trial'
                      CHECK (status IN ('trial', 'active', 'suspended', 'offboarded')),
  is_production     boolean NOT NULL DEFAULT false,
  data_region       text NOT NULL DEFAULT 'us',
  created_at        timestamptz NOT NULL DEFAULT now()
);
```

`is_production` is ADR-0001 §D9's production-data gate made structural: "production tenant creation is disabled behind a flag until [compliance gates] are signed off, and the demo runs on synthetic data only." Concretely, this column defaults to `false`; flipping a firm to `true` is a deliberate, logged action (an `intake_events`-style entry, or — until that plumbing exists for firm-level actions — at minimum a required manual step gated on `c1`/`c2`/`c26`/D9's DPA all being checked off), never a side effect of firm signup. Any code path that writes real client data (as opposed to synthetic demo data) must check this flag first. `data_region` exists now, unused beyond `'us'`, because ADR-0001 §D7 already anticipates data-residency questions from security-conscious firms and this is the cheapest possible place to leave room for that answer later without a migration.

### 2.2 `firm_config_versions`

`c6`'s audit-log doc (§2) identified a real gap in ADR-0001 §D6 as written: `intake_events` records *which rule fired*, not *what values that rule evaluated against*, and `firm-config` (the parameters file described in `docs/product/spec/firm-config.example.yaml`) is mutable. A decision made under last year's jurisdiction list or conflict role-matrix has to stay interpretable under *that* configuration, not today's. The audit-log doc flagged two options — snapshot the config fragment into each event, or version `firm-config` itself — and deferred the choice to this card.

**Decision: version `firm-config` itself**, for two reasons beyond the audit-log doc's own preference. First, `c14` (configurable pipeline stages per firm) and the board's own column-relabeling pattern establish that firm-level configuration changing over time, and needing history, is already a product expectation here, not a one-off. Second, snapshotting the fragment into every event duplicates the same JSON blob into potentially thousands of `intake_events` rows per firm per config epoch, which is worse for storage and *also* worse for auditability — a reviewer asking "what changed in this firm's conflict rules on this date" has to diff blobs scattered across event rows instead of reading one version history.

```sql
CREATE TABLE firm_config_versions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES firms(id),
  version           integer NOT NULL,
  config            jsonb NOT NULL,      -- validated against the firm-config schema before insert
  effective_from    timestamptz NOT NULL DEFAULT now(),
  created_by        uuid REFERENCES users(id),  -- null for the initial, system-seeded version
  UNIQUE (tenant_id, version)
);

CREATE INDEX ON firm_config_versions (tenant_id, effective_from DESC);
```

`config` stores the full parsed `firm-config.yaml` document (practice areas offered, jurisdiction table, role matrix, cadences, and so on) as JSONB rather than as normalized columns. This is a deliberate rejection of one alternative — a fully normalized `firm_practice_areas`, `firm_jurisdiction_rules`, `firm_conflict_role_matrix`, etc., table set — because `docs/product/spec/README.md`'s own split ("intake-flow.yaml is the shape of the process; firm-config is the parameters") already treats the config as one versioned document, `validate_spec.py` already validates it as a document, and a JSONB column lets that validation logic keep living in one place (the spec's own validator) instead of being re-derived as a set of foreign-key constraints that would need to change every time a firm-config field is added. The cost — you cannot write a plain SQL `WHERE` clause against, say, `residency_period_months` without a JSONB path expression — is judged acceptable because nothing in this schema needs to query *across* firms by a config value; every read of `config` is already scoped to one firm's current or historical version.

Every `intake_sessions` row (§4) and every write from the flow engine records which `firm_config_versions.id` was in effect, so "what did the rule actually see" (the audit-log doc's own phrasing) is always answerable by a join, not a blob diff.

## 3. Users & access control

`c9` §4.1 proposed a starting RBAC taxonomy (Firm Admin, Attorney, Intake Staff, Read-only/Reporting, API/Integration service account) and was explicit that "`c19` is where these roles become real enforceable entities." This section does that, while keeping `c9`'s own caveat: the *shape* (least-privilege, role-scoped, firm-configurable labels) is the requirement; the literal five names are a starting default a firm can relabel, matching the `c14` pattern already established for pipeline-stage labels.

```sql
CREATE TYPE user_role AS ENUM (
  'firm_admin',
  'attorney',
  'intake_staff',
  'read_only',
  'integration_service'
);

CREATE TABLE users (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES firms(id),
  email             citext NOT NULL,
  display_name      text NOT NULL,
  role              user_role NOT NULL,
  role_label        text,                 -- firm-facing override of the default role name, per c14's pattern
  mfa_enrolled      boolean NOT NULL DEFAULT false,
  status            text NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'invited', 'disabled')),
  restricted_to_unassigned_matters boolean NOT NULL DEFAULT false,
                      -- c9 §4.1: lets a firm scope intake_staff to matters not yet
                      -- assigned to a specific attorney, rather than full matter visibility
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)
);
```

`mfa_enrolled` exists because `c9` §4.2 requires MFA for every account with write access to matter data, not as an optional feature — this column is what a login-flow check and an admin-console warning banner both read from; the actual MFA challenge itself is an identity-provider concern (ADR-0001 §D8, a managed auth provider), not something this table implements.

`restricted_to_unassigned_matters` is deliberately a single boolean rather than a general permissions table for this first migration. `c9` flagged the *need* for the distinction (staff triage without full matter visibility) but not a specific mechanism, and a general row-level permission-grant table is real additional complexity this schema does not need until a firm actually asks for something more granular than "staff sees unassigned intake, attorneys see everything assigned to them." If that need materializes, this becomes a `matter_access_grants` join table without disturbing anything else here — flagged in §8 as a revisit trigger, not built preemptively.

**Internal (platform) staff access is deliberately not a row in this table.** `c9` §4.1 point 3 requires no standing per-tenant access for internal staff — modeling that as a `users` row with a special role would make "standing access" the default shape of the data model itself. Break-glass access is instead a time-boxed grant recorded as its own audit event type in `intake_events` (§5.2) at the moment it's exercised, with the underlying authentication handled entirely outside this per-tenant table (an internal admin tool authenticated against the platform's own identity provider, not a `users` row in any firm's tenant). This keeps the invariant "everything in `users` is scoped to exactly one firm" absolute, with no carve-out to remember.

## 4. Matters, parties, and conflict-check data

### 4.1 `parties`

The conflict-check engine (`c3`) has to check a caller *and* an opposing party against "client records, matter records, and prior-consultation records" — which means the schema needs one durable identity per person a firm has ever had contact with, not just a name field duplicated onto whichever matter they showed up in. This table is that identity.

```sql
CREATE TABLE parties (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES firms(id),
  full_name         text NOT NULL,
  normalized_name   text NOT NULL,   -- lower-cased, whitespace-collapsed, for matching
  date_of_birth     date,            -- nullable; used as a secondary conflict-match signal when known
  email             citext,
  phone             text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON parties (tenant_id, normalized_name);
```

`normalized_name` plus a trigram index (`pg_trgm`) is the recommended starting matcher for name-based conflict lookups — exact-match-only conflict checking would miss "Bob Smith" against "Robert Smith," which is exactly the kind of miss that turns into a real professional-responsibility problem. This document does not specify a full fuzzy-matching or identity-resolution pipeline (aliases, maiden names, common misspellings) — that is a `c3` implementation decision, flagged here only so `c3`'s author knows `normalized_name` is a matching aid, not a claim that two rows with different `normalized_name` values are definitely different people. Two `parties` rows are never merged or deleted automatically; a firm noticing "Bob Smith" and "Robert Smith" are the same person is a manual, audited action, because silently merging conflict-check identities is itself a way to create a false negative on a future conflict.

### 4.2 `matters`

```sql
CREATE TYPE matter_stage AS ENUM (
  'prospective', 'consultation_scheduled', 'consult_completed_manual_follow_up',
  'pending_review', 'did_not_schedule', 'did_not_hire_referred_out',
  'declined_conflict', 'retained', 'closed'
);

CREATE TABLE matters (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES firms(id),
  primary_party_id  uuid NOT NULL REFERENCES parties(id),
  practice_area     text,             -- validated against firm_config_versions.config at write time, not a DB enum,
                                       -- because the set of practice areas is firm-configurable (firm-config.example.yaml)
  stage             matter_stage NOT NULL DEFAULT 'prospective',
  assigned_user_id  uuid REFERENCES users(id),
  retention_years   integer,          -- firm-level default from firm_config if null; c2/c6 §4 floor
  opened_at         timestamptz NOT NULL DEFAULT now(),
  closed_at         timestamptz,
  eligible_for_deletion_at timestamptz GENERATED ALWAYS AS (
                      CASE WHEN closed_at IS NOT NULL AND retention_years IS NOT NULL
                           THEN closed_at + (retention_years || ' years')::interval
                           ELSE NULL END
                    ) STORED
);

CREATE INDEX ON matters (tenant_id, stage);
CREATE INDEX ON matters (tenant_id, eligible_for_deletion_at) WHERE eligible_for_deletion_at IS NOT NULL;
```

`practice_area` is deliberately `text`, not a Postgres `ENUM`, because `firm-config.example.yaml`'s `practice_areas.offered` list is per-firm and the reference example itself shows a firm offering a *subset* of areas the flow spec knows about, plus referring others out — a fixed database enum would need a migration every time any firm added a practice area. Validation that a given `practice_area` value is one the flow spec (`intake-flow.yaml`) actually knows how to route happens at the application layer against `firm_config_versions.config`, consistent with how `validate_spec.py` already validates the YAML files rather than the database doing it.

`eligible_for_deletion_at` operationalizes `c6`'s audit-log doc §4 recommendation directly: "audit events for a matter should never be eligible for deletion before the matter's own retention period expires... tied to the *matter's* retention setting... rather than two independently-tunable settings." Computing it as a generated column means there is exactly one place this logic lives, and `intake_events` retention (§5.2) reads the same computed value rather than maintaining its own. `retention_years` defaulting to null and falling back to the firm's config-level default (rather than every matter needing an explicit value) keeps the common case simple while leaving room for a firm to set a longer retention on a specific matter — e.g., one they know is heading toward litigation.

### 4.3 `matter_parties`

A matter can involve more than one party in more than one role (the caller, an opposing party, sometimes a co-party), and the same `parties` row can appear across many matters over the firm's history — which is the entire point of §4.1.

```sql
CREATE TYPE party_role AS ENUM ('caller', 'opposing_party', 'co_party');

CREATE TABLE matter_parties (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES firms(id),
  matter_id         uuid NOT NULL REFERENCES matters(id),
  party_id          uuid NOT NULL REFERENCES parties(id),
  role              party_role NOT NULL,
  UNIQUE (matter_id, party_id, role)
);
```

### 4.4 `conflict_check_results`

`c3`'s card note and `intake-flow.yaml`'s `conflict_rules` are explicit that the outcome is tri-state (`clear` / `possible` / `definite`), not boolean, and role-sensitive — the same prior contact can be harmless for representation but disqualifying for mediation (`firm-config.example.yaml`'s `role_matrix`). This table is the record of one such evaluation, not the conflict-detection logic itself (that logic is `c3`'s own card, still in `backlog`).

```sql
CREATE TYPE conflict_outcome AS ENUM ('clear', 'possible', 'definite');

CREATE TABLE conflict_check_results (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES firms(id),
  intake_session_id uuid NOT NULL REFERENCES intake_sessions(id),
  role_sought       text NOT NULL,      -- e.g. 'representation', 'mediation' — matches role_matrix keys
  outcome           conflict_outcome NOT NULL,
  matched_party_ids uuid[] NOT NULL DEFAULT '{}',
  matched_sources   jsonb NOT NULL,     -- which of clients/matters/prior_consultations matched, and why
  firm_config_version_id uuid NOT NULL REFERENCES firm_config_versions(id),
  resolved_by_user_id uuid REFERENCES users(id),  -- set when a `possible` outcome is resolved by an attorney
  resolved_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);
```

Per `c8` §4.1, conflict-check lookups are **per-firm only** — `matched_party_ids` and `matched_sources` never reach across `tenant_id` boundaries, consistent with "there is no product requirement today for cross-firm conflict data sharing" and the explicit statement that cross-tenant conflict lookups are out of scope absent a future card with its own privilege analysis. A `definite` or `possible` outcome is itself an `intake_events` row (§5.2) — this table is queryable state for the current session; the event log is the immutable record that it happened.

## 5. Intake / workflow tables

This section is ADR-0001 §D6 and `c6`'s audit-log doc made concrete as columns. Nothing in this section relitigates the decision to use four Postgres tables driven by a scheduled worker — that decision is made, and this document's job is only to specify the columns those four tables need to actually run `intake-flow.yaml` and satisfy `c6`'s completeness bar.

### 5.1 `intake_sessions`

```sql
CREATE TABLE intake_sessions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES firms(id),
  matter_id         uuid REFERENCES matters(id),   -- null until capture_contact resolves an identity
  current_node      text NOT NULL DEFAULT 'classify_caller',  -- a node id from intake-flow.yaml
  terminal_state    text,                            -- a terminal id from intake-flow.yaml, null while in flight
  language          text NOT NULL DEFAULT 'en',
  channel           text,                            -- phone / video / in_person / web-chat
  collected_answers jsonb NOT NULL DEFAULT '{}',
  firm_config_version_id uuid NOT NULL REFERENCES firm_config_versions(id),
  classifier_output jsonb,                           -- c13's ClassifyOutput, when the classifier ran
  started_at        timestamptz NOT NULL DEFAULT now(),
  completed_at      timestamptz
);

CREATE INDEX ON intake_sessions (tenant_id, terminal_state) WHERE terminal_state IS NULL;  -- "in flight" queue
```

`collected_answers` is JSONB, not one column per `question-bank.yaml` field, for the same reason `firm_config_versions.config` is JSONB (§2.2): `intake-flow.yaml` defines dozens of fields gated behind `conditional_fields` and firm-specific `practice_areas.offered`, and a fully normalized answer table (one row per field per session, or one column per field on this table) would need a schema migration every time a question is added to the bank, which defeats the entire point of `question-bank.yaml` being a spec a non-engineer-reviewable YAML file rather than application code. The specific fields that matter for *querying* — `practice_area`, `stage` — already live as real columns on `matters`, not buried in this JSONB blob, so the common admin-console and reporting queries (`c24`) do not need JSONB path expressions.

`classifier_output` stores `c13`'s `ClassifyOutput` verbatim (practice-area label + confidence, out-of-scope signal, queue-priority tier, `safetyFlag`) at the point the classifier ran, for the same reason `firm_config_version_id` is captured here rather than only resolved at query time — see §5.2's completeness requirement.

### 5.2 `intake_events`

The audit trail. `c6`'s doc (§2) specifies exactly what must be captured; this is that specification as columns.

```sql
CREATE TABLE intake_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES firms(id),
  intake_session_id uuid NOT NULL REFERENCES intake_sessions(id),
  matter_id         uuid REFERENCES matters(id),
  event_type        text NOT NULL,     -- e.g. 'node_transition', 'gate_evaluated', 'classifier_ran',
                                        -- 'conflict_check_resolved', 'escalation_opened', 'safety_flag_fired',
                                        -- 'break_glass_access', 'config_version_read'
  rule_name         text,              -- which intake-flow.yaml rule fired, when applicable
  actor_type        text NOT NULL CHECK (actor_type IN ('system', 'user', 'caller')),
  actor_id          uuid,              -- users.id when actor_type = 'user'; null for 'system'/'caller'
  payload           jsonb NOT NULL,
  firm_config_version_id uuid REFERENCES firm_config_versions(id),
  occurred_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON intake_events (tenant_id, intake_session_id, occurred_at);
CREATE INDEX ON intake_events (tenant_id, matter_id, occurred_at) WHERE matter_id IS NOT NULL;
```

**Immutability, per `c6` §3's recommendation in order of cost:**

```sql
-- 1. The application role gets INSERT and SELECT only. No UPDATE, no DELETE.
REVOKE UPDATE, DELETE ON intake_events FROM app_runtime_role;
GRANT INSERT, SELECT ON intake_events TO app_runtime_role;

-- 2. RLS still applies to SELECT/INSERT for tenant scoping, same pattern as every other table:
ALTER TABLE intake_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON intake_events
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
-- (no UPDATE/DELETE policy is defined at all, since the role has no such privilege regardless)
```

Item 2 from `c6`'s recommendation — a required CI check that attempts an `UPDATE`/`DELETE` with the application role and asserts it fails — belongs to `c20` (CI/CD), not this document; it is listed in §7 as a direct hand-off. Item 3, hash-chaining, remains a should-have per `c6`'s own recommendation and is not included in this schema; if it is adopted later, it is an additive `previous_event_hash` / `event_hash` column pair on this table and does not require redesigning anything else here.

`event_type` is `text` rather than a Postgres `ENUM` deliberately, unlike `matter_stage` or `conflict_outcome` above — the set of event types is expected to grow as new flow nodes and escalation types are added (`c3`'s conflict engine and `c13`'s classifier both already imply event types this document lists above), and unlike `practice_area`, there is no firm-configurability angle that would otherwise argue for `text`; an `ENUM` would just mean a migration for every new event type, which "loud mistakes over elegant design" (ADR-0001's own framing) does not actually buy anything here — an unrecognized `event_type` string is caught by an application-layer validation test, same as a `c20` CI check, not by the database.

### 5.3 `scheduled_tasks`

```sql
CREATE TABLE scheduled_tasks (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES firms(id),
  intake_session_id uuid REFERENCES intake_sessions(id),
  matter_id         uuid REFERENCES matters(id),
  task_type         text NOT NULL,   -- 'payment_reminder', 'cadence_step', 'internal_sla', 'conflict_review_sla', ...
  due_at            timestamptz NOT NULL,
  claimed_at        timestamptz,
  claimed_by_worker text,
  completed_at      timestamptz,
  cancelled_at      timestamptz,     -- set when manual_override.suppresses_automation fires (intake-flow.yaml)
  payload           jsonb NOT NULL DEFAULT '{}'
);

CREATE INDEX ON scheduled_tasks (due_at) WHERE claimed_at IS NULL AND cancelled_at IS NULL;
```

The worker's claim query (ADR-0001 §D6: `SELECT ... FOR UPDATE SKIP LOCKED`) reads:

```sql
SELECT * FROM scheduled_tasks
WHERE due_at <= now() AND claimed_at IS NULL AND cancelled_at IS NULL
ORDER BY due_at
FOR UPDATE SKIP LOCKED
LIMIT 100;
```

`cancelled_at` exists specifically for `intake-flow.yaml`'s `manual_override.suppresses_automation` rule: "when a human takes ownership... the record leaves automation entirely. The engine must never keep chasing someone a person has picked up." Cancelling, not deleting, keeps the row (and the fact that automation was suppressed, and by implication when and — via a paired `intake_events` row — by whom) in the historical record rather than erasing it.

### 5.4 `outbox`

```sql
CREATE TABLE outbox (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES firms(id),
  matter_id         uuid REFERENCES matters(id),
  destination       text NOT NULL,     -- 'intake_crm', 'client_portal', 'scheduling', per firm-config.example.yaml's `systems`
  operation         text NOT NULL,     -- e.g. 'write_matter_stage', 'write_appointment'
  payload           jsonb NOT NULL,
  status            text NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'sent', 'failed', 'abandoned')),
  attempts          integer NOT NULL DEFAULT 0,
  last_error        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  sent_at           timestamptz
);

CREATE INDEX ON outbox (status, created_at) WHERE status IN ('pending', 'failed');
```

This is what makes `intake-flow.yaml`'s `handoff` node's ordering requirement — "the record is written BEFORE the appointment is treated as booked" — a transactional guarantee rather than a hopeful sequence of API calls, per ADR-0001 §D6: the `outbox` row is written in the *same transaction* as the `matters`/`intake_sessions` state change, and only the worker's later, separate delivery step actually calls out to the destination system. `destination` values map onto `firm-config.example.yaml`'s `systems` block (`intake_crm`, `client_portal`, `scheduling`, `overflow_reception`), which is `c5`'s integration layer — this table is the durable queue `c5` drains, not `c5`'s implementation.

## 6. Documents

```sql
CREATE TYPE sensitivity_tier AS ENUM ('standard', 'sensitive');

CREATE TABLE documents (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES firms(id),
  matter_id         uuid NOT NULL REFERENCES matters(id),
  document_type     text NOT NULL,      -- 'engagement_letter', 'intake_transcript', 'uploaded_by_caller', ...
  storage_key       text NOT NULL,      -- object-storage reference; the file itself never lives in Postgres
  sensitivity_tier  sensitivity_tier NOT NULL DEFAULT 'standard',
  uploaded_by_user_id uuid REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now()
);
```

`sensitivity_tier` is the schema's hook for `c9` §3.2's field/record-level encryption question — "which specific fields... justify the added complexity of application-layer encryption, versus relying on strong storage-level encryption alone" was explicitly left as an open question for a joint call between `c9` and this card. This document does not resolve that call; it adds the one column needed so that whichever fields `question-bank.yaml` eventually flags as health/immigration/minors-related (per `c9`'s own phrasing) can drive a `sensitive` tag on a document without a later migration, and so `c24`'s admin console has something to key a "handle with extra care" UI treatment off of. `documents` deliberately does not store file bytes — object storage (keyed by `storage_key`) holds those, consistent with `CLAUDE.md`'s note that "the connector cannot push binary files" applying equally to how this product should treat documents in general: Postgres holds metadata and the workflow state that references documents, not the documents themselves.

## 7. What this changes / hands off to other cards

- **`c21` (core API service scaffold):** this document *is* the first migration's content, in illustrative form. `c21`'s actual first commit turns §2–§6's `CREATE TABLE` statements into a real, versioned migration file, adds the RLS policies for every table (this document specifies the pattern once in §1 and the one exception in §5.2, rather than writing out eleven near-identical `CREATE POLICY` statements), and wires `withTenant()` against it.
- **`c20` (CI/CD):** the cross-tenant isolation test ADR-0001 §D5 requires as a required check needs real tables to seed two tenants into — this schema is what that test runs against. The `intake_events` immutability test from `c6` §3 point 2 also needs this schema's grants (§5.2) to exist first.
- **`c3` (conflict-check engine):** `parties`, `matter_parties`, and `conflict_check_results` (§4) are the tables `c3`'s implementation reads and writes; the matching logic itself (name normalization beyond `normalized_name`, the actual role-matrix evaluation) remains `c3`'s own card.
- **`c24` (admin/staff console):** reads `users.role`/`role_label` for permission-gated UI, `matters`/`intake_sessions` for the working queue, and is the eventual home for `c6`'s "reconstructed timeline" presentation requirement over `intake_events`.
- **`c5` (PM-tool integration layer):** drains `outbox`, keyed by `destination` values matching `firm-config.example.yaml`'s `systems` block.
- **`c9` (encryption & access control):** `sensitivity_tier` on `documents` is this schema's placeholder for `c9`'s still-open field-level-encryption question; `users.role` is this schema's realization of `c9`'s RBAC taxonomy.

## 8. Explicitly not decided here, and revisit triggers

1. **Field-level (application-layer) encryption** for specific `collected_answers` keys or `documents` rows tagged `sensitive` — `c9` §3.2 and §7.1 left this open pending a joint call with this card; this document adds the `sensitivity_tier` hook (§6) but does not pick an encryption mechanism or key strategy.
2. **A general per-matter permission-grant table**, beyond the single `restricted_to_unassigned_matters` boolean on `users` (§3) — revisit if a firm asks for finer-grained matter-level access than "assigned vs. unassigned."
3. **Hash-chaining `intake_events`** (`c6` §3 point 3) — not included; additive if adopted later, per §5.2.
4. **Party identity resolution beyond exact/trigram name matching** (§4.1) — flagged for `c3`'s own design, not resolved here; a real false-negative risk if left at simple string matching indefinitely, per `c8` §1's framing of why this product's isolation and matching bar is higher than typical SaaS.
5. **Per-tenant database silo migration mechanics** — `c8` §3 and ADR-0001 §D5 both require the *option* to move a firm to a dedicated database later without a rewrite. This schema satisfies the precondition (`tenant_id` on every table, no assumptions baked in that couple tables to a shared physical database beyond foreign keys, which are already scoped within `tenant_id`), but the actual mechanics of a silo migration (dump-and-restore vs. logical replication, cutover process) are not designed here and should not be until a firm actually asks for one, per `c8`'s own reasoning against over-engineering ahead of a confirmed customer profile.
6. **This document assumes English-only full-text search needs, if any, are out of scope for this migration** — `parties.normalized_name` and any future free-text search over `intake_sessions.collected_answers` or `documents` are not addressed; add when a concrete search requirement exists rather than speculatively.

## Sources

This is a schema design synthesizing decisions already made and researched elsewhere in this repository; it does not introduce new external sources. Every structural choice above is traced to one of: ADR-0001 (`docs/architecture/adr/0001-initial-technology-stack.md`, PR #5), the multi-tenant architecture review (`docs/architecture/multi-tenant-architecture-data-isolation.md`, `c8`, PR #4), the encryption & access control review (`docs/security/encryption-access-control-review.md`, `c9`, PR #6), the audit log & compliance trail design (`docs/architecture/audit-log-compliance-trail.md`, `c6`, PR #9), the intake flow specification (`docs/product/spec/intake-flow.yaml` and `firm-config.example.yaml`, `c12`, PR #3), and the LLM triage classifier spec (`docs/product/spec/llm-triage-classifier.md`, `c13`, PR #8).

## Review notes

The two places most worth a second pair of eyes: whether JSONB for `collected_answers` and `firm_config_versions.config` (rather than normalized tables) is the right trade-off long-term, since it optimizes for schema stability as the flow spec grows at the cost of query ergonomics; and whether the `users` role taxonomy in §3, with a single `restricted_to_unassigned_matters` boolean rather than a general permission-grant model, is granular enough for the firms this product actually signs — both are cheap to revisit before `c21` writes the real migration, and expensive to revisit after firms have real data in either shape.

This document, like `c6`, `c8`, and `c9` before it, is engineering design, not a legal opinion; retention and sensitivity-classification points here inherit the same attorney-review requirement already tracked against `c1`/`c2`/`c26`.
