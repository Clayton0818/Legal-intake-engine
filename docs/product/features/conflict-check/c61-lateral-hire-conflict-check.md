# c61 — New hires' prior matters are checked before they start

**Board card:** `c61` — Conflict-check engine · New hires' prior matters are checked before they start
**Priority:** P1
**Status:** Product spec (draft). Docs only; no code. Compliance-sensitive sections are research and a recommended approach, flagged for licensed Texas attorney review.
**Existing spec on main:** none for this card.

---

## 1. Summary

When a lawyer or staff member joins from another firm, they enter a short list of their prior clients and matters (names and general subject only). The list is checked against the party index (`c56`) before their start date, and every hit goes to the conflicts attorney (`c59`), who decides on screens (`c60`) or restrictions. The list is kept, access-restricted, so future intakes are also checked against it.

## 2. Users and problem

**Users**
- **Incoming hire** (lawyer, paralegal, legal assistant, intake staff): enters their prior-matter list through a restricted form before day one.
- **Conflicts attorney:** reviews hits and decides.
- **Firm owner/admin:** starts the onboarding, sees whether the check is complete, cannot see the list unless they hold the conflicts role.

**Problem.** Rule 1.10 (adopted in Texas eff. Oct 1, 2024, with screening provisions) means a lateral's prior work can be imputed to the whole firm. Firms often find out only after the person has started and already touched a matter. The check has to happen before the start date, on as little information as possible, so the new firm does not learn the former firm's confidential information in the process.

## 3. Scope

**In scope**
- Pre-start onboarding record for a new hire, created by firm owner/admin with a start date.
- Secure form for the hire to enter prior clients, adverse parties and a general subject per matter (e.g. "divorce", "commercial lease dispute"), plus their former firm(s) and dates.
- Check of every entry against the party index (`c56`) and current open matters, using `c57` matching, via the `c58` "lateral joins" trigger.
- Results to the conflicts attorney as `c59` decision tasks.
- Blocking account activation (or restricting matter access) until the check is decided.
- Keeping the list, access-restricted, and including it in future checks.

**Out of scope**
- Screen enforcement (`c60`).
- HR onboarding, background checks, payroll.
- Pulling data from the former firm's systems.
- Staff who were never at another firm (they skip this flow; admin confirms "no prior legal employment").

## 4. Behaviour

### 4.1 Start onboarding
1. Firm admin creates the user in `invited` status (`users.status` already supports `invited`) with role and start date.
2. The system creates a lateral check task, due a firm-set number of business days before the start date (default 5), and sends the hire a secure link to the prior-matter form.
3. The hire's account cannot access any matter until the check is complete (business rule 3).

### 4.2 The hire enters their list
1. The form asks, per prior matter: client name(s), adverse party name(s), general subject (short picklist + short text), their role (lawyer / staff), approximate dates, whether the matter is still open at the former firm if known.
2. The form shows a clear instruction not to enter confidential details, facts, strategy or amounts. Free-text fields are length-limited (default 80 characters) and the AI screens entries for detail beyond names and a general subject, asking the hire to shorten them. It never stores the rejected text.
3. The hire confirms the list is complete to the best of their knowledge (attestation, timestamped).
4. Large lists: CSV upload with the same columns is allowed; same validation.

### 4.3 The check
1. Each name is matched against the party index and current open matters, and the adverse parties too.
2. Hits create `conflict_check_results` rows with trigger `lateral_hire` and go to the conflicts attorney as `c59` decision tasks.
3. Possible decisions per hit: cleared; screen the hire from the affected matter(s) (`c60`, which also creates the written-notice task to the affected client); the hire may not work on the matter and the firm must assess whether it can keep the matter (escalated to firm owner); or proceed with client consent (`c59` waiver flow).
4. When all hits are decided and any required screens are active, the check is marked complete and the account can be activated.

### 4.4 Edge cases
- **Start date arrives before decisions are done:** the hire may be activated only with access to no matters, or with access to a firm-approved list of matters with no hits (firm setting, default: no matter access). Firm owner and conflicts attorney are flagged.
- **Hire does not submit the list:** task goes overdue per `c45`; escalates to firm admin. Activation stays blocked.
- **Hire adds a matter later** ("I forgot one"): they can add items after starting; each addition re-runs the check immediately.
- **Former staff re-joining:** treated as a lateral if they worked elsewhere in between.
- **Hire leaves the firm:** the list is kept (their prior matters can still matter for imputation questions, open question 3) and the account is disabled.

### 4.5 Future intakes
The stored lateral lists are searched on every future check (`c58`). A hit on a lateral list returns at least `possible` and names the lawyer/staff member concerned to the conflicts attorney only.

## 5. Business rules

