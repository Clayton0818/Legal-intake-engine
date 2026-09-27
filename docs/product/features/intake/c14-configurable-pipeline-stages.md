# c14 · Configurable pipeline stages per firm

**Card:** `c14` Configurable pipeline stages per firm (Product, P1, in progress, engine: Intake)
**Requirement (card note):** Let each firm relabel and reorder stages, the same way this board's columns work today.
**Existing work:** No spec, PR or code for c14 was found on `main` as of 2026-09-26. Today stages are the fixed Postgres enum `matter_stage` and are rendered with hard-coded badge colours in `src/app/admin/_lib/format.ts`. This spec is the design for the in-progress work.

## 1. Summary

Each firm gets its own pipeline: it can rename, reorder, hide optional stages and split a system stage into several firm stages, like moving and renaming columns on a board. Underneath, every firm stage maps to exactly one fixed **system stage** (the existing `matter_stage` values), so gates, reports and the other engines keep working no matter what the firm calls things.

## 2. Users and problem

- **Firm admin / owner:** wants the pipeline to use the firm's own words ("Strategy session booked" instead of "Consultation scheduled") and order.
- **Intake staff and lawyers:** work the pipeline every day in the admin console (c24); stage names that don't match how the firm talks cause mis-filing.
- **Product:** c68 (open matter), c33 (insights), c47 (stall rules), the `crm_field_map` in firm config and c11 (client portal) all depend on stage meaning. If a firm could delete or redefine "retained", those break.

## 3. Scope

**In scope**
- Firm-defined display stages for the intake pipeline (the current `matter_stage` values).
- Relabel, reorder, hide optional stages, add sub-stages that map to one system stage.
- Colour per stage (replacing the hard-coded badge map).
- Optional separate client-facing label per stage.
- Expected duration per stage (consumed by c47).
- Versioning, so a change never rewrites history.

**Out of scope**
- Stages after retention (filed, discovery, mediation, final decree): that is `c95`, which extends this mechanism per practice area.
- Stage-triggered automations (task lists, client updates): c95 / c54.
- Changing the system stages themselves (a schema migration, not a firm setting).

## 4. Behaviour

**Edit the pipeline (firm admin)**
1. Admin opens Settings > Pipeline. The screen shows the firm's stages as columns, in order, each with its label, colour, the system stage it maps to, and whether it is required.
2. Admin drags to reorder, renames, changes colour, or clicks "Add stage" and picks which system stage it belongs to (for example two firm stages "Awaiting documents" and "Awaiting call-back" both mapped to `prospective`).
3. Admin hides an optional stage. If matters are currently in it, the admin must pick a target stage in the same system stage for them to move to; the move is logged per matter.
4. Admin saves. A new `firm_config_versions` row is written; the change applies from `effective_from`. Matters keep their history under the old labels in the audit trail.

**Move a matter (staff)**
1. Staff drags a matter card to another firm stage, or the system moves it (e.g. booking moves it to the firm stage mapped to `consultation_scheduled`).
2. The move is validated against system-stage rules (see Business rules). An invalid move is refused with the reason ("A matter can only reach Retained through the Open matter step, c68").
3. When the system moves a matter into a system stage that has several firm stages, it uses that system stage's **default firm stage**.

**Edge cases and failures**
- Two admins edit at once: the second save is rejected with "pipeline changed since you opened it", showing the newer version.
- A firm stage label duplicates another: refused (labels unique per firm, case-insensitive).
- A label that would reveal confidential status to a client (e.g. client label "Conflict found"): the client-label field warns and requires confirmation; see rule 8.
- Config version missing or corrupt: the console falls back to system stage names (current behaviour) and logs an error; nothing blocks work.

## 5. Business rules

