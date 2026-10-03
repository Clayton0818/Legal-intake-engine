// Tables owned by the Billing & trust engine (c50, c52, c75–c83). So far: c76,
// the client trust (IOLTA) ledger and monthly three-way reconciliation.
//
// Conventions (see ./foundation.ts): NOT NULL tenantId -> firms.id on every
// tenant-scoped table, text + CHECK for statuses, timestamptz for instants.
// Accounting dates (the day money moved, statement periods) are `date`.
// Money is ALWAYS integer cents in `bigint` (mode "bigint" → JS bigint);
// never numeric/float.
//
// Integrity model (compliance review c75 §11.10, scope memo §4):
//  - The journal (trust_transactions + trust_ledger_entries), holds, bank
//    statements, reconciliations, sign-offs and period closes are
//    APPEND-ONLY: app_runtime gets SELECT/INSERT only, plus triggers that
//    reject UPDATE/DELETE/TRUNCATE for every role. Corrections are new
//    reversing entries.
//  - Running balances live in trust_account_books (per account) and
//    trust_subledgers (per client-matter). app_runtime can NEVER update them:
//    they are maintained only by SECURITY DEFINER triggers on the journal,
//    which lock the rows, re-check every rule, and rely on CHECK
//    (balance >= 0, held <= balance) as the last line of defence.
//  - CHECK constraints cannot see aggregates, so the aggregate invariants
//    (book = Σ sub-ledgers; a transaction's lines match its kind and its
//    register amount; transfers stay within one client) are checked by a
//    DEFERRABLE constraint trigger at commit. The exact SQL is in
//    MIGRATION NOTES at the bottom of this file.
//  - Each transaction is hash-chained to the previous one in its account
//    (prev_hash/hash); the DB enforces the link, every reconciliation
//    recomputes the hashes (src/engines/billing-trust/hashChain.ts).

import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  bigint,
  integer,
  boolean,
  date,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { firms, users, matters, parties } from "../schema";

const cents = (name: string) => bigint(name, { mode: "bigint" });

// ---------------------------------------------------------------------------
// Trust bank accounts
// ---------------------------------------------------------------------------

/** A firm's trust bank account (IOLTA or a separate client trust account). */
export const trustAccounts = pgTable("trust_accounts", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  name: text("name").notNull(),
  bankName: text("bank_name").notNull(),
  /** Last four digits only — the full account number is never stored. */
  accountNumberLast4: text("account_number_last4").notNull(),
  /** 'iolta' (pooled, interest to the Texas Access to Justice Foundation) | 'trust' (separate client trust account). */
  accountType: text("account_type").notNull().default("iolta"),
  /** 'active' | 'closed'. */
  status: text("status").notNull().default("active"),
  openedOn: date("opened_on", { mode: "string" }).notNull(),
  closedOn: date("closed_on", { mode: "string" }),
  /**
   * Firm-configured maximum of firm money allowed in this account to cover
   * unavoidable bank fees (c75 §8). Usable only while the gate
   * 'rules.billing-trust.bank_fee_cushion' is approved. 0 = no cushion.
   */
  bankFeeCushionCapCents: cents("bank_fee_cushion_cap_cents").notNull().default(sql`0`),
  createdByUserId: uuid("created_by_user_id").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("trust_accounts_tenant_idx").on(t.tenantId, t.status),
  check("trust_accounts_type_check", sql`${t.accountType} in ('iolta','trust')`),
  check("trust_accounts_status_check", sql`${t.status} in ('active','closed')`),
  check("trust_accounts_last4_check", sql`${t.accountNumberLast4} ~ '^[0-9]{4}$'`),
  check("trust_accounts_cushion_check", sql`${t.bankFeeCushionCapCents} >= 0`),
  check("trust_accounts_closed_check", sql`(${t.status} = 'closed') = (${t.closedOn} is not null)`),
]);

/**
 * The account's book (check-register) balance, sequence and hash-chain head.
 * One row per account. Written ONLY by the journal triggers.
 */
