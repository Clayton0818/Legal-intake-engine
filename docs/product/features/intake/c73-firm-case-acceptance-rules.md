# c73 · Each firm sets its own rules for which cases it takes

**Card:** `c73` Intake engine · Each firm sets its own rules for which cases it takes (Product, P1)

## 1. Summary

c13 sorts inquiries by practice area; this card applies each firm's own acceptance rules on top: practice areas and sub-types, counties and courts served, minimum case criteria, languages and current capacity (from c48). Clear no-fit cases get a polite decline and non-engagement notice (same letter as c62) with an optional referral from a list the firm keeps; borderline cases always go to a lawyer. Rules are versioned so every decline traces to the rule that applied.

## 2. Users and problem

- **Firm owner / admin:** wants to stop spending staff time on inquiries the firm never takes.
- **Lawyers:** want borderline cases, not an algorithm, to decide close calls.
- **Prospective client:** deserves a fast, polite "we can't help, here are options" rather than silence.

## 3. Scope

**In scope**
- Firm rule editor for: practice areas and sub-types (on top of the c102 practice-area switches), counties and courts, minimum criteria (firm-defined conditions on intake fields), languages, capacity.
- Three outcomes: `fit`, `borderline`, `no_fit`.
- Auto-decline for clear no-fit only, with the c62 letter and optional referral.
- Versioning and traceability.

