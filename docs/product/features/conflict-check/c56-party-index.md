# c56 — One party index of everyone the firm has ever dealt with

**Board card:** `c56` — Conflict-check engine · One party index of everyone the firm has ever dealt with
**Priority:** P0
**Status:** Product spec (draft). Docs only; no code. Compliance-sensitive sections are research and a recommended approach, flagged for licensed Texas attorney review.
**Existing spec on main:** none for this card. Builds on the existing `parties` / `matter_parties` tables (`c19`, `migrations/0000_material_thanos.sql`) and the `conflict_rules` interface in `docs/product/spec/` (`c12`).

---

## 1. Summary

The party index is the single, per-firm list of every person and organisation the firm has ever had a relationship with, in any role: clients (current and former), opposing parties, related parties, opposing counsel, and prospective clients who were never retained. Every conflict check (`c3`, `c58`) searches this index and nothing else, so if a name is not in it, the check cannot catch it. It is filled automatically from intake, matters and documents, is strictly isolated per firm, and is visible only to staff with the conflicts role.

## 2. Users and problem

**Users**
- **Conflicts attorney / conflicts staff** (new role in `c99`): search and review the index, correct records, confirm merges.
- **The conflict-check engine** (`c3`, `c57`, `c58`): reads the index on every check.
- **Intake staff, lawyers, paralegals:** never see the index directly; they add parties to intakes and matters, which feeds it.
- **Firm owner/admin:** sees index health (counts, pending merges, import status) but not necessarily party details unless they also hold the conflicts role (open question 1).

**Problem.** Today the product only knows the parties of the current intake (`parties`, `matter_parties` with roles `caller`, `opposing_party`, `co_party`). A real conflict check needs the firm's whole history, including people who were only mentioned (a spouse, a new partner, a grandparent in a custody case), people who consulted and were declined (a prior consult can still conflict the firm out under Rule 1.18), and business relationships (a company and its parent). Without one complete index, every check silently under-reports.

## 3. Scope