export const trustAccountBooks = pgTable("trust_account_books", {
  trustAccountId: uuid("trust_account_id").primaryKey().references(() => trustAccounts.id),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  balanceCents: cents("balance_cents").notNull().default(sql`0`),
  lastSequence: integer("last_sequence").notNull().default(0),
  lastHash: text("last_hash"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("trust_account_books_tenant_idx").on(t.tenantId),
  check("trust_account_books_balance_check", sql`${t.balanceCents} >= 0`),
  check("trust_account_books_sequence_check", sql`${t.lastSequence} >= 0`),
]);

/**
 * One sub-ledger per client per matter per trust account (plus at most one
 * firm bank-fee cushion per account). Running balance and held (disputed)
 * amount are written ONLY by the journal / hold triggers.
 */
export const trustSubledgers = pgTable("trust_subledgers", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  trustAccountId: uuid("trust_account_id").notNull().references(() => trustAccounts.id),
  /** 'client_matter' | 'firm_cushion'. */
  kind: text("kind").notNull(),
  clientPartyId: uuid("client_party_id").references(() => parties.id),
  matterId: uuid("matter_id").references(() => matters.id),
  balanceCents: cents("balance_cents").notNull().default(sql`0`),
  heldCents: cents("held_cents").notNull().default(sql`0`),
  createdByUserId: uuid("created_by_user_id").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("trust_subledgers_client_matter_key")
    .on(t.tenantId, t.trustAccountId, t.clientPartyId, t.matterId)
    .where(sql`${t.kind} = 'client_matter'`),
  uniqueIndex("trust_subledgers_cushion_key").on(t.tenantId, t.trustAccountId).where(sql`${t.kind} = 'firm_cushion'`),
  index("trust_subledgers_tenant_matter_idx").on(t.tenantId, t.matterId),
  index("trust_subledgers_tenant_client_idx").on(t.tenantId, t.clientPartyId),
  check("trust_subledgers_kind_check", sql`${t.kind} in ('client_matter','firm_cushion')`),
  check(
    "trust_subledgers_owner_check",
    sql`(${t.kind} = 'client_matter' and ${t.clientPartyId} is not null and ${t.matterId} is not null)
      or (${t.kind} = 'firm_cushion' and ${t.clientPartyId} is null and ${t.matterId} is null)`
  ),
  // I1: never below zero. I2: held (disputed) money never exceeds the balance.
  check("trust_subledgers_balance_check", sql`${t.balanceCents} >= 0`),
  check("trust_subledgers_held_check", sql`${t.heldCents} >= 0 and ${t.heldCents} <= ${t.balanceCents}`),
]);

// ---------------------------------------------------------------------------
// The journal (append-only)
// ---------------------------------------------------------------------------

/** One journal entry (check-register line). Never updated or deleted. */
export const trustTransactions = pgTable("trust_transactions", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  trustAccountId: uuid("trust_account_id").notNull().references(() => trustAccounts.id),
  /** 1, 2, 3 … per account, gap-free (enforced by the trigger). */
  sequence: integer("sequence").notNull(),
  /** A TRANSACTION_KINDS value (src/engines/billing-trust/types.ts). */
  kind: text("kind").notNull(),
  /** The day the money moved. */
  effectiveDate: date("effective_date", { mode: "string" }).notNull(),
  /** Signed net effect on the account (= Σ lines; 0 for transfers). */
  netAmountCents: cents("net_amount_cents").notNull(),
  /** Why (required). Who and when are posted_by_user_id / posted_at. */
  reason: text("reason").notNull(),
  memo: text("memo"),
  /** Payee / payer. */
  counterparty: text("counterparty"),
  /** Check number, wire or deposit reference. */
  reference: text("reference"),
  /** 'client' | 'third_party' | 'firm_operating' (cushion only). */
  fundsSource: text("funds_source"),
  /** The invoice this entry pays. Extension point for c79 (FK added when invoices exist). */
  invoiceId: uuid("invoice_id"),
  /** Earned-fee transfers without an invoice: the earning benchmark that was met. */
  earnedBasis: text("earned_basis"),
  /** Set on a reversal: the entry it corrects. Unique — an entry is reversed at most once. */
  reversesTransactionId: uuid("reverses_transaction_id"),
  postedByUserId: uuid("posted_by_user_id").notNull().references(() => users.id),
  postedAt: timestamp("posted_at", { withTimezone: true }).notNull(),
  /** Approvals of 'rules.trust_accounting' in force when this was posted (evidence for an auditor). */
  approvalEvidence: jsonb("approval_evidence").$type<Record<string, unknown>[]>().notNull().default([]),
  prevHash: text("prev_hash"),
  hash: text("hash").notNull(),
}, (t) => [
  uniqueIndex("trust_transactions_sequence_key").on(t.tenantId, t.trustAccountId, t.sequence),
  uniqueIndex("trust_transactions_reverses_key").on(t.reversesTransactionId).where(sql`${t.reversesTransactionId} is not null`),
  index("trust_transactions_tenant_date_idx").on(t.tenantId, t.trustAccountId, t.effectiveDate),
  index("trust_transactions_tenant_invoice_idx").on(t.tenantId, t.invoiceId),
  check(
    "trust_transactions_kind_check",
    sql`${t.kind} in ('deposit','disbursement','earned_fee_transfer','refund','transfer','cushion_deposit','cushion_withdrawal','bank_fee','reversal')`
  ),
  check("trust_transactions_sequence_check", sql`${t.sequence} >= 1`),
  check("trust_transactions_reason_check", sql`length(btrim(${t.reason})) >= 3`),
  check("trust_transactions_funds_source_check", sql`${t.fundsSource} is null or ${t.fundsSource} in ('client','third_party','firm_operating')`),
  // Kind-specific shape (sign of the register amount, required fields, commingling).
  check(
    "trust_transactions_shape_check",
    sql`case ${t.kind}
      when 'deposit' then ${t.netAmountCents} > 0 and ${t.fundsSource} in ('client','third_party')
      when 'cushion_deposit' then ${t.netAmountCents} > 0 and ${t.fundsSource} = 'firm_operating'
      when 'disbursement' then ${t.netAmountCents} < 0 and ${t.counterparty} is not null and ${t.fundsSource} is null
      when 'earned_fee_transfer' then ${t.netAmountCents} < 0 and ${t.fundsSource} is null
        and (${t.invoiceId} is not null or length(btrim(coalesce(${t.earnedBasis}, ''))) > 0)
      when 'refund' then ${t.netAmountCents} < 0 and ${t.fundsSource} is null
      when 'cushion_withdrawal' then ${t.netAmountCents} < 0 and ${t.fundsSource} is null
      when 'bank_fee' then ${t.netAmountCents} < 0 and ${t.fundsSource} is null
      when 'transfer' then ${t.netAmountCents} = 0 and ${t.fundsSource} is null
      when 'reversal' then ${t.fundsSource} is null
      else false end`
  ),
  check("trust_transactions_reversal_check", sql`(${t.kind} = 'reversal') = (${t.reversesTransactionId} is not null)`),
  check("trust_transactions_hash_check", sql`${t.hash} ~ '^[0-9a-f]{64}$' and (${t.prevHash} is null or ${t.prevHash} ~ '^[0-9a-f]{64}$')`),
  check("trust_transactions_first_check", sql`(${t.sequence} = 1) = (${t.prevHash} is null)`),
]);

