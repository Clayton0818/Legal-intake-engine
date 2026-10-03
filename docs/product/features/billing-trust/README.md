# Billing & trust engine

Engine slug `billing-trust` · board cards `c50`, `c52`, `c75`–`c83` · see `src/engines/README.md` for the engine contract.

**Status:** `c75` (trust-accounting / IOLTA compliance review) is merged as a research draft. `c76` (trust ledger + monthly three-way reconciliation) is built behind approval gates: **no trust money can be posted until a licensed Texas attorney AND a CPA approve `rules.trust_accounting`**. Everything here is research and a recommended approach, not legal or accounting advice.

| Card | What | State |
|---|---|---|
| c75 | Trust accounting compliance review | Draft merged — `docs/compliance/trust-accounting-iolta-compliance-review.md` |
| c76 | Client trust ledger + monthly three-way reconciliation | Built, gated — [design doc](./c76-trust-ledger-design.md) |
| c50 | $4,500 retainer floor | Not started. c76 ships the floor-split helper and a planner hook (`retainerFloors`). |
| c52 | Fixed fee vs retainer, pay / earning schedules | Not started. Earned-fee transfers already require an invoice id or a stated earning benchmark. |
| c77–c83 | Time, invoices, payments, refunds, exports | Not started. Ledger entries carry an optional `invoice_id` for c79. |

## Where things live

- Domain (pure, tested): `src/engines/billing-trust/` — `ledger.ts` (rules), `reconciliation.ts` (three-way), `hashChain.ts`, `money.ts`, `rules.ts` (gated values, firm settings), `access.ts` (role check)
- Services (DB): `ledgerService.ts`, `reconciliationService.ts`; worker hooks: `worker.ts`
- Tables + required trigger SQL: `src/db/tables/billing-trust.ts` (MIGRATION NOTES)
- API: `src/app/api/billing-trust/**` · Admin: `/admin/billing-trust`

## Gates

| Gate | Reviewers | Blocks |
|---|---|---|
| `rules.trust_accounting` (shared) | attorney + CPA | every posting / reversal, every reconciliation sign-off (month close) |
| `rules.billing-trust.rule_values` | attorney + CPA | nothing directly — rule values (retention, cadence, tolerance) show as PROPOSED until approved |
| `rules.billing-trust.bank_fee_cushion` | attorney + CPA | any firm money into trust (the bank-fee cushion) |
| `vendor.billing-trust.bank_feed` | vendor DPA + CPA | pulling statements from a bank-feed vendor (stub adapter only) |

Firm settings (not gates), in `engineSettings['billing-trust']`: `reconciliationDueDays` (15), `depositToleranceDays` (5), `withdrawalClearDays` (180), `staleOutstandingDays` (90), `signoffRoles` (`["bookkeeper","lawyer"]`), `retentionYears` (only longer than the rule value).