**In scope**
- One index per firm (tenant) holding: current clients, former clients, prospective clients (including declined and conflicted-out inquiries, `c62`), opposing parties, related parties (spouses, former spouses, children's other parent, new partners, grandparents, other family members, businesses, insurers, co-defendants), opposing counsel and their firms.
- Name variants per party: aliases, former and maiden names, married names, nicknames entered by staff, business names / DBAs.
- Organisation links: parent / subsidiary / affiliate between business parties.
- Links between each party and every matter or inquiry they appear in, with their role in it and the dates of that involvement.
- Automatic population from: intake (`c65`), matter opening and later party additions (`c68`), documents where a party is confirmed by a person (`c84`, `c87`), historical import (`c96`, `c98`), lateral-hire lists (`c61`, stored separately, see §6) and lawyer interest disclosures (`c97`, stored separately).
- Manual add / edit / merge / un-merge by the conflicts role, every change logged.
- Tenant isolation (`c8`) and role restriction (`c99`).

**Out of scope**
- The matching algorithm itself (`c57`) and the decision of clear / possible / definite (`c3`).
- When checks run (`c58`).
- Decision workflow (`c59`), screens (`c60`), the log/report (`c63`).
- Any cross-firm or platform-wide index. There is none, ever.
- Storing case facts. The index holds identity and relationship data only, not narrative.

## 4. Behaviour

### 4.1 Adding a party from intake
1. Intake captures the caller's name and the names of other parties early, before case details (`c58` step 1).
2. For each name, the system creates or reuses a party record and links it to the intake with a role (e.g. `prospective_client`, `opposing_party`, `related_party:spouse`).
3. Reuse is only automatic when the same party record was already selected in this intake session. Otherwise a new record is created; possible duplicates go to the merge-suggestion queue (§4.5). The index never auto-merges two records (same principle as `c71`).
4. The party is searchable by the next check within seconds (target: same transaction as the intake write).

**Edge cases**
- Caller gives only a first name or a nickname for the other party: store what was given, mark `name_completeness = partial`, and let `c57` over-flag rather than skip.
- Caller refuses to name the other party: store a placeholder link with `name_unknown = true`; the conflict check result for that intake cannot be `clear` on that party (see business rule 7).
- Family Law (`c103`): the flow asks for both spouses, the children's other parent, known new partners, and grandparents seeking custody or access. Children are not indexed by default (open question 3).

### 4.2 Adding a party to an open matter
1. Staff add a party to a matter (or the Document engine proposes one from a filed document or email and a person confirms it).
2. The party is written to the index and linked to the matter with role and start date.
3. This triggers a conflict re-check (`c58` step 2). The matter is not blocked by the add itself; the re-check result decides.

### 4.3 Declined and conflicted-out prospects
1. When an intake ends as declined, conflicted out, did-not-hire or abandoned after names were captured, the parties stay in the index with their inquiry link (`c62`).
2. The case narrative follows the retention policy (`c2`: 90-day default for declined inquiries); the index entry (names, role, inquiry date, which lawyer or staff member spoke to them) is kept per the conflicts-record rule (`c2` §6: "typically indefinitely... stored as minimally as possible").

### 4.4 Closing a matter
Closed matters and their parties stay in the index permanently (`c90`). The link changes to `former` status with the closing date. Closing a matter never deletes an index entry.

### 4.5 Duplicate and merge handling
1. A nightly worker job (`scheduled_tasks`, task type `party_index_dedupe_scan`) and every write both look for likely duplicates using `c57` scoring.
2. Suggestions go to the conflicts role's merge queue with the reason (same DOB + similar name, same email, etc.).
3. A person confirms or rejects. Confirmed merges keep both original records as history and can be undone.
4. Rejected pairs are remembered so the same pair is not suggested again unless new identifiers appear.

### 4.6 Deletion requests
1. If a data subject asks for deletion (`c2` §7), the request goes to the firm. The index entry is flagged as needing a conflicts-retention decision, not deleted automatically.
2. The conflicts attorney records the decision and legal basis. If the entry is kept, the narrative and contact details are still removed and only the minimum for conflict checking (name, variants, role, matter/inquiry link, dates) remains.

### 4.7 Failure paths
- Index write fails during intake: the intake cannot pass the conflict step. The session waits and the step retries; after a firm-set number of failures (default 3) it becomes a `possible` result for human review, never `clear`.
- Import (`c96`) not confirmed yet: the firm's conflict checks are marked "history not loaded" and no result can be `clear` without a conflicts attorney acknowledging the missing history (business rule 9).

## 5. Business rules

1. Every party in any role in any intake, matter or confirmed document is in the index. There is no "not worth indexing" role.
2. Index data is tenant-scoped. All reads and writes go through `withTenant()` and RLS; no query path, admin tool, export, AI prompt or support tool reads across tenants.
3. Only users with the conflicts role (and firm owner/admin if the firm allows, see open question 1) can view or search the index directly. Other roles can add parties but cannot browse or search the index.
4. The index never auto-merges records. Merges need a person with the conflicts role, and every merge can be undone.
5. Index entries are never deleted because a matter closed or an inquiry was declined. Removal only happens through a recorded conflicts-attorney decision (§4.6).
6. Each party can hold unlimited name variants, each typed (`legal`, `alias`, `former`, `maiden`, `married`, `nickname`, `business`, `dba`). All variants are searched.
7. A party link with `name_unknown = true` makes the check for that intake at best `possible`, never `clear`.
8. Index entries hold identity and relationship data only. Case facts stay in the matter/intake records under their own retention rules.
9. Until the firm confirms its history import (`c96`), no check may return `clear` without a conflicts attorney's acknowledgement. Firm-configurable: no. Safety rule.
10. Organisation links (parent/subsidiary/affiliate) are searched one level up and one level down by default. **Firm-configurable:** link depth, default 1.
11. The party role list is firm-extendable but the base roles cannot be removed. **Firm-configurable:** extra related-party roles, default none.
12. Every create, edit, merge, un-merge and retention decision is written to the audit trail (`c6`) with who, when and why.

## 6. Data model touchpoints

**Reuse (exists today)**
- `parties` (`id`, `tenant_id`, `full_name`, `normalized_name`, `date_of_birth`, `email`, `phone`, `created_at`), with index `parties_tenant_normalized_name_idx`.
- `matter_parties` (`matter_id`, `party_id`, `role`), unique on (`matter_id`, `party_id`, `role`).
- `party_role` enum (`caller`, `opposing_party`, `co_party`): too narrow; extend (below).
- `matters.stage` includes `declined_conflict`; `intake_sessions` for pre-matter inquiries.
- `intake_events` as the audit trail (`c6`).
- `scheduled_tasks` for the dedupe scan.

**Proposed**
- Extend `party_role` (or replace with a lookup table, open question 4): `prospective_client`, `client`, `former_client`, `opposing_party`, `opposing_counsel`, `related_party`, `co_party`, `insurer`, `co_defendant`, plus a `relationship` text field (`spouse`, `former_spouse`, `other_parent`, `new_partner`, `grandparent`, `parent_company`, ...).
- `parties.party_type` (`person` | `organisation`), `parties.name_completeness`, `parties.address` (for `c57` secondary matching).
- **New table `party_names`** (proposed): `id`, `tenant_id`, `party_id`, `name`, `normalized_name`, `name_type`, `source`, `created_by`, `created_at`. RLS `tenant_isolation`.
- **New table `party_org_links`** (proposed): `tenant_id`, `parent_party_id`, `child_party_id`, `link_type` (`parent_subsidiary`, `affiliate`), `source`.
- **New table `inquiry_parties`** (proposed): links parties to an `intake_session_id` before any matter exists, with role and `name_unknown`. (Alternative: create a `prospective` matter for every intake; open question 4.)
- Add `started_at`, `ended_at`, `status` (`current` | `former`) to `matter_parties`.
- **New table `party_merges`** (proposed): `survivor_party_id`, `merged_party_id`, `merged_by`, `reason`, `undone_at`.
- **New table `party_merge_suggestions`** (proposed): pair, score, reason, status (`open`, `confirmed`, `rejected`).
- Lateral-hire lists (`c61`) and lawyer interest disclosures (`c97`) are stored in their own restricted tables and searched alongside the index, not merged into `parties`, so their tighter access rules hold.

All new tables: `tenant_id NOT NULL`, RLS `tenant_isolation` policy, grants to `app_runtime`, and the cross-tenant CI test (`c8`).

## 7. Notifications and visibility

- **Client / prospective client:** never sees the index, never learns who else is in it.
- **Conflicts role:** full index view, merge queue, retention-decision queue.
- **Other staff:** can add parties to intakes/matters; see only the parties on matters they can access (and not on screened matters, `c60`).
- **Flags:** a stale merge queue (items older than a firm-set age, default 5 business days) creates an internal task for the conflicts role and goes overdue through `c45`; the overdue flag emails the conflicts role only (`c51`), with no party names in the email body.
- Import-not-confirmed banner shows to conflicts role and firm owner/admin.

## 8. Dependencies

**Needs first:** `c8` (tenant isolation, shipped), `c19` (schema, shipped), `c34`/`c99` (real auth and a conflicts role), `c55` (rule research that defines which roles matter), `c6` (audit, shipped).
**Built alongside:** `c57` (matching reads name variants and secondary identifiers), `c96`/`c98` (history import fills it).
**Feeds:** `c3`, `c57`, `c58`, `c59`, `c61`, `c62`, `c63`, `c71`, `c97`, `c103`.

## 9. Compliance and review flags (licensed Texas attorney)

1. **Retention of prospective-client and third-party data indefinitely for conflicts purposes.** `c2` §6 recommends indefinite, minimal retention; confirm this is acceptable under Rule 1.18 and privacy law (TDPSA) for people who never became clients and for third parties who never interacted with the firm.
2. **What minimum data must be kept for a declined prospect** so that a later Rule 1.18 analysis is possible (e.g. which lawyer spoke to them and roughly what subject), without keeping more case detail than needed.
3. **Deletion requests** against conflicts records (`c2` §7 item 3): confirm the "conflicts-retention override" approach.
4. **Whether children should be indexed** in Family Law matters, and how.
5. **Role restriction:** confirm that restricting index browsing to the conflicts role is consistent with Rule 1.05 obligations and practical for small firms where one lawyer does everything.

## 10. Acceptance criteria

1. **Given** a prospective client names an opposing party during intake, **when** the names step completes, **then** both appear in the firm's index linked to that intake with their roles, and a check started immediately afterwards can find them.
2. **Given** two firms on the platform both have a party named "Maria Garcia", **when** a conflicts user at Firm A searches the index, **then** only Firm A's record is returned, and the cross-tenant CI test confirms Firm B's rows are unreadable under Firm A's tenant context.
3. **Given** an intake that ended as declined 3 years ago, **when** a new intake names the same person as an opposing party, **then** the old inquiry link is still in the index and is returned to the check.
4. **Given** a user with the `intake_staff` role, **when** they try to open the party index search, **then** access is denied and the attempt is logged.
5. **Given** two records with the same date of birth and similar names, **when** the dedupe scan runs, **then** a merge suggestion with its reason is created and the records remain separate until a conflicts user confirms.
6. **Given** a confirmed merge, **when** the conflicts user undoes it, **then** both original records and their links are restored and both actions are in the audit trail.
7. **Given** a caller who refuses to name the other party, **when** the check runs, **then** the result is not `clear`.
8. **Given** a firm that has not confirmed its history import, **when** any check would return `clear`, **then** it is held for a conflicts attorney acknowledgement.
9. **Given** a matter is closed, **when** the closing completes, **then** its parties remain in the index with status `former` and the closing date.

## 11. Open questions for Clayton

1. Can the firm owner/admin see party details in the index without holding the conflicts role, or only index health numbers? (Recommendation: health numbers only; small firms can give the owner both roles.)
2. For a solo firm with no separate conflicts attorney, is the one lawyer automatically the conflicts role?
3. Index children in Family Law matters (name only, marked minor), or not at all?
4. Pre-matter inquiries: separate `inquiry_parties` table, or create a `prospective` matter for every intake so `matter_parties` covers everything? (Recommendation: create a prospective matter; the `matter_stage` enum already has `prospective`, so one link table stays simpler.)
5. Should opposing counsel be indexed as parties (for "lawyer on the other side is a relative" checks via `c97`), or kept as a separate list?