/** One line of a journal entry: the change to ONE sub-ledger, with running balances after it. */
export const trustLedgerEntries = pgTable("trust_ledger_entries", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  transactionId: uuid("transaction_id").notNull().references(() => trustTransactions.id),
  trustAccountId: uuid("trust_account_id").notNull().references(() => trustAccounts.id),
  subledgerId: uuid("subledger_id").notNull().references(() => trustSubledgers.id),
  lineNo: integer("line_no").notNull(),
  amountCents: cents("amount_cents").notNull(),
  /** The sub-ledger's running balance after this line (verified by the trigger). */
  balanceAfterCents: cents("balance_after_cents").notNull(),
  /** The account's book balance after this line (verified by the trigger). */
  bookBalanceAfterCents: cents("book_balance_after_cents").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("trust_ledger_entries_line_key").on(t.transactionId, t.lineNo),
  uniqueIndex("trust_ledger_entries_subledger_once_key").on(t.transactionId, t.subledgerId),
  index("trust_ledger_entries_tenant_subledger_idx").on(t.tenantId, t.subledgerId, t.createdAt),
  index("trust_ledger_entries_tenant_account_idx").on(t.tenantId, t.trustAccountId),
  check("trust_ledger_entries_amount_check", sql`${t.amountCents} <> 0`),
  check("trust_ledger_entries_line_check", sql`${t.lineNo} between 1 and 2`),
  check("trust_ledger_entries_balance_check", sql`${t.balanceAfterCents} >= 0 and ${t.bookBalanceAfterCents} >= 0`),
]);

// ---------------------------------------------------------------------------
// Disputed-funds holds (c75 §6, §11.6) — append-only
// ---------------------------------------------------------------------------

export const trustHolds = pgTable("trust_holds", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  trustAccountId: uuid("trust_account_id").notNull().references(() => trustAccounts.id),
  subledgerId: uuid("subledger_id").notNull().references(() => trustSubledgers.id),
  amountCents: cents("amount_cents").notNull(),
  reason: text("reason").notNull(),
  placedByUserId: uuid("placed_by_user_id").notNull().references(() => users.id),
  placedAt: timestamp("placed_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("trust_holds_tenant_subledger_idx").on(t.tenantId, t.subledgerId),
  check("trust_holds_amount_check", sql`${t.amountCents} > 0`),
  check("trust_holds_reason_check", sql`length(btrim(${t.reason})) >= 3`),
]);

export const trustHoldReleases = pgTable("trust_hold_releases", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  holdId: uuid("hold_id").notNull().references(() => trustHolds.id),
  reason: text("reason").notNull(),
  releasedByUserId: uuid("released_by_user_id").notNull().references(() => users.id),
  releasedAt: timestamp("released_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("trust_hold_releases_hold_key").on(t.holdId),
  index("trust_hold_releases_tenant_idx").on(t.tenantId),
  check("trust_hold_releases_reason_check", sql`length(btrim(${t.reason})) >= 3`),
]);

// ---------------------------------------------------------------------------
// Bank statements (entered, CSV-imported, or from a gated bank feed) — append-only
// ---------------------------------------------------------------------------