1. Every firm stage maps to exactly one system stage (`matter_stage` value).
2. Every system stage has at least one visible firm stage and exactly one default firm stage.
3. Required system stages cannot be hidden: `prospective`, `consultation_scheduled`, `pending_review`, `declined_conflict`, `retained`, `closed`.
4. Relabel and reorder never change a matter's system stage and never rewrite past `intake_events`.
5. Moves into `retained` happen only through c68; moves into `declined_conflict` only through a c59 decision. Manual drag into those stages is refused.
6. Every stage move writes an `intake_events` row with `event_type = 'stage_changed'`, both system stages and both firm stage keys, the actor and the `firm_config_version_id`.
7. Expected duration per firm stage, counted in business hours (firm setting; defaults proposed: prospective 8 business hours, pending_review 24 business hours matching `review_sla_hours: 24`, others none). Used only by c47.
8. Client-facing label (firm setting; default: hidden). If hidden, the portal (c11) shows a generic status for the system stage (e.g. "We are reviewing your inquiry"). Stages mapped to `pending_review` or `declined_conflict` never show a firm-authored client label that mentions conflicts (c59, Rule 1.05).
9. Maximum 20 firm stages per pipeline (firm-configurable up to that cap) so the board stays usable.
10. Only `firm_admin` can edit the pipeline; everyone else can read it.

## 6. Data model touchpoints

- **Reuse** `matters.stage` (`matter_stage` enum) as the system stage. Unchanged.
- **Reuse** `firm_config_versions.config` for the definition, new key `pipeline.stages[]`: `{ key, label, client_label?, system_stage, order, colour, is_default_for_system_stage, hidden, expected_business_hours? }`.
- **Proposed** column `matters.firm_stage_key text` (nullable; null means the default firm stage of `matters.stage`).
- **Reuse** `intake_events` for stage-change history.
- **Reuse** `crm_field_map` in firm config: it keeps writing system stages, so c5 integrations are unaffected.

## 7. Notifications and visibility

- Staff see firm labels everywhere in the console and c33 insights (insights group by system stage, labelled with the firm's default label).
- Clients see only client labels or the generic status (rule 8). No internal stage, flag or duration ever reaches the client.
- No flags fire from this card directly; c47 uses its expected durations and emails per c51.

## 8. Dependencies

- Needs: c19 (schema, shipped), c24 (admin console, shipped), c34 (real RBAC, so only admins can edit).
- Feeds: c95 (matter-lifecycle stages per practice area), c47 (expected durations), c33 (insights labels), c11 (client statuses), c68 and c67 (system moves use default firm stage).

## 9. Compliance and review flags

- **Attorney review:** the generic client-facing status wording for each system stage, and confirmation that no status reveals conflict information or implies representation before c68 (e.g. "Your case" before retention). Rules 1.05 and 1.18 context.
- No trust money; no CPA review.

## 10. Acceptance criteria

1. Given a firm with the default pipeline, when the admin renames "Consultation scheduled" to "Strategy session booked" and saves, then the console shows the new label on every matter in that stage and `matters.stage` is unchanged.
2. Given two firm stages mapped to `prospective`, when a booking is made for a matter in either, then the matter moves to the default firm stage of `consultation_scheduled` and an `intake_events` row records both keys.
3. Given a staff user drags a matter onto the stage mapped to `retained`, when they drop it, then the move is refused with a message pointing to the Open matter step.
4. Given an optional stage with 3 matters in it, when the admin hides it, then they must choose a target stage in the same system stage, and 3 stage-change events are logged.
5. Given a client logged into the portal whose matter is in `pending_review`, when they view status, then they see the generic status text and never the firm's internal label.
6. Given the admin tries to hide `closed`, when they save, then the save is refused because the stage is required.
7. Given a pipeline change saved on Oct 1, when someone views the audit trail for a matter moved on Sep 20, then the Sep 20 event shows the label that applied on Sep 20.

## 11. Open questions for Clayton

1. Should the client portal show firm-labelled stages at all, or only a fixed set of generic statuses written once and attorney-reviewed (recommended for the pilot)?
2. Is the "required stages" list above right, or do you want firms to be able to hide `consultation_scheduled` (e.g. firms that never do consults)?
