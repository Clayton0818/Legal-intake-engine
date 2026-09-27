# c59 — A conflicts attorney decides every possible conflict, with written waivers where allowed

**Board card:** `c59` — Conflict-check engine · A conflicts attorney decides every possible conflict, with written waivers where allowed
**Priority:** P0
**Status:** Product spec (draft). Docs only; no code. Compliance-sensitive sections are research and a recommended approach, flagged for licensed Texas attorney review.
**Existing spec on main:** none for this card. Builds on `conflict_check_results` (`c19`), whose `resolved_by_user_id` / `resolved_at` columns were placed for exactly this step, and on `c3`'s tri-state outcome.

---

## 1. Summary

Every conflict check that returns `possible` or `definite` becomes a decision task for a firm-designated conflicts attorney. The AI never clears a conflict. The attorney records one of four decisions (cleared, proceed with written consent, proceed with a screen, decline) with who, when and why. If consent is needed, the Document engine drafts the waiver and collects signatures from every affected client, and the matter stays blocked until all are in. Nothing downstream (engagement agreement, assignment, scheduling, trust deposit) can happen while a conflict is undecided.

## 2. Users and problem

**Users**
- **Conflicts attorney** (firm-designated, `c99` role): decides.
- **Backup conflicts attorney:** receives the task if the primary is out or the task goes overdue.
- **Intake staff and the assigned lawyer:** see that the matter is blocked "pending conflicts review", never the details unless they hold the conflicts role.
- **Prospective client and affected existing clients:** receive neutral messages and, where consent is needed, a waiver to sign.
- **Firm owner/admin:** sees overdue conflict decisions.

**Problem.** `c3` pauses intake on a `possible` result and stops on `definite`, but today nothing specifies who decides, by when, what decision types exist, how waivers are obtained, or how downstream engines are prevented from moving ahead. Without a hard gate, a matter could be booked, assigned or funded while a conflict is open, which is exactly the failure a conflict system exists to prevent.

## 3. Scope

**In scope**
- Decision queue for `possible` and `definite` results, with deadline and overdue flag via `c45`.
- Four decision types with mandatory reason: `cleared`, `proceed_with_consent`, `proceed_with_screen`, `declined`.
- Written-consent workflow: waiver drafted from a lawyer-approved template (`c85`), sent for e-signature to each affected client (`c4`/`c39` signing path), tracked per signer.
- A single "conflict gate" that blocks engagement agreement (`c39`), assignment (`c48`), scheduling/booking (`c67`), trust deposit (`c50`, `c80`) and matter opening (`c68`).
- Neutral client-facing messages that never reveal who the conflict is with (Rule 1.05).
- Re-decision when new facts arrive (new party added, `c58` re-check).

**Out of scope**
- Matching and scoring (`c57`), deciding clear/possible/definite (`c3`).
- Screen enforcement mechanics (`c60`); this card only records the decision to screen and hands off.
- The legal rule table of what is waivable (`c55` produces it; this card consumes it).
- Non-engagement letter content (`c62`).

## 4. Behaviour