export const trustBankStatements = pgTable("trust_bank_statements", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  trustAccountId: uuid("trust_account_id").notNull().references(() => trustAccounts.id),
  /** 'YYYY-MM'. */
  period: text("period").notNull(),
  periodStart: date("period_start", { mode: "string" }).notNull(),
  periodEnd: date("period_end", { mode: "string" }).notNull(),
  /** Bank balances are facts as reported, so may be negative (an overdraft is itself a reportable problem). */
  openingBalanceCents: cents("opening_balance_cents").notNull(),
  closingBalanceCents: cents("closing_balance_cents").notNull(),
  /** 'manual' | 'csv_import' | 'bank_feed'. */
  source: text("source").notNull(),
  /** SHA-256 of the imported file / feed payload. */
  sourceSha256: text("source_sha256"),
  /** A corrected statement supersedes the earlier one (never edits it). */
  supersedesStatementId: uuid("supersedes_statement_id"),
  note: text("note"),
  enteredByUserId: uuid("entered_by_user_id").notNull().references(() => users.id),
  enteredAt: timestamp("entered_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("trust_bank_statements_tenant_period_idx").on(t.tenantId, t.trustAccountId, t.period),
  uniqueIndex("trust_bank_statements_supersedes_key").on(t.supersedesStatementId).where(sql`${t.supersedesStatementId} is not null`),
  check("trust_bank_statements_period_check", sql`${t.period} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
  check("trust_bank_statements_dates_check", sql`${t.periodEnd} >= ${t.periodStart}`),
  check("trust_bank_statements_source_check", sql`${t.source} in ('manual','csv_import','bank_feed')`),
]);

export const trustBankStatementLines = pgTable("trust_bank_statement_lines", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  statementId: uuid("statement_id").notNull().references(() => trustBankStatements.id),
  lineNo: integer("line_no").notNull(),
  postedOn: date("posted_on", { mode: "string" }).notNull(),
  amountCents: cents("amount_cents").notNull(),
  description: text("description").notNull(),
  reference: text("reference"),
  /** 'deposit' | 'withdrawal' | 'fee' | 'iolta_interest' | 'iolta_remittance' | 'other'. */
  kind: text("kind").notNull(),
}, (t) => [
  uniqueIndex("trust_bank_statement_lines_key").on(t.statementId, t.lineNo),
  index("trust_bank_statement_lines_tenant_idx").on(t.tenantId, t.statementId),
  check("trust_bank_statement_lines_amount_check", sql`${t.amountCents} <> 0`),
  check(
    "trust_bank_statement_lines_kind_check",
    sql`${t.kind} in ('deposit','withdrawal','fee','iolta_interest','iolta_remittance','other')`
  ),
]);

// ---------------------------------------------------------------------------
// Reconciliations, sign-offs and closed months — append-only, kept for good
// ---------------------------------------------------------------------------

/** Every prepared three-way reconciliation, balanced or not. Never updated; a re-run supersedes. */
export const trustReconciliations = pgTable("trust_reconciliations", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  trustAccountId: uuid("trust_account_id").notNull().references(() => trustAccounts.id),
  period: text("period").notNull(),
  periodEnd: date("period_end", { mode: "string" }).notNull(),
  statementId: uuid("statement_id").notNull().references(() => trustBankStatements.id),
  /** 'balanced' | 'unbalanced'. */
  status: text("status").notNull(),
  bankClosingBalanceCents: cents("bank_closing_balance_cents").notNull(),
  adjustedBankBalanceCents: cents("adjusted_bank_balance_cents").notNull(),
  bookBalanceCents: cents("book_balance_cents").notNull(),
  clientLedgerTotalCents: cents("client_ledger_total_cents").notNull(),
  depositsInTransitCents: cents("deposits_in_transit_cents").notNull(),
  outstandingWithdrawalsCents: cents("outstanding_withdrawals_cents").notNull(),
  /** Itemised differences (Difference[] with amounts as strings). */
  differences: jsonb("differences").$type<Record<string, unknown>[]>().notNull().default([]),
  /** The full worksheet (ReconciliationReport, JSON-safe). */
  worksheet: jsonb("worksheet").$type<Record<string, unknown>>().notNull(),
  /** SHA-256 of the worksheet; sign-offs record the hash they signed. */
  reportHash: text("report_hash").notNull(),
  throughSequence: integer("through_sequence").notNull(),
  supersedesReconciliationId: uuid("supersedes_reconciliation_id"),
  /** Whether 'rules.trust_accounting' was approved when this was prepared. */
  rulesApproved: boolean("rules_approved").notNull(),
  preparedByUserId: uuid("prepared_by_user_id").notNull().references(() => users.id),
  preparedAt: timestamp("prepared_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("trust_reconciliations_tenant_period_idx").on(t.tenantId, t.trustAccountId, t.period, t.preparedAt),
  uniqueIndex("trust_reconciliations_supersedes_key")
    .on(t.supersedesReconciliationId)
    .where(sql`${t.supersedesReconciliationId} is not null`),
  check("trust_reconciliations_status_check", sql`${t.status} in ('balanced','unbalanced')`),
  check("trust_reconciliations_period_check", sql`${t.period} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
  // A reconciliation can only be 'balanced' when the three figures agree.
  check(
    "trust_reconciliations_balanced_check",
    sql`${t.status} <> 'balanced' or (${t.adjustedBankBalanceCents} = ${t.bookBalanceCents} and ${t.bookBalanceCents} = ${t.clientLedgerTotalCents})`
  ),
  check("trust_reconciliations_hash_check", sql`${t.reportHash} ~ '^[0-9a-f]{64}$'`),
]);

export const trustReconciliationSignoffs = pgTable("trust_reconciliation_signoffs", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  reconciliationId: uuid("reconciliation_id").notNull().references(() => trustReconciliations.id),
  /** 'bookkeeper' | 'lawyer'. */
  signoffRole: text("signoff_role").notNull(),
  userId: uuid("user_id").notNull().references(() => users.id),
  /** Must equal the reconciliation's report_hash: what was signed is exactly what is stored. */
  reportHash: text("report_hash").notNull(),
  note: text("note"),
  signedAt: timestamp("signed_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("trust_reconciliation_signoffs_role_key").on(t.reconciliationId, t.signoffRole),
  index("trust_reconciliation_signoffs_tenant_idx").on(t.tenantId),
  check("trust_reconciliation_signoffs_role_check", sql`${t.signoffRole} in ('bookkeeper','lawyer')`),
]);

/** A month closed by a balanced, fully signed-off reconciliation. Nothing may be posted on or before period_end afterwards. */
export const trustPeriodCloses = pgTable("trust_period_closes", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  trustAccountId: uuid("trust_account_id").notNull().references(() => trustAccounts.id),
  period: text("period").notNull(),
  periodEnd: date("period_end", { mode: "string" }).notNull(),
  reconciliationId: uuid("reconciliation_id").notNull().references(() => trustReconciliations.id),
  closedByUserId: uuid("closed_by_user_id").notNull().references(() => users.id),
  closedAt: timestamp("closed_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("trust_period_closes_period_key").on(t.tenantId, t.trustAccountId, t.period),
  uniqueIndex("trust_period_closes_reconciliation_key").on(t.reconciliationId),
  index("trust_period_closes_tenant_end_idx").on(t.tenantId, t.trustAccountId, t.periodEnd),
]);

// ---------------------------------------------------------------------------
// MIGRATION NOTES for the integration step (hand-add to the generated SQL).
// These are REQUIRED: the engine's posting service verifies after every
// insert that the triggers below moved the balances, and refuses (rolls
// back) if they are missing — so a migration without them fails safe (nothing
// posts) rather than silently unsafe.
//
// 1. RLS + the standard tenant_isolation policy (same text as migrations/0000)
//    on every table in this file:
//      trust_accounts, trust_account_books, trust_subledgers,
//      trust_transactions, trust_ledger_entries, trust_holds,
//      trust_hold_releases, trust_bank_statements, trust_bank_statement_lines,
//      trust_reconciliations, trust_reconciliation_signoffs, trust_period_closes.
//
// 2. GRANTs (staging grants S/I/U/D by default — these REVOKEs are mandatory):
//      -- append-only
//      REVOKE UPDATE, DELETE, TRUNCATE ON trust_transactions, trust_ledger_entries,
//        trust_holds, trust_hold_releases, trust_bank_statements,
//        trust_bank_statement_lines, trust_reconciliations,
//        trust_reconciliation_signoffs, trust_period_closes FROM app_runtime;
//      GRANT SELECT, INSERT ON (the same nine tables) TO app_runtime;
//      -- balances: trigger-maintained only
//      REVOKE UPDATE, DELETE, TRUNCATE ON trust_account_books, trust_subledgers FROM app_runtime;
//      GRANT SELECT ON trust_account_books, trust_subledgers TO app_runtime;
//      GRANT INSERT (trust_account_id, tenant_id) ON trust_account_books TO app_runtime;
//      GRANT INSERT (id, tenant_id, trust_account_id, kind, client_party_id, matter_id, created_by_user_id)
//        ON trust_subledgers TO app_runtime;
//      -- accounts: no delete; balances are not on this table
//      REVOKE DELETE, TRUNCATE ON trust_accounts FROM app_runtime;
//      GRANT SELECT, INSERT ON trust_accounts TO app_runtime;
//      GRANT UPDATE (name, bank_fee_cushion_cap_cents, updated_at) ON trust_accounts TO app_runtime;
//    The posting service serialises per account with
//    pg_advisory_xact_lock(hashtextextended('billing-trust:' || account_id, 0))
//    (no UPDATE grant needed); the triggers take the real row locks.
//
// 3. Functions and triggers. All SECURITY DEFINER functions are owned by the
//    migrations role, `SET search_path = public, pg_temp`, and re-check the
//    tenant explicitly (they bypass RLS):
//
//    -- 3a. append-only guard (every role, incl. the owner by mistake)
//    CREATE FUNCTION billing_trust_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
//    BEGIN RAISE EXCEPTION 'billing-trust: % is append-only (corrections are reversing entries)', TG_TABLE_NAME
//      USING ERRCODE = 'check_violation'; END $$;
//    -- for each of the nine append-only tables:
//    CREATE TRIGGER <table>_append_only BEFORE UPDATE OR DELETE ON <table>
//      FOR EACH ROW EXECUTE FUNCTION billing_trust_append_only();
//    CREATE TRIGGER <table>_no_truncate BEFORE TRUNCATE ON <table>
//      FOR EACH STATEMENT EXECUTE FUNCTION billing_trust_append_only();
//
//    -- 3b. balances only change from inside a journal trigger; new rows start at zero
//    CREATE FUNCTION billing_trust_balance_guard() RETURNS trigger LANGUAGE plpgsql AS $$
//    BEGIN
//      IF TG_OP = 'INSERT' THEN
//        IF TG_TABLE_NAME = 'trust_subledgers' THEN NEW.balance_cents := 0; NEW.held_cents := 0;
//        ELSE NEW.balance_cents := 0; NEW.last_sequence := 0; NEW.last_hash := NULL; END IF;
//        RETURN NEW;
//      END IF;
//      IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'billing-trust: % rows are never deleted', TG_TABLE_NAME; END IF;
//      IF pg_trigger_depth() < 2 THEN
//        RAISE EXCEPTION 'billing-trust: % is maintained only by the ledger triggers', TG_TABLE_NAME;
//      END IF;
//      IF NEW.tenant_id <> OLD.tenant_id THEN RAISE EXCEPTION 'billing-trust: tenant cannot change'; END IF;
//      RETURN NEW;
//    END $$;
//    CREATE TRIGGER trust_subledgers_guard BEFORE INSERT OR UPDATE OR DELETE ON trust_subledgers
//      FOR EACH ROW EXECUTE FUNCTION billing_trust_balance_guard();
//    CREATE TRIGGER trust_account_books_guard BEFORE INSERT OR UPDATE OR DELETE ON trust_account_books
//      FOR EACH ROW EXECUTE FUNCTION billing_trust_balance_guard();
//    -- plus a BEFORE INSERT check on trust_subledgers that client_party_id is the matter's
//    -- primary_party_id or a matter_parties row with role 'client' for that matter (same tenant).
//
//    -- 3c. journal header: sequence, hash link, account active, closed periods
//    CREATE FUNCTION billing_trust_tx_before_insert() RETURNS trigger LANGUAGE plpgsql
//      SECURITY DEFINER SET search_path = public, pg_temp AS $$
//    DECLARE b trust_account_books%ROWTYPE; a trust_accounts%ROWTYPE; orig trust_transactions%ROWTYPE;
//    BEGIN
//      IF NEW.tenant_id::text <> current_setting('app.tenant_id', true) THEN
//        RAISE EXCEPTION 'billing-trust: tenant mismatch'; END IF;
//      SELECT * INTO a FROM trust_accounts WHERE id = NEW.trust_account_id AND tenant_id = NEW.tenant_id;
//      IF NOT FOUND OR a.status <> 'active' THEN RAISE EXCEPTION 'billing-trust: account not active'; END IF;
//      SELECT * INTO b FROM trust_account_books WHERE trust_account_id = NEW.trust_account_id FOR UPDATE;
//      IF NOT FOUND THEN RAISE EXCEPTION 'billing-trust: account has no book row'; END IF;
//      IF NEW.sequence <> b.last_sequence + 1 OR NEW.prev_hash IS DISTINCT FROM b.last_hash THEN
//        RAISE EXCEPTION 'billing-trust: stale sequence/hash (concurrent posting)' USING ERRCODE = 'serialization_failure';
//      END IF;
//      IF NEW.effective_date > (now() AT TIME ZONE 'UTC')::date + 1 THEN
//        RAISE EXCEPTION 'billing-trust: entry dated in the future'; END IF;
//      IF EXISTS (SELECT 1 FROM trust_period_closes c WHERE c.trust_account_id = NEW.trust_account_id
//                 AND c.period_end >= NEW.effective_date) THEN
//        RAISE EXCEPTION 'billing-trust: period is closed'; END IF;
//      IF NEW.posted_at > now() + interval '5 minutes' THEN RAISE EXCEPTION 'billing-trust: posted_at in the future'; END IF;
//      IF NEW.reverses_transaction_id IS NOT NULL THEN
//        SELECT * INTO orig FROM trust_transactions WHERE id = NEW.reverses_transaction_id;
//        IF NOT FOUND OR orig.trust_account_id <> NEW.trust_account_id OR orig.tenant_id <> NEW.tenant_id
//           OR orig.kind = 'reversal' OR NEW.net_amount_cents <> -orig.net_amount_cents THEN
//          RAISE EXCEPTION 'billing-trust: invalid reversal'; END IF;
//      END IF;
//      UPDATE trust_account_books SET last_sequence = NEW.sequence, last_hash = NEW.hash, updated_at = now()
//        WHERE trust_account_id = NEW.trust_account_id;
//      RETURN NEW;
//    END $$;
//    CREATE TRIGGER trust_transactions_before_insert BEFORE INSERT ON trust_transactions
//      FOR EACH ROW EXECUTE FUNCTION billing_trust_tx_before_insert();
//
//    -- 3d. each line: lock the sub-ledger, re-check the rules, move both balances
//    CREATE FUNCTION billing_trust_entry_before_insert() RETURNS trigger LANGUAGE plpgsql
//      SECURITY DEFINER SET search_path = public, pg_temp AS $$
//    DECLARE t trust_transactions%ROWTYPE; s trust_subledgers%ROWTYPE; b trust_account_books%ROWTYPE;
//            new_bal bigint; new_book bigint;
//    BEGIN
//      SELECT * INTO t FROM trust_transactions WHERE id = NEW.transaction_id;
//      IF NOT FOUND OR t.tenant_id <> NEW.tenant_id OR t.trust_account_id <> NEW.trust_account_id THEN
//        RAISE EXCEPTION 'billing-trust: line does not match its transaction'; END IF;
//      -- lock order is always book -> sub-ledger (the header trigger already holds the book lock)
//      SELECT * INTO b FROM trust_account_books WHERE trust_account_id = NEW.trust_account_id FOR UPDATE;
//      SELECT * INTO s FROM trust_subledgers WHERE id = NEW.subledger_id FOR UPDATE;
//      IF NOT FOUND OR s.tenant_id <> NEW.tenant_id OR s.trust_account_id <> NEW.trust_account_id THEN
//        RAISE EXCEPTION 'billing-trust: sub-ledger not in this account'; END IF;
//      -- the firm cushion only takes cushion kinds; client ledgers never do
//      IF (s.kind = 'firm_cushion') <> (t.kind IN ('cushion_deposit','cushion_withdrawal','bank_fee')
//           OR (t.kind = 'reversal' AND s.kind = 'firm_cushion')) THEN
//        RAISE EXCEPTION 'billing-trust: % cannot post to a % ledger', t.kind, s.kind USING ERRCODE = 'check_violation';
//      END IF;
//      new_bal := s.balance_cents + NEW.amount_cents;
//      IF new_bal < 0 THEN RAISE EXCEPTION 'billing-trust: ledger would go below zero' USING ERRCODE = 'check_violation'; END IF;
//      IF NEW.amount_cents < 0 AND new_bal < s.held_cents THEN
//        RAISE EXCEPTION 'billing-trust: funds are held for a dispute' USING ERRCODE = 'check_violation'; END IF;
//      new_book := b.balance_cents + NEW.amount_cents;
//      IF NEW.balance_after_cents <> new_bal OR NEW.book_balance_after_cents <> new_book THEN
//        RAISE EXCEPTION 'billing-trust: stated running balances are wrong'; END IF;
//      UPDATE trust_subledgers SET balance_cents = new_bal, updated_at = now() WHERE id = s.id;
//      UPDATE trust_account_books SET balance_cents = new_book, updated_at = now() WHERE trust_account_id = b.trust_account_id;
//      RETURN NEW;
//    END $$;
//    CREATE TRIGGER trust_ledger_entries_before_insert BEFORE INSERT ON trust_ledger_entries
//      FOR EACH ROW EXECUTE FUNCTION billing_trust_entry_before_insert();
//
//    -- 3e. aggregate invariants at COMMIT (CHECKs cannot see aggregates)
//    CREATE FUNCTION billing_trust_tx_check() RETURNS trigger LANGUAGE plpgsql
//      SECURITY DEFINER SET search_path = public, pg_temp AS $$
//    DECLARE n int; total bigint; clients int; book bigint; ledgers bigint; orig_lines int; mismatched int;
//    BEGIN
//      SELECT count(*), coalesce(sum(e.amount_cents), 0), count(DISTINCT s.client_party_id)
//        INTO n, total, clients
//        FROM trust_ledger_entries e JOIN trust_subledgers s ON s.id = e.subledger_id
//        WHERE e.transaction_id = NEW.id;
//      IF n = 0 OR total <> NEW.net_amount_cents THEN
//        RAISE EXCEPTION 'billing-trust: transaction % lines do not match its amount', NEW.id; END IF;
//      IF NEW.kind = 'transfer' THEN
//        -- exactly two lines, both client ledgers of ONE client (one client's money never covers another's)
//        IF n <> 2 OR clients <> 1 OR EXISTS (SELECT 1 FROM trust_ledger_entries e JOIN trust_subledgers s ON s.id = e.subledger_id
//             WHERE e.transaction_id = NEW.id AND s.kind <> 'client_matter') THEN
//          RAISE EXCEPTION 'billing-trust: transfers are between two matters of the same client'; END IF;
//      ELSIF NEW.kind = 'reversal' THEN
//        -- exact negation of the original, line for line
//        SELECT count(*) INTO orig_lines FROM trust_ledger_entries WHERE transaction_id = NEW.reverses_transaction_id;
//        SELECT count(*) INTO mismatched FROM trust_ledger_entries o
//          LEFT JOIN trust_ledger_entries r ON r.transaction_id = NEW.id AND r.subledger_id = o.subledger_id
//          WHERE o.transaction_id = NEW.reverses_transaction_id AND (r.id IS NULL OR r.amount_cents <> -o.amount_cents);
//        IF orig_lines <> n OR mismatched > 0 THEN RAISE EXCEPTION 'billing-trust: reversal is not exact'; END IF;
//      ELSIF n <> 1 THEN
//        RAISE EXCEPTION 'billing-trust: % has exactly one line', NEW.kind;
//      END IF;
//      -- I3: book balance = Σ sub-ledgers for the account
//      SELECT balance_cents INTO book FROM trust_account_books WHERE trust_account_id = NEW.trust_account_id;
//      SELECT coalesce(sum(balance_cents), 0) INTO ledgers FROM trust_subledgers WHERE trust_account_id = NEW.trust_account_id;
//      IF book <> ledgers THEN RAISE EXCEPTION 'billing-trust: book % <> sum of ledgers %', book, ledgers; END IF;
//      -- I5: the cushion never exceeds the firm's cap
//      IF NEW.kind = 'cushion_deposit' AND EXISTS (SELECT 1 FROM trust_subledgers s JOIN trust_accounts a ON a.id = s.trust_account_id
//           WHERE s.trust_account_id = NEW.trust_account_id AND s.kind = 'firm_cushion' AND s.balance_cents > a.bank_fee_cushion_cap_cents) THEN
//        RAISE EXCEPTION 'billing-trust: cushion above cap'; END IF;
//      RETURN NULL;
//    END $$;
//    CREATE CONSTRAINT TRIGGER trust_transactions_check AFTER INSERT ON trust_transactions
//      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION billing_trust_tx_check();
//
//    -- 3f. holds move held_cents (CHECK held <= balance does the rest)
//    CREATE FUNCTION billing_trust_hold_after_insert() RETURNS trigger LANGUAGE plpgsql
//      SECURITY DEFINER SET search_path = public, pg_temp AS $$
//    DECLARE h trust_holds%ROWTYPE;
//    BEGIN
//      IF TG_TABLE_NAME = 'trust_holds' THEN
//        PERFORM 1 FROM trust_account_books WHERE trust_account_id = NEW.trust_account_id FOR UPDATE;
//        UPDATE trust_subledgers SET held_cents = held_cents + NEW.amount_cents, updated_at = now()
//          WHERE id = NEW.subledger_id AND tenant_id = NEW.tenant_id AND trust_account_id = NEW.trust_account_id
//            AND kind = 'client_matter';
//        IF NOT FOUND THEN RAISE EXCEPTION 'billing-trust: hold on an unknown or non-client ledger'; END IF;
//      ELSE
//        SELECT * INTO h FROM trust_holds WHERE id = NEW.hold_id AND tenant_id = NEW.tenant_id;
//        IF NOT FOUND THEN RAISE EXCEPTION 'billing-trust: unknown hold'; END IF;
//        PERFORM 1 FROM trust_account_books WHERE trust_account_id = h.trust_account_id FOR UPDATE;
//        UPDATE trust_subledgers SET held_cents = held_cents - h.amount_cents, updated_at = now() WHERE id = h.subledger_id;
//      END IF;
//      RETURN NULL;
//    END $$;
//    CREATE TRIGGER trust_holds_after_insert AFTER INSERT ON trust_holds
//      FOR EACH ROW EXECUTE FUNCTION billing_trust_hold_after_insert();
//    CREATE TRIGGER trust_hold_releases_after_insert AFTER INSERT ON trust_hold_releases
//      FOR EACH ROW EXECUTE FUNCTION billing_trust_hold_after_insert();
//
//    -- 3g. statements foot (opening + Σ lines = closing), checked at commit
//    CREATE CONSTRAINT TRIGGER trust_bank_statements_foot AFTER INSERT ON trust_bank_statements
//      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION billing_trust_statement_foot();
//    --   (raises unless NEW.opening_balance_cents + coalesce(Σ lines.amount_cents,0) = NEW.closing_balance_cents
//    --    and every line's posted_on is between period_start and period_end)
//
//    -- 3h. a month closes only on a balanced reconciliation that has at least one sign-off whose
//    --     report_hash matches, in order (no gap after the previous close):
//    CREATE TRIGGER trust_period_closes_before_insert BEFORE INSERT ON trust_period_closes
//      FOR EACH ROW EXECUTE FUNCTION billing_trust_period_close_check();
//    --   (raises unless the reconciliation is same tenant/account/period, status = 'balanced',
//    --    not superseded, has >= 1 matching sign-off, and no later close exists for the account)
//    --   and on trust_reconciliation_signoffs BEFORE INSERT: report_hash = the reconciliation's
//    --   report_hash and the reconciliation's status = 'balanced'.
//
// 4. CI tripwire (c75 §11.10, mirroring c6): a test against the migrated
//    database asserting app_runtime has no UPDATE/DELETE on the append-only
//    tables and no UPDATE on the two balance tables (has_table_privilege /
//    has_column_privilege). src/engines/billing-trust/trust.db.test.ts checks
//    the triggers' behaviour.
//
// 5. trust_transactions.reverses_transaction_id, trust_bank_statements.
//    supersedes_statement_id and trust_reconciliations.supersedes_reconciliation_id
//    are plain uuids (self-references): add FKs by hand if wanted.
//    trust_transactions.invoice_id gets its FK when the invoices table (c79) exists.
// ---------------------------------------------------------------------------
