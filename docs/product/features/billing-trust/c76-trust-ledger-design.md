# c76 — Client trust ledger and monthly three-way reconciliation (design)

**Status:** implemented behind approval gates; nothing posts until an attorney and a CPA approve `rules.trust_accounting`. Built against the `c75` research draft (`docs/compliance/trust-accounting-iolta-compliance-review.md`), which is research, not legal or accounting advice. Both reviewers should check this design, especially §3 (the database enforcement) and §5 (reconciliation mechanics), before any real client money is recorded.

## 1. Model

- **Trust account** (`trust_accounts`) — a firm's IOLTA or separate trust bank account. Only the last four digits of the account number are stored.
- **Account book** (`trust_account_books`) — one row per account: book balance, last sequence, hash-chain head. Trigger-maintained.
- **Sub-ledger** (`trust_subledgers`) — one per client per matter per account, plus at most one **firm bank-fee cushion** per account. Running `balance_cents` and disputed `held_cents`. Trigger-maintained.
- **Journal** — `trust_transactions` (one register line: kind, date the money moved, why, payee/payer, reference, optional `invoice_id`, who posted it and when, the approvals in force, `prev_hash`/`hash`) and `trust_ledger_entries` (one line per sub-ledger touched, with the running sub-ledger and book balance after it). Append-only.
- **Holds** — `trust_holds` / `trust_hold_releases`: disputed funds, excluded from what can be moved (c75 §6).
- **Statements** — `trust_bank_statements` / `_lines`: entered by hand, imported from the bank's CSV, or (gated, stub) pulled from a bank feed. A correction supersedes; nothing is edited.
- **Reconciliations** — `trust_reconciliations` (full worksheet as JSON + hash), `trust_reconciliation_signoffs`, `trust_period_closes`. Every reconciliation ever prepared is kept.

Money is integer cents in `bigint` everywhere (JS `bigint` in code, strings of cents in JSON). Floats are rejected at the API boundary.

### Entry kinds

| Kind | Effect | Rules |
|---|---|---|
| `deposit` | + one client ledger | source must be client or third party; firm money → refused (commingling); a netted processor fee → refused (c75 §8) |
| `disbursement` | − one client ledger | payee required |
| `earned_fee_transfer` | − one client ledger → operating | invoice id or stated earning benchmark required (c75 §7); c50 floor hook |
| `refund` | − one client ledger | |
| `transfer` | − one ledger, + another | same client only; nets to zero |
| `cushion_deposit` | + firm cushion | gated (`rules.billing-trust.bank_fee_cushion`) and ≤ the firm's configured cap |
| `cushion_withdrawal`, `bank_fee` | − firm cushion | bank fees can never be charged to a client |
| `reversal` | exact negation of an earlier entry | at most once; never of a reversal; cannot overdraw |

Every outflow is checked against **available = balance − held**. No entry may be dated in the future or on/before the end of a closed month.

## 2. Rule list (c75 §11) → where it is enforced

| §11 | Rule | Domain (`ledger.ts` / `reconciliation.ts`) | Database |
|---|---|---|---|
| 1 | Pooled account = Σ sub-ledgers | `checkInvariants` I3; reconciliation `BOOK_VS_CLIENT_LEDGERS`, `CACHED_TOTAL_MISMATCH` | deferred constraint trigger compares book vs Σ sub-ledgers at commit |
| 2 | No sub-ledger negative; no client covers another | `INSUFFICIENT_FUNDS`, `CROSS_CLIENT`; property test I4 | `CHECK balance_cents >= 0`; line trigger re-checks; transfer = 2 lines, one client |
| 3 | Monthly three-way reconciliation, discrepancies block | `reconcile()`, `validateSignoff()` (unbalanced cannot be signed) | `CHECK` balanced ⇒ three figures equal; period-close trigger requires balanced + signed |
| 4 | Default classification is trust | Only `cushion_deposit` accepts firm money; everything else is client money | `trust_transactions_shape_check` |
| 5 | Earned only against objective benchmarks | invoice id or earning basis required | shape CHECK |
| 6 | First-class disputed state | holds; `FUNDS_ON_HOLD` | `CHECK held_cents <= balance_cents`; hold triggers |
| 7 | Processing fees never netted | `PROCESSOR_FEE_NETTED`; bank fees only from cushion | line trigger: cushion kinds only on cushion ledger |
| 8 | Matter closure flags unearned balance | worker `closed_matter_funds` flag (refund itself is c82) | — |
| 9 | Five years post-closure, not configurable downward | gated rule value; firm may only lengthen; **nothing is ever deleted** | no DELETE grant + append-only triggers |
| 10 | Append-only, CI tripwire, hash chain | `hashChain.ts`; every reconciliation verifies the chain | REVOKE UPDATE/DELETE; append-only triggers; `prev_hash` link enforced |
| 11 | Unclaimed funds out of scope | not built | — |