### 4.1 Decision task creation
1. `c3` writes a `conflict_check_results` row with `outcome = possible` or `definite`.
2. The system creates a conflict decision task assigned to the firm's designated conflicts attorney, due within the firm-set window (default 1 business day for `possible` during intake, 2 business days for re-checks on open matters; business hours per the firm calendar).
3. The intake or matter shows status **Pending conflicts review**. The conflict gate is closed.
4. The prospective client is told, neutrally, that the firm needs to complete an internal review before it can proceed and will be in touch (wording from the firm's attorney-reviewed script layer). No names, no mention of "conflict" unless the reviewing attorney approves that word (open question 3).

### 4.2 The attorney's review screen
Shows: the parties searched, each hit with `c57`'s match reason and strength, the role sought (`c3` is role-sensitive), the related matters' status (current / former / prospective), the relevant row(s) from `c55`'s rule table (e.g. "former client, substantially related: waivable with consent" or "not waivable"), and prior decisions on the same parties. It does not show case narrative from the other matter beyond what the conflicts role already has.

### 4.3 Decisions
1. **Cleared** (false positive, or no conflict under the rules): reason required, chosen from a list plus free text. Gate opens.
2. **Proceed with written consent:** attorney selects which clients must consent (the prospective client and/or existing/former clients) and the waiver template. Go to 4.4. Gate stays closed.
3. **Proceed with a screen:** attorney selects who is screened and the reason (e.g. Rule 1.18 prospective-client contact, Rule 1.10 lateral). Hands off to `c60` to create and enforce the screen and the notice task. Gate opens only once `c60` confirms the screen is active. If both consent and a screen are needed, both must complete.
4. **Declined:** reason required. Intake ends as `declined_conflict`; `c62` sends the neutral non-engagement letter. Parties stay indexed (`c56`).
5. If `c55`'s rule table marks the situation as **not waivable**, the "proceed with consent" option is disabled with the rule reference shown. The attorney may still override by marking "rule table does not fit these facts" with a written explanation; that override is itself flagged to the firm owner (open question 2).
6. A `definite` result can only be `declined` or overridden to `cleared` with a written explanation; overrides of `definite` are flagged to the firm owner/admin.

### 4.4 Written consent (waiver) workflow
1. The Document engine drafts a waiver from the firm's approved template (`c85`), filled with matter data. Each affected client gets their own document, which describes only what that client is entitled to know. A waiver to Client A must not disclose Client B's confidential information beyond what Client B has agreed can be disclosed.
2. The conflicts attorney reviews and approves each draft. The AI does not send an unreviewed waiver.
3. Each waiver is sent for e-signature to the client's verified contact (`c71` identity check; DV-safe address per `c51`/`c103`).
4. Each signer has a due date (firm setting, default 5 business days). Reminders go out; an unsigned waiver becomes an overdue internal task (`c45`).
5. The gate opens only when **every** required signature is in and countersigned if the firm requires it.
6. If any client refuses or does not sign by a firm-set outer limit (default 15 business days), the task returns to the conflicts attorney to decide: decline, or re-approach.
7. Signed waivers are stored against both the new matter and the affected existing matter (`c84`), restricted to the conflicts role and the responsible lawyers.

### 4.5 The conflict gate
- A single gate state per intake/matter: `open` only when the latest check is `clear`, or all `possible`/`definite` hits have a completed decision whose conditions (signatures, active screen) are met.
- Each downstream action checks the gate server-side before it runs: generate or send engagement agreement (`c39`), auto-assign or manual assign (`c48`), offer or book a consultation (`c67`), accept any payment into trust or operating (`c50`, `c52`, `c80`), open the matter (`c68`).
- A consultation request received before the gate opens is queued, not booked.
- If a payment arrives anyway (e.g. mailed check), it is recorded as received-not-accepted and routed to the firm owner and bookkeeper for handling (CPA review flag).

### 4.6 Re-decision
If `c58` re-runs and finds a new hit on an already-cleared matter, a new decision task is created and the gate for further new actions (new assignments, new trust deposits, new scheduling) closes again. Work already in progress is not auto-halted; the conflicts attorney and responsible lawyer are flagged immediately (open question 4).

### 4.7 Failure paths
- No conflicts attorney designated: the task goes to the firm owner/admin and a setup flag is raised. The gate stays closed.
- Conflicts attorney is also a party to the hit (e.g. a `c97` interest hit on themselves): task routes to the backup; if none, the firm owner.
- E-signature provider down: waiver stays in "sending" with retry; internal flag after 1 business hour.

## 5. Business rules

1. The AI and the system never set a decision. Every decision row has a human `decided_by_user_id` holding the conflicts role.
2. The conflict gate is enforced server-side for every downstream action listed in §4.5; UI hiding alone does not count.
3. Every decision requires a reason. `cleared` on a `definite` result and any "rule table does not fit" override require free-text explanation and are flagged to the firm owner/admin.
4. A decision is immutable once recorded. Corrections are new decision rows that reference the old one.
5. All required consents must be signed before the gate opens; partial consent is not enough.
6. Client-facing messages, emails and portal content never reveal the identity of any other party in a hit, the existence of the other matter, or the word "conflict" unless the firm's attorney-approved wording says so.
7. Decision task due time: **firm-configurable**, default 1 business day (intake) and 2 business days (open-matter re-check), counted in firm business hours. Overdue follows `c45`: assignee first, then backup conflicts attorney and firm admin after the grace period (default 2 business hours).
8. Waiver signature due time: **firm-configurable**, default 5 business days, outer limit 15 business days.
9. Countersignature by the firm on waivers: **firm-configurable**, default on.
10. Waiver templates must be approved by a firm lawyer before use (`c85`).
11. Every task, decision, waiver send, signature and gate change is logged in `c6`.

## 6. Data model touchpoints

**Reuse**
- `conflict_check_results` (`outcome`, `matched_party_ids`, `matched_sources`, `role_sought`, `resolved_by_user_id`, `resolved_at`). Note: `intake_session_id` is `NOT NULL` today; checks on open matters, lateral hires (`c61`) and lawyer interests (`c97`) have no intake session, so this should become nullable with a `matter_id` and a `trigger` column (proposed; shared with `c58`).
- `matters.stage` (`declined_conflict`, `pending_review`).
- `documents` (waivers, once `c84` makes it real).
- `scheduled_tasks` for due-time and reminder timers; `intake_events` for audit.

**Proposed**
- **`conflict_decisions`**: `id`, `tenant_id`, `conflict_check_result_id`, `decision` (`cleared` | `proceed_with_consent` | `proceed_with_screen` | `declined`), `reason_code`, `reason_text`, `rule_table_ref` (from `c55`), `override_flag`, `decided_by_user_id`, `decided_at`, `supersedes_decision_id`. Append-only (no UPDATE/DELETE grant), like `intake_events`.
- **`conflict_waivers`**: `id`, `tenant_id`, `conflict_decision_id`, `client_party_id`, `document_id`, `sent_at`, `due_at`, `signed_at`, `countersigned_at`, `status` (`draft`, `approved`, `sent`, `signed`, `refused`, `expired`).
- **`conflict_gates`** (or a computed view): `tenant_id`, `intake_session_id` / `matter_id`, `state` (`open` | `closed`), `closed_reason`, `updated_at`.
- `firm_config_versions.config`: `conflicts.designated_attorney_user_id`, `conflicts.backup_user_ids`, due-time settings above.
- Uses the tasks table from the case-management data-model extension (scope memo §4) for the decision task.

## 7. Notifications and visibility

| Who | Sees / receives |
|---|---|
| Conflicts attorney | Decision task in-app + email (`c51`, minimal: "A conflicts review is waiting", link, no names). Overdue flags per `c45`. |
| Backup conflicts attorney, firm admin | Escalated overdue flag + email after grace period. Owner also gets override flags. |
| Intake staff / assigned lawyer | "Pending conflicts review" status only; no hit details unless conflicts role. |
| Prospective client | Neutral "internal review" message; later either booking offer or `c62` letter. Never names, never firm-side overdue flags. |
| Affected existing client asked to consent | Their own waiver, via portal/e-sign, email to DV-safe address saying a document needs their signature (no content in email). |
| Screened person (`c60`) | Nothing about the matter; `c60` handles their notice. |

## 8. Dependencies

**Needs first:** `c55` (rule table, attorney-reviewed), `c3` (results), `c56`/`c57` (index and match reasons), `c45` (task/overdue mechanism), `c51` (email), `c34`/`c99` (conflicts role), `c85` + `c4` (templates and e-signature).
**Feeds / gates:** `c39`, `c48`, `c50`, `c52`, `c60`, `c62`, `c63`, `c67`, `c68`, `c80`.

## 9. Compliance and review flags

**Texas attorney must review before build:**
1. `c55`'s rule table that decides when "proceed with consent" is available and when a situation is not waivable (Rules 1.06, 1.09, 1.10, 1.18).
2. Waiver template content, including how much each client is told so that the waiver itself does not breach Rule 1.05 for another client, and whether the form meets the rules' "informed consent" / "confirmed in writing" definitions as adopted Oct 1, 2024.
3. The neutral client-facing wording while review is pending, and whether it may say "conflict" at all.
4. Whether an override of the rule table (§4.3 step 5) should be possible at all.
5. Whether in-progress work on an open matter must stop when a new conflict appears (§4.6).

**CPA review (trust money):**
6. Handling of funds received while the conflict gate is closed (§4.5): whether they may be deposited to trust pending decision or must be returned, and the ledger treatment. Also needs the attorney reviewer.

## 10. Acceptance criteria

1. **Given** a check returns `possible`, **when** the result is saved, **then** a decision task is created for the designated conflicts attorney with a due time 1 business day later in the firm's calendar, and the intake shows "Pending conflicts review".
2. **Given** the conflict gate is closed, **when** any user or automation tries to generate an engagement agreement, assign a lawyer, book a consultation or accept a trust deposit, **then** the server refuses and logs the attempt.
3. **Given** the attorney selects "proceed with written consent" for two affected clients, **when** only one has signed, **then** the gate stays closed; **when** the second signs, **then** the gate opens and both signatures are recorded with dates.
4. **Given** a situation `c55` marks as not waivable, **when** the attorney opens the decision screen, **then** "proceed with consent" is disabled and the rule reference is shown.
5. **Given** a pending review, **when** the prospective client asks via chat why they cannot book, **then** the AI gives the neutral approved message and does not reveal any party name, other matter or overdue status.
6. **Given** a decision task passes its due time, **when** the grace period ends, **then** the backup conflicts attorney and firm admin are flagged in-app and by minimal email, and the client sees nothing.
7. **Given** a user without the conflicts role, **when** they try to record a decision via the API, **then** it is rejected.
8. **Given** a recorded decision, **when** someone tries to edit it, **then** the edit is refused; a superseding decision can be recorded instead and both remain visible.
9. **Given** "declined", **when** saved, **then** the intake ends as `declined_conflict` and `c62`'s letter workflow starts.

## 11. Open questions for Clayton

1. Default decision windows: 1 business day for intake and 2 for open matters. OK?
2. Should the conflicts attorney be allowed to override `c55`'s "not waivable" rule table at all, or should that be a hard block? (Recommendation: hard block for pilot; revisit after attorney review.)
3. Can the neutral pending message ever use the word "conflict"? (Recommendation: no, pending attorney review.)
4. When a new conflict appears on an already open matter, do we only block new actions (recommended) or pause all work on the matter?
5. For solo firms, the lawyer is both the handling and conflicts attorney. Accept that, or require a second reviewer (e.g. an outside lawyer) for `definite` overrides?
