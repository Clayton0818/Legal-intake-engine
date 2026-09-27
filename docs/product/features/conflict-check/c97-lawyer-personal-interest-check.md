# c97 — Check lawyers' own business and personal interests

**Board card:** `c97` — Conflict-check engine · Check lawyers' own business and personal interests
**Priority:** P2
**Status:** Product spec (draft). Docs only; no code. The rule basis is research to be confirmed in `c55` and by a licensed Texas attorney.
**Existing spec on main:** none for this card.

---

## 1. Summary

Conflicts do not only come from other clients; they can come from a lawyer's own interests, such as businesses they own or sit on the board of, family relationships, and investments. Each lawyer keeps a private disclosure list that is checked against new matters and new parties, and hits go only to the conflicts attorney (`c59`). The list is private and access-restricted.

## 2. Users and problem

**Users**
- **Lawyers** (and, if the firm chooses, staff): keep their own disclosure list.
- **Conflicts attorney:** receives hits and decides.
- **Firm owner/admin:** sees whether each lawyer's list is current, not its contents.

**Problem.** Texas Rule 1.06(b)(2) covers representation that "reasonably appears to be or become adversely limited by ... the lawyer's or law firm's own interests" (text checked at the Texas Center for Legal Ethics, see Sources). A client-only party index cannot catch, for example, a divorce where the opposing spouse owns a company a firm lawyer invests in, or where opposing counsel is a lawyer's sibling. Firms usually rely on memory for this.

## 3. Scope

**In scope**
- A private per-user disclosure list: businesses (owned, officer, director, significant investor), family members and close relationships (including relatives who are lawyers or judges, see open question 3), other declared interests.
- Matching of every new intake party, new matter party and opposing counsel against all lawyers' lists (`c57` matching, `c58` triggers).
- Hits create `c59` decision tasks visible only to the conflicts attorney, naming the lawyer whose interest matched.
- Annual (firm-set) re-confirmation prompt.
- Checking an existing matter when a lawyer adds a new interest.

**Out of scope**
- Rule 1.08 business-transaction workflows (e.g. a lawyer entering a deal with a client). Rule 1.08 ("Conflict of Interest: Prohibited Transactions") is named on the card for `c55` to research; this card does not model its requirements until `c55` and the attorney reviewer define them.
- Financial-value disclosure (amounts are not collected).
- Judges' recusal matters.

## 4. Behaviour

### 4.1 Maintaining the list
1. Each lawyer opens "My disclosures" (only they and the conflicts role can see it).
2. Adds entries: type (business, family, other), name, relationship (e.g. owner, director, spouse, sibling, investor), optional identifiers (business registration, city) to reduce false matches, and start/end dates.
3. Nothing about the size of an investment is asked.
4. On save, the new entry is checked against open matters and current parties (§4.3).
5. Every 12 months (firm setting), the lawyer is asked to confirm the list is current; an unconfirmed list becomes an internal overdue task (`c45`) for that lawyer and, after grace, the conflicts attorney.

### 4.2 Checking new matters
1. On every `c58` trigger (intake names step, party added, matter reopened, periodic re-check), party names are also matched against every lawyer's disclosure list.
2. A hit creates a `possible` result with trigger `interest` and a `c59` decision task for the conflicts attorney. The hit names the lawyer and the interest type.
3. Decision options follow `c59`: cleared, proceed with client consent (if the rule table allows), exclude that lawyer from the matter (via `c60` screen mechanics), or decline.

### 4.3 New interest on an existing matter
1. A lawyer adds an interest that matches a party on an open matter.
2. A decision task goes to the conflicts attorney; the matter is flagged internally for further new actions per `c59` §4.6.

### 4.4 Edge cases and failure paths
- **The conflicts attorney's own interest hits:** the task goes to the backup conflicts attorney, else the firm owner (`c59` §4.7).
- **Solo firm:** the lawyer is both discloser and conflicts attorney; the hit is still recorded and the lawyer must record a decision and reason (open question 2).
- **Common names:** identifiers help reduce noise; `c57` still over-flags rather than skips.
- **Lawyer leaves:** their list is disabled from matching; kept or deleted per open question 4.

## 5. Business rules

1. A lawyer's list is visible only to that lawyer and users with the conflicts role. Firm owner/admin see status only (last confirmed date, count), not contents. Not firm-configurable.
2. Every hit goes to the conflicts attorney; the system never clears an interest hit.
3. Interest hits and their details never appear to the client, the prospect, other lawyers, or the firm owner without the conflicts role, and never in any client-facing message.
4. Interest hits do not reveal the interest to other staff; the only visible effect for others is "pending conflicts review" (and, if decided, that the lawyer is not on the matter).
5. Re-confirmation interval: **firm-configurable**, default 12 months.
6. Who must keep a list: **firm-configurable**, default all lawyers; staff optional.
7. Adding, editing, confirming and each hit/decision are logged in `c6`; the audit view of disclosure contents is restricted like the list itself.

