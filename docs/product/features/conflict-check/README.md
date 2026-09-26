# Conflict-check engine: feature specs

Product specs for the Product-type cards in the Conflict-check engine group of the case-management expansion (`docs/product/case-management-expansion-scope.md`). Docs only, no code. Anything compliance-sensitive is written as research and a recommended approach and is flagged for licensed Texas attorney review (and CPA review where trust money is involved).

Sibling cards in this engine that are **not** specced here (different card types, owned elsewhere): `c3` core check, `c55` Texas rules research, `c57` name matching, `c58` when checks run, `c60` ethical screens, `c96` history import. The specs below reference them by id.

## Index

| Card | Title | Priority | Summary | Depends on |
|---|---|---|---|---|
| [`c56`](c56-party-index.md) | One party index of everyone the firm has ever dealt with | P0 | Per-firm index of every party in any role (incl. declined prospects, related parties, opposing counsel), with name variants and business links; restricted to the conflicts role. | `c8`, `c19`, `c34`/`c99`, `c55`, `c6`; with `c57`, `c96` |
| [`c59`](c59-conflicts-attorney-decision-and-waivers.md) | A conflicts attorney decides every possible conflict, with written waivers where allowed | P0 | Decision queue with deadlines, four logged decision types, waiver signing by every affected client, and one server-enforced gate blocking engagement, assignment, scheduling and trust deposits. | `c55`, `c3`, `c56`, `c57`, `c45`, `c51`, `c85`, `c4`, `c99` |
| [`c61`](c61-lateral-hire-conflict-check.md) | New hires' prior matters are checked before they start | P1 | Hire enters names and general subject only; checked before start date; hits to the conflicts attorney; no matter access until done; list kept for future checks. | `c56`, `c57`, `c58`, `c59`, `c60`, `c55`, `c99` |
| [`c62`](c62-declined-inquiry-closing-letter.md) | Declined and conflicted-out inquiries: neutral closing letter, record kept | P1 | Lawyer-approved neutral non-engagement letter via a DV-safe channel; never mentions a conflict; names stay indexed, narrative follows `c2`. | `c59`, `c3`, `c85`, `c84`, `c51`, `c71`, `c2`, `c56` |
| [`c63`](c63-conflicts-log-and-report.md) | Conflicts log and report for the firm | P1 | Read-only per-check record, open-queue with waiting time, and redacted PDF/CSV exports for insurers and bar inquiries. | `c3`, `c58`, `c59`, `c60`, `c6`, `c99` |
| [`c97`](c97-lawyer-personal-interest-check.md) | Check lawyers' own business and personal interests | P2 | Private per-lawyer disclosure list matched against every new party; hits only to the conflicts attorney. | `c55`, `c56`, `c57`, `c58`, `c59`, `c60`, `c99` |

Suggested build order: `c56` → `c59` → `c62` → `c63` → `c61` → `c97` (after `c55`, `c3`, `c57`, `c58`, `c60` as noted).

## Shared data-model changes proposed across these specs

These touch the same existing tables, so they should be designed once:

1. `conflict_check_results.intake_session_id` is `NOT NULL` today. Checks on open matters, lateral hires and lawyer interests have no intake session. Proposed: make it nullable, add `matter_id`, `trigger` (`intake`, `party_added`, `reopened`, `lateral_hire`, `periodic`, `interest`) and `triggered_by_user_id`.
2. `party_role` enum (`caller`, `opposing_party`, `co_party`) is too narrow for `c56`; proposed extension plus a `relationship` field.
3. A conflicts role is not in `user_role` today; it arrives with `c99`. Several restrictions here need row-level policies by role, on top of the existing `tenant_isolation` RLS policy.
4. New append-only `conflict_decisions` table (no UPDATE/DELETE grant), following the `intake_events` pattern.

## Cross-cutting decisions these specs follow