1. Every new user whose role can access matters must have a lateral check record: either a completed check or an admin attestation of "no prior legal employment".
2. The prior-matter list holds names, general subject, role and dates only. Entries flagged as containing more detail must be shortened before submission.
3. Until the check is complete, the user can access no matters (**firm-configurable** exception list, default empty).
4. Check due date: **firm-configurable**, default 5 business days before start date.
5. Every hit goes to the conflicts attorney; the system never auto-clears a lateral hit.
6. Lists are visible only to the conflicts role and the hire themselves (their own list). Firm owner/admin sees status only (**firm-configurable**, default status only).
7. Lists are kept after the hire leaves, for as long as the firm's conflicts records are kept (`c56` rule 5).
8. Hits against a lateral list in future checks are always at least `possible`.
9. Every submission, edit, attestation, check and decision is logged in `c6`.

## 6. Data model touchpoints

**Reuse:** `users` (`status = invited`, `role`), `conflict_check_results`, `scheduled_tasks`, `intake_events`, `firm_config_versions`.

**Proposed**
- **`lateral_checks`**: `id`, `tenant_id`, `user_id`, `start_date`, `due_at`, `status` (`awaiting_list`, `checking`, `awaiting_decisions`, `complete`, `no_prior_employment`), `attested_at`, `completed_at`.
- **`lateral_prior_matters`**: `id`, `tenant_id`, `lateral_check_id`, `former_firm_name`, `client_names text[]`, `adverse_party_names text[]`, `subject_category`, `subject_note` (short), `role`, `from_year`, `to_year`, `still_open_known boolean`, `added_after_start boolean`, `created_at`. RLS `tenant_isolation` plus a role-based policy limiting reads to the conflicts role and the owning user (`c99`).
- Names in the list are normalised and matched through the same name-variant logic as `c56`/`c57`, but stored in this separate table (not in `parties`) so they are not visible through the normal index.
- `conflict_check_results`: needs nullable `intake_session_id`, plus `trigger = lateral_hire` and `lateral_check_id` (shared change with `c58`/`c59`).

## 7. Notifications and visibility

- **Hire:** secure link email (minimal content) and in-app task; sees only their own list and its status (not other matters' details or hit specifics).
- **Conflicts attorney:** decision tasks and minimal email (`c51`).
- **Firm admin/owner:** status and overdue flags (`c45`), minimal emails, no list contents.
- **Clients:** nothing from this card directly. If a screen is decided, `c60` generates the written-notice task to the affected client; that notice's content is out of scope here.

## 8. Dependencies

**Needs first:** `c56`, `c57`, `c58` (lateral trigger), `c59`, `c60`, `c55` (Rule 1.10 screening analysis), `c34`/`c99` (roles and invited-user activation), `c45`, `c51`.
**Feeds:** `c48` (screened person never auto-assigned), `c63` (log), future checks via `c58`.

## 9. Compliance and review flags (licensed Texas attorney)

1. **How much the hire may disclose.** Confirm that names plus a general subject is the right limit so that disclosure for conflict-checking purposes does not breach the hire's duties to former clients under Rule 1.05 / 1.09, and whether any list items should be withheld entirely (e.g. matters that are not public).
2. **Rule 1.10 screening conditions** as adopted Oct 1, 2024: when a screen cures imputation, what notice to the affected former client is required, and timing. This drives `c60` and the decision options in §4.3.
3. **Nonlawyer staff:** whether and how imputation and screening apply to paralegals and assistants joining from other firms (confirm in `c55`; do not assume the lawyer rule applies unchanged).
4. **Retention of the list** after the hire leaves.
5. **Pre-start activation exceptions** (§4.4): whether any matter access before decisions are done is acceptable.

## 10. Acceptance criteria

1. **Given** an invited lawyer with a start date of 1 November, **when** onboarding starts, **then** a lateral check task is created with a due date 5 business days before 1 November and the lawyer receives the secure form link.
2. **Given** the hire's list contains a name matching a current client's opposing party, **when** the check runs, **then** a `possible` result is created with trigger `lateral_hire` and a decision task goes to the conflicts attorney.
3. **Given** a lateral check not yet complete, **when** the hire logs in on their start date, **then** they can access no matters and the firm admin and conflicts attorney are flagged.
4. **Given** a subject note containing an account number and settlement figure, **when** the hire submits, **then** the form asks them to shorten it and the rejected text is not stored.
5. **Given** a user with the `firm_admin` role but not the conflicts role, **when** they open the hire's lateral check, **then** they see status only, not the list.
6. **Given** a completed lateral list, **when** a new intake six months later names one of the hire's prior clients as an opposing party, **then** the check returns at least `possible` and names the hire to the conflicts attorney only.
7. **Given** the conflicts attorney decides "screen", **when** `c60` confirms the screen is active, **then** the lateral check can complete and the hire is excluded from that matter.
8. **Given** the hire adds a forgotten matter after starting, **when** it is saved, **then** the check re-runs for that entry immediately.

## 11. Open questions for Clayton

1. Default: hire gets no matter access until the check is complete, even on their start date. OK, or allow a firm-approved exception list?
2. Do non-lawyer staff go through the same lateral check (recommended: yes, with the list scope confirmed by the attorney reviewer)?
3. Keep a departed hire's list forever, or for a set number of years after they leave?
4. Should the firm owner/admin see list contents by default, or status only (recommended: status only)?