## 6. Data model touchpoints

**Reuse:** `users`, `conflict_check_results` (with the proposed `trigger` column and nullable `intake_session_id`), `scheduled_tasks` (re-confirmation), `intake_events`.
**Proposed**
- **`interest_disclosures`**: `id`, `tenant_id`, `user_id`, `interest_type` (`business`, `family`, `other`), `name`, `normalized_name`, `relationship`, `identifiers jsonb`, `starts_on`, `ends_on`, `created_at`, `updated_at`. RLS `tenant_isolation` plus a policy allowing reads only to the owning user and the conflicts role.
- **`interest_disclosure_confirmations`**: `user_id`, `confirmed_at`, `next_due_at`.
- **`interest_disclosure_hits`** (or reuse `conflict_check_results.matched_sources` with a restricted source type): links a check to a disclosure entry.
- Stored separately from `parties` (`c56`) so general index access never exposes lawyers' private interests.

## 7. Notifications and visibility

- **Lawyer:** own list; re-confirmation reminders and overdue flags (`c45`), minimal email (`c51`).
- **Conflicts attorney:** hit tasks and minimal email; full view of lists.
- **Firm owner/admin:** list status only; overdue re-confirmation flags after grace.
- **Clients / prospects:** nothing.

## 8. Dependencies

**Needs first:** `c55` (Rule 1.06(b)(2) and 1.08 analysis), `c56`, `c57`, `c58`, `c59`, `c60` (for excluding the lawyer), `c34`/`c99`.
**Feeds:** `c63` (log, restricted), `c48` (excluded lawyer never auto-assigned).

## 9. Compliance and review flags (licensed Texas attorney)

1. Which personal and business interests actually need to be checked under Rule 1.06(b)(2), and what `c55` concludes about Rule 1.08. This card's scope list is a starting guess, not a legal determination.
2. Whether relationships with opposing counsel or judges belong here, and which relatives count.
3. What consent or other steps are available when a lawyer's own interest is implicated (feeds `c59`'s rule table).
4. Privacy of lawyers' personal data held by the firm and by the vendor (employee data, not client data; `c2` does not currently cover it).

## 10. Acceptance criteria

1. **Given** lawyer L discloses directorship of "Acme Holdings LLC", **when** a new intake names "Acme Holdings" as an opposing party, **then** a `possible` result with trigger `interest` is created and a decision task naming L goes to the conflicts attorney only.
2. **Given** a firm owner without the conflicts role, **when** they open L's disclosures, **then** they see only the last confirmed date and count.
3. **Given** another lawyer on the same matter, **when** they view the matter, **then** they see only "pending conflicts review" and nothing about L's interest.
4. **Given** L's list was last confirmed 12 months ago, **when** the re-confirmation date passes, **then** L gets an internal task and, after the grace period, the conflicts attorney is flagged.
5. **Given** L adds a new interest matching a party on an open matter, **when** saved, **then** a decision task is created for that matter.
6. **Given** the conflicts attorney is L, **when** L's interest hits, **then** the task routes to the backup conflicts attorney or the firm owner.
7. **Given** any client-facing message about a matter with an interest hit, **when** generated, **then** it contains no reference to the hit or the lawyer's interest.

## 11. Open questions for Clayton

1. Is P2 right given Family Law pilot firms are small and lawyers' community ties are common? (Keep as P2; revisit after pilot feedback.)
2. Solo firms: accept a self-recorded decision, or recommend an outside review for interest hits?
3. Include relationships with opposing counsel and judges in the list?
4. When a lawyer leaves, delete their disclosure list or keep it with the conflicts records?

## Sources

- [Texas Center for Legal Ethics — Rule 1.06 Conflict of Interest: General Rule](https://www.legalethicstexas.com/resources/rules/texas-disciplinary-rules-of-professional-conduct/conflict-of-interest-general-rule/) — text of Rule 1.06(b)(2) ("adversely limited by ... the lawyer's or law firm's own interests").
- [Texas Center for Legal Ethics — Rule 1.08 Conflict of Interest: Prohibited Transactions](https://www.legalethicstexas.com/resources/rules/texas-disciplinary-rules-of-professional-conduct/conflict-of-interest-prohibited-transactions/) — rule title only; substance left to `c55`.