**Out of scope**
- Conflicts (c3/c59): a conflict is never a fit rule.
- Referral fee arrangements (Rule 1.04, the firm's attorney decides; the software does not set them up or track them).
- Legal merits assessment of any kind.

## 4. Behaviour

1. After the conflict check runs on minimal info and triage (c13/c35) classifies the matter, fit rules evaluate the classification and captured answers.
2. Each rule returns `pass`, `fail` or `unknown` (missing or low-confidence data). Each rule is marked by the firm as `auto_decline_allowed` or not.
3. Outcome:
   - All pass: `fit`; intake continues.
   - Any fail on a rule with `auto_decline_allowed`, classifier confidence at or above threshold, no `unknown` on that rule, no emergency flag, no possible conflict pending: `no_fit`.
   - Anything else (a fail on a non-auto rule, any unknown that matters, low confidence, capacity shortfall): `borderline`, routed to a lawyer's review queue with the rule results.
4. `no_fit`: the person gets the c62 non-engagement notice (neutral, no merits, no advice, notes time limits may apply and they should consult another lawyer promptly), and, if the firm enabled it, referral options from the firm's list (or the existing `referral_table` fallback). Session ends `not_eligible` or `out_of_scope` (existing terminals); matter stage `did_not_hire_referred_out` when a referral was given.
5. Lawyer on `borderline`: accept (continue), decline (same c62 letter, lawyer-approved), or ask for more info. Decision and reason logged.
6. Emergency detected (c66): the emergency path runs first regardless of fit; the decline, if any, waits until the emergency is handled.

**Rule editing**
1. Admin edits rules in Settings > Case acceptance. Each rule: field, operator, value, `auto_decline_allowed`, human description.
2. A test panel runs the draft rules against the last 50 inquiries (outcomes only, no sending) to show what would change.
3. Save creates a new `firm_config_versions` row. In-flight sessions keep the version they started with (existing `intake_sessions.firm_config_version_id`).

**Edge cases**
- Practice area switched off in c102: treated as a practice-area rule fail with auto-decline allowed (matches c102's polite decline).
- County unknown: `unknown` -> borderline, never auto-decline.
- Capacity (c48 reports no eligible lawyer under cap): borderline by default, never auto-decline (see open question 2).
- A declined person contacts again with different facts: new session, rules re-run; staff see the previous decline via c71.

## 5. Business rules

1. Fit rules never evaluate conflicts and never use legal-merits judgements.
2. Only rules the firm marks `auto_decline_allowed` can produce `no_fit`; default for new rules: not allowed. Pilot defaults allowed for: practice area not offered, county not served (when county is known).
3. Classifier confidence threshold for auto-decline: firm setting, default 0.85; below it, borderline.
4. Capacity alone never auto-declines (default; firm cannot change until open question 2 is decided).
5. Firm setting `auto_decline_enabled` (default: per open question 1). When off, every no-fit becomes a lawyer review.
6. The decline notice is the c62 letter template, attorney-approved, in the person's language; it never says why beyond "the firm is unable to take this matter".
7. Referral list is firm-maintained; each entry has name, practice areas, counties, contact. The software records which referral options were shown, nothing about fees.
8. Every outcome records the `firm_config_version_id` and rule ids that produced it (`intake_events.rule_name`), so any decline can be traced (c6).
9. Declined prospects' names and other parties stay in the party index (c56) per c62; case details minimised per c2.
10. Declined prospects are never followed up (c70).

## 6. Data model touchpoints

- **Reuse** `firm_config_versions.config` (existing keys `practice_areas.offered/referred_out`, `not_served_conditions`, `jurisdiction_by_practice_area`, `residency_period_months`, `languages`, `referral_table`; new key `fit_rules[]`), `intake_sessions.firm_config_version_id`, `intake_sessions.terminal_state`, `intake_sessions.classifier_output`, `intake_events` (`rule_name`, payload with rule results), `matters.stage`.
- **Proposed** `fit_evaluations` (intake_session_id, outcome, rule_results jsonb, confidence, firm_config_version_id, decided_by_user_id?, decision_reason).
- **Proposed** `referral_directory` (tenant_id, name, practice_areas[], counties[], contact, active) or keep inside config.

## 7. Notifications and visibility

- Prospective client: continuation, or the neutral decline notice with optional referral. Never the rule that failed or any internal note.
- Lawyer: borderline review queue item, in-app and email per c51 (internal); if it sits past its expected duration, c47 stall flag.
- Firm admin: decline counts by rule on c33 / c74 lost-lead reasons (aggregates only).

## 8. Dependencies

- Needs: c13/c35 (classification and confidence), c62 (letter), c102 (practice-area switches), c48 (capacity signal), c6, c85 (template), c36 (Spanish letter).
- Feeds: c67 (only fit or accepted cases book), c70 (suppression), c74, c33.

## 9. Compliance and review flags

- **Attorney review:** the decline notice wording (c62), including the time-limits sentence, and that it gives no advice about the merits.
- **Attorney review:** which rule types may auto-decline without a lawyer, given the founder rule that lawyers approve decisions and that a prospective client may have urgent needs.
- **Attorney review:** referral list practices and any referral fee arrangements under Rule 1.04; and the c1 §5 note that multi-firm referral services are separately regulated in Texas (Occupations Code ch. 952, research pending review). The product only displays a firm's own list.
- **Attorney review:** that declined prospects are still prospective clients for Rule 1.18 purposes and their information is handled accordingly.
- No trust money; no CPA review.

## 10. Acceptance criteria

1. Given a firm that does not offer personal injury, when a PI inquiry is classified with confidence 0.95, then it is declined automatically with the c62 notice and the firm's PI referral options.
2. Given the same inquiry classified with confidence 0.6, when rules run, then it goes to a lawyer as borderline.
3. Given a family-law inquiry with county unknown, when rules run, then it is borderline, not declined.
4. Given no eligible lawyer has capacity, when rules run, then the outcome is borderline with reason `capacity`.
5. Given any auto-decline, when the audit trail is viewed, then it shows the rule id, rule text and config version that applied.
6. Given an admin edits rules while a session is in progress, when that session is evaluated, then the version it started with is used.
7. Given a no-fit inquiry that also triggers a safety emergency, when rules run, then the c66 path runs first and no decline is sent until staff release it.
8. Given a declined prospect, when c70 would schedule a follow-up, then none is scheduled.

## 11. Open questions for Clayton

1. Auto-decline on by default for clear no-fit (as the card says), or lawyer approval of every decline during the pilot?
2. Capacity: confirm it never auto-declines, only sends to a lawyer.
3. Should the firm's referral list replace or sit alongside the existing `referral_table` fallback (which ends at the state bar referral service)?
