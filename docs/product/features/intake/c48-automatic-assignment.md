# c48 · New work is automatically assigned to a lawyer or legal team

**Card:** `c48` Intake engine · New work is automatically assigned to a lawyer or legal team based on cadence, workload and other factors (Product, P1). The first Intake engine tile.

## 1. Summary

Every new matter today lands unassigned. This feature picks a lawyer (or team) in two steps: hard eligibility filters, then a score built from cadence, workload and other factors that the firm weights. Each assignment keeps its score breakdown so anyone in the firm can see why that person was picked, and a supervising attorney or admin can override it at any time.

## 2. Users and problem

- **Firm admin / supervising attorney:** spends time hand-assigning; the admin console (c24) shows "Unassigned" and insights (c33) count matters with no owner.
- **Lawyers:** some get handed several new matters back to back while others are idle.
- **Prospective client:** waits longer when nobody owns the inquiry.

## 3. Scope

**In scope**
- Eligibility filters: practice area (from the confirmed intake classification), language, licensed/active for the county or jurisdiction, not out of office, not screened (c60), not `restricted_to_unassigned_matters`.
- Ranking: cadence, workload, other factors, with firm-set weights.
- Score breakdown stored per assignment; manual override with reason.
- Unassigned queue and stall flag (c47) when no one fits.
- Access grant to the assignee under firm roles (c9, c34).