## 3. Database enforcement under concurrency

CHECK constraints cannot see aggregates, so the design is a **locked running balance**:

1. The posting service takes `pg_advisory_xact_lock(hashtextextended('billing-trust:' || account_id, 0))` so only one posting per account plans at a time (the app role has no UPDATE grant, so it cannot `SELECT … FOR UPDATE`).
2. `BEFORE INSERT` on `trust_transactions` (SECURITY DEFINER) locks the book row `FOR UPDATE`, requires `sequence = last + 1` and `prev_hash = last_hash` (a stale concurrent plan fails with `serialization_failure`), rejects closed periods, validates reversals, and advances the chain head.
3. `BEFORE INSERT` on `trust_ledger_entries` locks book → sub-ledger (fixed lock order: no deadlocks), re-checks no-negative / held funds / cushion-only kinds, verifies the stated running balances, and updates both balances. `CHECK (balance >= 0)` is the last line of defence.
4. A `DEFERRABLE INITIALLY DEFERRED` constraint trigger at commit checks the aggregate invariants: lines = register amount, line count/shape per kind, transfers within one client, reversals exact, book = Σ sub-ledgers, cushion ≤ cap.
5. The balance tables are writable only from inside these triggers (`pg_trigger_depth() >= 2` guard + no UPDATE grant); new rows start at zero.
6. After inserting, the service re-reads the balances and rolls back if they are not exactly what it planned — so if the integration migration is missing the triggers, **nothing posts** (fail safe).

Exact SQL: MIGRATION NOTES at the bottom of `src/db/tables/billing-trust.ts`.

## 4. Gating, roles and audit

- Every posting/reversal calls `requireApproval("rules.trust_accounting")`. While pending, the attempt is audited (`approval.blocked`) and the API returns **423** with the visible placeholder. Previews (`?preview=1`), read-only views, statement entry and reconciliation preparation still work.
- Month close (sign-off) is gated the same way.
- Role check (local stand-in): owner (`firm_admin` or role label `owner`) and bookkeeper (role label `bookkeeper`) may post, hold, import and prepare; attorneys may read and sign as `lawyer`. Denials are audited (`trust.access_denied`); rule refusals are audited (`trust.transaction.refused`).
- Each posting stores the approvals of `rules.trust_accounting` in force at the time (`approval_evidence`).

## 5. Three-way reconciliation

For a calendar month, against that month's current statement:

1. **Bank:** closing balance + deposits in transit − outstanding checks/withdrawals = adjusted bank balance. Book items are matched to statement lines by exact amount and reference, or amount within a date window (deposits: 5 days; checks: 180 days — firm settings); several entries can be matched manually to one bank deposit. An entry and its reversal that never reached the bank clear together. IOLTA interest and its remittance to the Texas Access to Justice Foundation, when they net to zero, are a pass-through, never credited to a client (c75 §3).
2. **Book:** Σ register amounts dated on or before month end.
3. **Clients:** Σ every sub-ledger as of month end.

Every difference is itemised (unmatched bank line, unexplained residual, statement not footing or not matching the previous closing balance, negative client ledger at month end, stored vs recomputed balances, broken hash chain…). **Tolerance is zero.** An unbalanced reconciliation raises a critical internal flag to the owner and bookkeeper and cannot be signed. A balanced one closes the month once every required sign-off (default: bookkeeper + lawyer) is recorded against its exact report hash; months close in order; flags for that month are resolved with a reason. Reconciliations are exportable as CSV/JSON and never deleted.

A worker hook flags an account whose previous month is not closed `reconciliationDueDays` after month end.

## 6. Extension points (not built here)

- `invoice_id` on every entry (c79 adds the FK and invoice workflow).
- `retainerFloors` in the planner + `retainerFloorSplit()` (c50: pay from trust down to the floor, bill the rest).
- `BankFeedAdapter` interface (a real vendor after `vendor.billing-trust.bank_feed` is approved).
- Refund on matter closure (c82): the closed-matter flag is the trigger point.

## 7. Open questions for the attorney and CPA

1. Is a hard month-close (no back-dated entries into a closed month; corrections dated in the open month) the right treatment, and is bookkeeper + lawyer the right default sign-off pair?
2. Should overdue reconciliation block postings (c75 §13 q4) — currently it only raises a high flag?
3. Default matching windows (5 days deposits / 180 days checks) and the 90-day stale-item warning.
4. Bank-fee cushion: is it permitted for this firm/bank, and what cap is "reasonably sufficient"?
5. Should the first reconciled month require an opening-balance entry procedure for firms migrating an existing account (today: start the ledger in the first reconciled month)?
6. Hash chaining is implemented now; is recomputation at each reconciliation sufficient, or is an external anchor (e.g. periodic hash export) wanted?
