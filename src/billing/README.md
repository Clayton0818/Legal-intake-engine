# billing/

Domain logic for the Billing & trust engine (board cards c50, c52, c77, c78, c79, c81, c82). The specs live in `docs/product/features/billing-trust/`.

## What is here

| File | Card | What it does |
|---|---|---|
| `approvals.ts` | all | Compliance gates. Every gate starts **pending**. Anything that needs attorney or CPA sign-off calls `requireGates()` and throws `PendingApprovalError` until the gate is approved. |
| `copy.ts` | all | Client-facing wording. **Placeholders only.** `approvedClientCopy()` refuses to return text until the firm's attorney-reviewed wording is configured and the `client_copy_billing` gate is approved. |
| `money.ts`, `calendar.ts`, `settings.ts` | all | Integer-cent money, calendar/business-day dates, firm settings with defaults ($4,500 floor, 0.1 h increments, etc.). |
| `retainerFloor.ts` | c50 | `planTrustPayment()` pays an invoice from trust only down to the floor and raises flags. `executeTrustPayment()` is a gated placeholder. |
| `feeArrangements.ts` | c52 | Fixed-fee pay schedules, earning milestones, earned-vs-unearned split. `executeEarnedTransfer()` is a gated placeholder. |
| `timeEntries.ts` | c77 | Timers, rounding to increments, AI suggestions, lawyer approval, screened-matter block. |
| `expenses.ts` | c78 | Costs, mileage, markup (gated, 0 by default), receipts. `payExpenseFromTrust()` is a gated placeholder. |
| `invoices.ts` | c79 | Draft bill from approved items, write-downs, lawyer approval, numbering, voids (never delete). |
| `receivables.ts` | c81, c52 | Aging buckets, reminder dates on firm business days, missed installments. |
| `closeout.ts` | c82 | Unearned-funds calculation, holds, closing gate, refund approval. `executeRefund()` is a gated placeholder. |
| `schema.proposed.ts` | all | **Proposed** Drizzle tables. Not read by `drizzle.config.ts`, so no migration is generated until the data-model card adopts them. |

## Placeholders: what is deliberately not live

1. **Every movement of trust money** (draw for an invoice, earned fixed-fee transfer, cost paid from trust, refund) throws `PendingApprovalError` until gates `trust_rules_c75` and `trust_ledger_c76` plus the card's own gate are approved by a licensed Texas attorney **and** a CPA.
2. **Client-facing wording** is placeholder text that can never be sent.
3. **Cost markup** is forced to 0 until the `cost_markup_disclosure_c78` gate is approved and the matter's engagement agreement allows it.
4. **Mileage rate** and **fixed-fee amounts** have no product default; the firm sets them.
5. **Time rounding** defaults to "up" to the next increment, marked as an open decision for Clayton and the reviewing attorney.

Approving a gate is a reviewed PR that edits `COMPLIANCE_GATES` with the reviewer names, date and reference. Never a runtime switch.

## Not here yet

- Database access (wrapping these functions in `withTenant()` transactions), API routes and UI. They come after the data-model card adopts `schema.proposed.ts`.
- The trust ledger and three-way reconciliation (c76), payment processing (c80), accounting export (c83).

## Tests

`npx vitest run src/billing` runs the unit tests; they need no database.