- Timers (decision deadlines, waiver deadlines, letter send windows, re-confirmations) count firm business hours; overdue handling is `c45`'s single mechanism; every flag also emails per `c51` (minimal content, DV-safe address).
- Firm-side flags are internal only; clients and prospects never see them.
- The AI never clears a conflict and never gives legal advice; a conflicts attorney decides.
- Client-facing content never reveals who a conflict is with (Rule 1.05).
- Family Law is the pilot (`c103`): both spouses, the other parent, new partners and grandparents are indexed.

## Needs attorney review (combined)

- `c55`'s rule table for what is waivable, screenable or never allowed (Rules 1.06, 1.09, 1.10, 1.18) before `c59` is built.
- Waiver template content and the "informed consent" / "confirmed in writing" requirements (`c59`).
- Neutral wording while review is pending, and the full non-engagement letter (`c59`, `c62`).
- Indefinite retention of prospective-client and third-party names for conflicts; deletion-request handling (`c56`, `c62`).
- How much a lateral hire may disclose; Rule 1.10 screening conditions and notices; how rules apply to nonlawyer staff (`c61`).
- What conflict records can go to insurers or the bar (`c63`).
- Which lawyer interests must be checked under Rule 1.06(b)(2); Rule 1.08 scope (`c97`).

## Needs CPA review (combined)

- Money received while the conflict gate is closed (`c59` §4.5).
- Refund of a paid consultation fee when the firm declines for conflict (`c62`, handed to `c82`).

## Open questions for Clayton (combined)

1. Can the firm owner/admin see party details and full conflict records without the conflicts role? (`c56` Q1, `c63` Q1; recommended: counts and status only.)
2. Solo firms: is the one lawyer automatically the conflicts attorney, and is a self-recorded decision acceptable for `definite` overrides and own-interest hits? (`c56` Q2, `c59` Q5, `c97` Q2)
3. Index children in Family Law matters? (`c56` Q3)
4. One link table via a `prospective` matter for every intake, or a separate `inquiry_parties` table? (`c56` Q4; recommended: prospective matter.)
5. Index opposing counsel as parties? (`c56` Q5, `c97` Q3)
6. Default decision windows of 1 business day (intake) / 2 (open matters)? (`c59` Q1)
7. Hard block on waiving a "not waivable" rule-table result, or allow a logged override? (`c59` Q2; recommended: hard block.)
8. May the pending message ever say "conflict"? (`c59` Q3; recommended: no.)
9. New conflict on an open matter: block only new actions (recommended) or pause all work? (`c59` Q4)
10. Lateral hires: no matter access until the check completes? Same check for nonlawyer staff? Retention of departed hires' lists? Owner sees list contents? (`c61` Q1–Q4)
11. Non-engagement letters: also after did-not-hire consults? Keep letters indefinitely? Auto-send for non-conflict declines? Postal mail in v1? (`c62` Q1–Q4)
12. Insurer PDF layout example; weekly counts digest default. (`c63` Q2–Q3)
13. `c97`: keep P2? Include relatives who are lawyers/judges? Delete or keep a departed lawyer's disclosures? (`c97` Q1, Q3, Q4)

## Sources consulted

- `docs/product/case-management-expansion-scope.md`, `docs/product/scope-and-problem-statement.md`, `docs/product/spec/README.md`
- `migrations/0000_material_thanos.sql` (existing tables, enums, RLS)
- `docs/architecture/audit-log-compliance-trail.md` (`c6`), `docs/compliance/data-privacy-retention-policy.md` (`c2`)
- Board cards `c3`, `c45`, `c48`, `c51`, `c55`, `c57`, `c58`, `c60`, `c67`, `c68`, `c71`, `c85`, `c90`, `c96`, `c99`, `c101`, `c103`
- [Texas Center for Legal Ethics — Rule 1.06](https://www.legalethicstexas.com/resources/rules/texas-disciplinary-rules-of-professional-conduct/conflict-of-interest-general-rule/)
- [Texas Center for Legal Ethics — Rule 1.08](https://www.legalethicstexas.com/resources/rules/texas-disciplinary-rules-of-professional-conduct/conflict-of-interest-prohibited-transactions/)
