# c54 — Client updates are sent by email and kept in the client portal, where they can be reviewed any time

**Card:** c54 · Calendar & deadline engine · P1 · Product
**Status:** Draft spec.

## 1. Summary

A client update is a status message from the firm to the client about their matter. Each one is kept permanently in the client portal (dated, newest first, searchable) and announced by email under c51's rules. Lawyer- or staff-written updates send directly; AI-drafted updates always wait for lawyer approval; sent updates are never edited, only corrected by a new update.

## 2. Users and problem

- **Clients** want to know what is happening without calling, and to find what they were told before.
- **Lawyers/staff** want a quick, recorded way to keep clients informed (TDRPC 1.03(a): keep the client reasonably informed about the status of the matter).
- **Firm** needs proof of what was communicated and when.

## 3. Scope

**In scope**
- Composing, approving, sending, storing and displaying updates; client-side history and search; firm-side history with delivery status; corrections; update cadence per matter; client replies to updates.

**Out of scope**
- General two-way messaging (c43 handles inbound replies).
- Internal notes (never part of updates).
- Document sharing (c89).

## 4. Behaviour

**Write and send**
1. A lawyer or staff user writes an update on the matter and sends it. It is stored, appears in the client's portal history immediately, and an email notice goes out per c51.
2. The AI drafts an update from matter activity (e.g. a confirmed hearing added in c91, documents accepted in c49, stage change in c95). The draft goes to the responsible lawyer's approval queue. The lawyer approves as is, edits then approves, or discards. Only then is it sent. The AI draft may contain facts and dates from confirmed records, never predictions, assessments or advice.
3. Update drafting input excludes internal notes, flags, tasks and health scores, so they cannot appear in an update.

**Read**
4. Client portal: full update history for the matter, newest first, searchable by text and date. Each update shows its date, author name, and any "corrected by" link.
5. Firm view: same history plus delivery status per update (email sent/delivered/bounced/suppressed; opened in portal with first-opened time).

**Correct**
6. A sent update cannot be edited or deleted by anyone through the product. A correction is a new update referencing the original; the original shows "corrected on [date]" and remains visible in both histories.

**Reply**
7. A client reply to an update is an inbound message: starts c43's clock, or c44's if deadline-related.

**Cadence**
8. The firm can set a regular update rhythm per matter (**firm default: off**; per-matter value, e.g. every 10 business days). When set, every sent update creates/refreshes a firm task `client_update_due` (c45) due at last update + cadence. If it passes, it goes overdue like any firm task and feeds c53's "time since last update".

**Edge cases and failures**
- Email fails or bounces → update is still in the portal; c51 bounce flag to lawyer.
- AI draft awaiting approval for more than 2 business days → the approval is itself a c45 task that goes overdue.
- Draft becomes stale (underlying event changed, e.g. hearing moved) → the draft is marked stale and cannot be approved without regenerating or editing.
- Matter closed → history remains readable to the client for the firm-set period (open question 2).
- Two clients on a matter → the author chooses recipients; each client sees only updates addressed to them.
- Client prefers Spanish → author writes in Spanish; AI drafts in the client's language are allowed only as drafts the lawyer approves (open question 3).

## 5. Business rules

1. Every sent update is stored permanently for the matter's retention period (c2) and appears in the client's portal.
2. Every sent update triggers a c51 email notice to the client's safe address, respecting quiet hours and preferences.
3. Human-written updates send directly; AI-drafted updates require explicit lawyer approval (logged with approver and time).
4. AI drafts contain only facts and dates from confirmed records; no predictions, likelihoods, or advice. Testable via a draft checker plus the approval gate.
5. Sent updates are immutable; corrections are new linked updates.
6. Updates never include internal notes, tasks, flags or health data.
7. Update cadence: **firm setting per matter, default off**; missed cadence = overdue firm task (c45).
8. Updates default to "no reply needed" for c42 purposes (firm setting).
9. Every draft, approval, send, correction, delivery event and portal open is logged.

## 6. Data model touchpoints

- **Reuse:** `outbox` (email), `scheduled_tasks` (cadence), `matters.assigned_user_id`.
- **Proposed:** `client_updates` (`id, tenant_id, matter_id, recipient_party_ids, body, language, author_type ('user'|'ai'), author_user_id, approved_by_user_id, approved_at, sent_at, corrects_update_id, source_event_ref`), with no update/delete grant for the app role after `sent_at` is set (same pattern as `intake_events`); `client_update_reads` (party, first_opened_at); `email_deliveries`; per-matter `update_cadence` setting.

## 7. Notifications and visibility

- Client: update in portal; email notice (minimal content per c51 by default); correction notices the same way.
- Firm: history with delivery and read status; approval queue for AI drafts; overdue cadence task (internal).
- Nothing internal is ever shown to the client.

## 8. Dependencies

- **Needs first:** c11 portal, c34 client login, c51 email, c45 (cadence and approval tasks), c43/c44 (reply handling), c6 audit.
- **Fed by:** c91, c49, c95 (events that drafts are generated from).
- **Feeds:** c53 (time since last meaningful update), c42 (only if an update is marked as expecting a reply).

## 9. Compliance and review flags (licensed Texas attorney)

- UPL (TDRPC 5.05; c1): approve the "facts and dates only" rule for AI drafts and the approval gate.
- Confidentiality (TDRPC 1.05): whether the email may carry the update text or only a notice (open question 1).
- Whether staff (non-lawyer) updates sending without lawyer review is acceptable for all update types, per the card.
- Record-keeping: permanence and retention of updates and read receipts (c2).
- No trust money: no CPA review.

## 10. Acceptance criteria

1. **Given** a lawyer sends an update, **then** it appears in the client portal with date and author immediately, and a c51 email notice is queued.
2. **Given** the AI drafts an update, **then** it is not visible to the client until a lawyer approves it, and the approval is logged.
3. **Given** a sent update, **when** anyone tries to edit it, **then** the product only offers "send correction", and the original stays visible with a "corrected" link.
4. **Given** a client searches their update history for "hearing", **then** matching updates are shown newest first.
5. **Given** a per-matter cadence of 10 business days and no update sent, **then** a `client_update_due` firm task goes overdue at day 10 and is flagged internally.
6. **Given** a client replies to an update, **then** an inbound message is created and the c43 clock starts.
7. **Given** the email bounces, **then** the firm history shows "bounced" and the lawyer is flagged, while the portal copy remains.

## 11. Open questions for Clayton

1. Does the update email contain the update text, or just a notice plus portal link (c51 minimal default)?
2. How long do clients keep portal access to update history after a matter closes?
3. May the AI draft updates in Spanish for lawyer approval, or must Spanish updates be human-written until c36's review is done?
4. Default cadence: keep it off, or turn on a firm default (e.g. 10 business days) for the Family Law pilot?