**Out of scope**
- Deciding whether the firm represents the client (c68, attorney decision).
- Resolving conflicts (c59).
- Scheduling the consult slot itself (c67 uses this card's ranking).
- Staff (non-lawyer) task assignment beyond intake ownership.

## 4. Behaviour

**When assignment runs**
1. Trigger: the conflict check result for the inquiry is `clear` (c3), or a conflicts attorney records a clearing decision (c59). A `possible` result goes to the conflicts attorney, never into normal routing. `definite` never routes.
2. Trigger (re-run): a lawyer's assignment is removed (leave, reassignment request), or a matter is opened (c68) and needs a team.

**Step 1: eligibility (all must pass)**
1. Practice area and sub-type from the confirmed classification (c13/c35) is in the lawyer's practice areas.
2. Language: if the intake language is not English, the lawyer (or team) speaks it. Uses the existing `languages.staff_by_language` config (e.g. `es: [spanish_speaking_team]`).
3. Jurisdiction: lawyer is active for the matter's county/court (firm-maintained list per lawyer).
4. Not out of office for the assignment window (proposed default: next 3 business days).
5. Not screened from the matter or any of its parties (c60), and `users.restricted_to_unassigned_matters` is false.
6. `users.status = 'active'` and role is `attorney` (or a team containing one).

**Step 2: ranking among eligible**
- **Cadence:** business hours since the lawyer's last new assignment (more is better); hard cap on new matters per rolling 7 days (over the cap = not eligible this round).
- **Workload:** open matters weighted by complexity (firm weight per matter type, default 1.0), open and overdue tasks (c45), and deadlines in the next N business days (c44 / calendar, default N = 3). Less is better.
- **Other factors:** client continuity (existing or former client goes back to their lawyer if eligible), seniority fit for the matter type (firm table), firm-defined priorities (e.g. "route high-value custody matters to partners").
- Each factor is normalised to 0-100 across the eligible set, multiplied by the firm weight, summed. Highest total wins.
- Tie-break: longest time since last assignment, then lowest open-matter count, then user id order (deterministic, so re-running gives the same result).

**Result**
1. Winner assigned: `matters.assigned_user_id` set, a `matter_assignments` row stores the full breakdown, an `intake_events` row with `rule_name = 'assignment.v<config version>'`.
2. The assignee is notified in-app and by email (c51, internal).
3. Nobody eligible, or everyone eligible is over cap: matter goes to the unassigned queue; firm owner/admin flagged via the stall rule (c47), which emails per c51.

**Override**
1. Supervising attorney or admin picks a different person from the eligible list (or, with a warning, someone outside it, except screened or restricted users, who can never be picked).
2. A reason is required; the original breakdown is kept alongside the override.

**Edge cases**
- Lawyer goes out of office after assignment: no automatic reassignment; a flag goes to the admin to decide (avoids churn).
- Continuity lawyer is ineligible (e.g. screened): continuity factor is ignored, and the breakdown says why.
- Classification changes after assignment (triage corrected): assignment is re-checked; if the assignee is no longer eligible, admin is flagged, nothing moves automatically.
- A new party added later creates a screen (c60) against the assignee: access is removed immediately per c60 and the matter returns to the queue with a flag.

## 5. Business rules

1. Assignment never runs before a clear conflict result or an attorney clearing decision.
2. Screened (c60) or `restricted_to_unassigned_matters` users are never auto-assigned, and cannot be chosen by override.
3. Firm-configurable weights: cadence (default 30), workload (default 50), other factors (default 20). Weights must sum to 100.
4. Firm-configurable cap on new matters per lawyer per rolling 7 days (default: 5; open question).
5. Firm-configurable minimum gap between two new assignments to the same lawyer (default: 2 business hours).
6. Complexity weights per matter type are firm settings (default 1.0; pilot suggestion: contested divorce with children 2.0).
7. Every assignment stores: eligible set, excluded users with reason code, per-factor raw values, normalised scores, weights, total, winner, config version.
8. Being assigned is not acceptance of representation; the matter stage does not change because of assignment.
9. Every assignment and override is logged in the audit trail (c6).
10. Clients never see scores, workload data or the routing reason; they see only their lawyer's name once assigned.

## 6. Data model touchpoints

- **Reuse** `matters.assigned_user_id` (current owner), `users.role`, `users.status`, `users.restricted_to_unassigned_matters`, `intake_sessions.language`, `intake_sessions.classifier_output`, `conflict_check_results.outcome`, `intake_events`, `firm_config_versions.config` (new key `assignment`: weights, caps, complexity table, priorities).
- **Proposed** `matter_assignments` (id, tenant_id, matter_id, assignee_user_id, team_id?, method `auto|override|manual`, score_breakdown jsonb, reason text, assigned_by, firm_config_version_id, created_at, ended_at). Append-only in practice: a reassignment ends the old row and adds a new one.
- **Proposed** `user_profiles` (user_id, practice_areas[], languages[], counties[], seniority, weekly_new_matter_cap override).
- **Proposed** `user_out_of_office` (user_id, starts_at, ends_at).
- **Proposed** `teams`, `team_members` (only if team assignment is in the pilot; see open questions).
- Reads `tasks` (proposed, c45) and calendar deadlines (proposed, c44/c92) for workload.

## 7. Notifications and visibility

- Assignee: in-app + email (c51, internal) "New matter assigned" with a link, no case facts in the email.
- Unassigned queue: flag to owner/admin via c47, emailed per c51.
- Override: previous assignee notified in-app.
- Client: sees their lawyer's name in the portal (c11) once assigned. Never sees routing, scores or workload.

## 8. Dependencies

- Needs: c3/c58 (conflict result), c59 (clearing decision), c60 (screens), c34 (real users and roles), c9 (access control), c6 (audit), c13/c35 (confirmed practice area), c45 and c44 (workload inputs; the score runs with those factors at zero until they exist).
- Feeds: c67 (booking uses eligibility and ranking to pick whose calendar to show), c68 (team at opening), c73 (capacity signal), c33 (fewer unassigned), c53.

## 9. Compliance and review flags

- **Attorney review:** that the eligibility filters correctly enforce screens under Rules 1.10 and 1.18 as implemented by c60 (both adopted eff. Oct 1, 2024, with screening provisions), and that a prospective-client screen blocks assignment as well as access.
- Confirm the product wording makes clear that assignment is not acceptance of representation.
- No trust money; no CPA review.

## 10. Acceptance criteria

1. Given a family-law inquiry with conflict result `possible`, when triage completes, then no assignment is made and the item appears in the conflicts attorney's queue.
2. Given two eligible lawyers where A was assigned a matter 1 business hour ago and B 20 business hours ago, with equal workload, when assignment runs with default weights, then B is assigned and the stored breakdown shows the cadence scores.
3. Given a Spanish-language intake and no Spanish-speaking eligible lawyer, when assignment runs, then the matter goes to the unassigned queue and the firm admin receives an in-app flag and an email.
4. Given a lawyer screened from the matter's opposing party, when assignment runs, then that lawyer is excluded with reason code `screened` and cannot be chosen by override.
5. Given an existing client whose previous lawyer is eligible, when a new matter clears conflicts, then the continuity factor is applied and visible in the breakdown.
6. Given a supervising attorney overrides the assignment, when they save without a reason, then the save is refused; with a reason, both the original breakdown and the override are kept and logged.
7. Given an assigned matter, when the client views the portal, then they see the lawyer's name and nothing about how they were chosen.

## 11. Open questions for Clayton

1. Pilot default for the weekly new-matter cap per lawyer (5 proposed), and whether it should vary by seniority.
2. Individual lawyers only in the pilot, or teams too (needs the proposed `teams` tables)?
3. Should assignment happen at conflict-clear (so c67 books with the assigned lawyer) or only at booking (so the client can pick among eligible lawyers)?
4. Who counts as "firm owner" for the unassigned-queue flag, given `user_role` has no owner value?
