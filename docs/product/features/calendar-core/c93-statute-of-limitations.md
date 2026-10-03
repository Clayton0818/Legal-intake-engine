# c93 — Statute of limitations with independent verification (P0)

## What it does
- **Entry:** only a lawyer enters a limitation date (`limitation_dates`, date stored as `YYYY-MM-DD`). Entry creates a `limitation_date` calendar event (proposed), a deadline-critical filing task (real clock, due at the firm-set local time on the date, default 00:00) and a business-hours verification task.
- **Independent verification:** another lawyer, or staff the firm lists as trained (`limitationVerifierUserIds`), enters the date *they* worked out. The verify screen never shows the lawyer's date (blind). Match → `verified`, the calendar event is confirmed in the entering lawyer's name. Mismatch → `disputed` plus a critical flag. The entering or last-changing lawyer can never verify (also enforced by a CHECK constraint).
- **Changes:** only a lawyer, with a logged reason (`limitation_date_changes`, append-only). Each change bumps the version, returns the date to `unverified`, re-dates the task and event, and needs a fresh verification.
- **Daily flags:** every unverified/disputed date gets one flag per local day (yesterday's is resolved as superseded); critical when within `unverifiedCriticalWithinDays` (default 30) or disputed. A passed, still-open date is flagged critical daily.
- **Escalating reminders** at firm-set thresholds (default 180, 90, 60, 30, 14, 7 days): info → warning → high (adds escalation users, default firm admins, at ≤30) → critical (adds all admins, ≤7). Each threshold fires once per version; a late entry fires only the most urgent one.
- **Coverage:** retained matters with no lawyer decision ("applies" / "not applicable" with reason) are flagged. Open `intake.deadline_risk` flags (c66) on a matter without a limitation date raise a high flag to the matter's lawyer.
- **Closing a watch:** a lawyer marks it `satisfied` or `withdrawn` with a reason.
- **Suggestion (optional):** from the firm's own period table, gated on `rules.limitation_periods`; never saved as the date.

Reminders and verification are deliberately **not** gated: blocking a safety reminder would fail unsafe, and no legal rule is applied to a date a lawyer typed in.

## Routes
`limitations` (GET), `limitations/[id]/verify` (GET blind view / POST), `limitations/[id]/change`, `limitations/[id]/close`, `matters/[matterId]/limitations` (GET/POST), `…/applicability`, `…/suggest`, `settings` (GET/PATCH).
