// PROPOSED tables for the Billing & trust engine (c50, c52, c77, c78, c79,
// c81, c82). NOT part of the live schema: drizzle.config.ts only reads
// src/db/schema.ts, so nothing here generates a migration. The
// case-management data-model extension card (scope memo §6 item 3) adopts
// these into src/db/schema.ts, adds RLS policies (ADR-0001 D5) and the
// INSERT/SELECT-only grants noted below, and reviews the generated SQL.
//
// The trust ledger itself (`trust_ledger_entries`, three-way reconciliation)
// belongs to c76 and is intentionally NOT defined here: it is gated on the
// c75 attorney + CPA review. Columns below that point at trust money are
// references only.

import { sql } from "drizzle-orm";
import { pgTable, uuid, text, boolean, integer, bigint, date, timestamp, jsonb, numeric, unique, index, check } from "drizzle-orm/pg-core";
import { firms, matters, users, parties, documents } from "@/db/schema";

const money = (name: string) => bigint(name, { mode: "number" }); // integer cents

// c52 + c50 ---------------------------------------------------------------

export const feeArrangements = pgTable("fee_arrangements", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  matterId: uuid("matter_id").notNull().references(() => matters.id),
  version: integer("version").notNull(),
  type: text("type").notNull(), // 'fixed_fee' | 'retainer'
  templateKey: text("template_key"), // practice area + matter type template used
  totalCents: money("total_cents"), // fixed fee only
  hourlyRateOverrideCents: money("hourly_rate_override_cents"),
  retainerFloorCents: money("retainer_floor_cents"), // c50, retainer only
  retainerEarlyWarningCents: money("retainer_early_warning_cents"),
  floorAgreedInEngagement: boolean("floor_agreed_in_engagement").notNull().default(false),
  engagementDocumentId: uuid("engagement_document_id").references(() => documents.id), // c39
  signedAt: timestamp("signed_at", { withTimezone: true }),
  supersededAt: timestamp("superseded_at", { withTimezone: true }),
  createdByUserId: uuid("created_by_user_id").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("fee_arrangements_matter_version_key").on(t.matterId, t.version),
  check("fee_arrangements_type_check", sql`${t.type} in ('fixed_fee','retainer')`),
]);

export const payScheduleLines = pgTable("pay_schedule_lines", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  feeArrangementId: uuid("fee_arrangement_id").notNull().references(() => feeArrangements.id),
  seq: integer("seq").notNull(),
  kind: text("kind").notNull(), // 'upfront' | 'installment'
  dueDate: date("due_date").notNull(),
  amountCents: money("amount_cents").notNull(),
  paidCents: money("paid_cents").notNull().default(0),
  invoiceId: uuid("invoice_id"),
}, (t) => [unique("pay_schedule_lines_arrangement_seq_key").on(t.feeArrangementId, t.seq)]);

export const earningMilestones = pgTable("earning_milestones", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  feeArrangementId: uuid("fee_arrangement_id").notNull().references(() => feeArrangements.id),
  key: text("key").notNull(),
  label: text("label").notNull(),
  amountCents: money("amount_cents").notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  completedByUserId: uuid("completed_by_user_id").references(() => users.id),
}, (t) => [unique("earning_milestones_arrangement_key").on(t.feeArrangementId, t.key)]);

// c77 ---------------------------------------------------------------------

export const timeEntries = pgTable("time_entries", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  matterId: uuid("matter_id").notNull().references(() => matters.id),
  userId: uuid("user_id").notNull().references(() => users.id),
  workDate: date("work_date").notNull(),
  rawMinutes: numeric("raw_minutes", { precision: 8, scale: 2 }).notNull(),
  billedMinutes: integer("billed_minutes").notNull(),
  billable: boolean("billable").notNull().default(true),
  activityCode: text("activity_code").notNull(),
  description: text("description").notNull(),
  rateCents: money("rate_cents").notNull(),
  source: text("source").notNull(), // 'timer' | 'manual' | 'ai_suggestion'
  suggestionOrigin: jsonb("suggestion_origin"),
  status: text("status").notNull().default("draft"),
  approvedByUserId: uuid("approved_by_user_id").references(() => users.id),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  invoiceId: uuid("invoice_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("time_entries_matter_status_idx").on(t.tenantId, t.matterId, t.status),
  check("time_entries_status_check", sql`${t.status} in ('suggested','draft','approved','billed','rejected')`),
]);

export const runningTimers = pgTable("running_timers", {
  userId: uuid("user_id").primaryKey().references(() => users.id), // one running timer per user
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  matterId: uuid("matter_id").notNull().references(() => matters.id),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  accumulatedMinutes: numeric("accumulated_minutes", { precision: 8, scale: 2 }).notNull().default("0"),
});

// c78 ---------------------------------------------------------------------

export const expenses = pgTable("expenses", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  matterId: uuid("matter_id").notNull().references(() => matters.id),
  category: text("category").notNull(),
  incurredOn: date("incurred_on").notNull(),
  description: text("description").notNull(),
  costCents: money("cost_cents").notNull(),
  miles: numeric("miles", { precision: 8, scale: 1 }),
  billable: boolean("billable").notNull().default(true),
  paidFrom: text("paid_from").notNull(), // 'firm_operating' | 'client_trust' | 'client_direct'
  receiptDocumentId: uuid("receipt_document_id").references(() => documents.id),
  markupBasisPoints: integer("markup_basis_points").notNull().default(0),
  status: text("status").notNull().default("draft"),
  enteredByUserId: uuid("entered_by_user_id").notNull().references(() => users.id),
  approvedByUserId: uuid("approved_by_user_id").references(() => users.id),
  invoiceId: uuid("invoice_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("expenses_paid_from_check", sql`${t.paidFrom} in ('firm_operating','client_trust','client_direct')`),
  check("expenses_cost_positive", sql`${t.costCents} > 0`),
]);

// c79 ---------------------------------------------------------------------
// Grants: app_runtime gets no DELETE on invoices/invoice_lines (void, never delete).

export const invoices = pgTable("invoices", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  matterId: uuid("matter_id").notNull().references(() => matters.id),
  clientPartyId: uuid("client_party_id").notNull().references(() => parties.id),
  number: text("number"),
  status: text("status").notNull().default("draft"),
  billingMode: text("billing_mode").notNull(),
  issueDate: date("issue_date"),
  dueDate: date("due_date"),
  subtotalCents: money("subtotal_cents").notNull().default(0),
  writeDownCents: money("write_down_cents").notNull().default(0),
  totalCents: money("total_cents").notNull().default(0),
  paidCents: money("paid_cents").notNull().default(0),
  disputedCents: money("disputed_cents").notNull().default(0),
  trustAppliedCents: money("trust_applied_cents").notNull().default(0),
  trustBalanceAfterCents: money("trust_balance_after_cents"),
  responsibleLawyerId: uuid("responsible_lawyer_id").notNull().references(() => users.id),
  approvedByUserId: uuid("approved_by_user_id").references(() => users.id),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  voidReason: text("void_reason"),
  voidedByUserId: uuid("voided_by_user_id").references(() => users.id),
  remindersPaused: boolean("reminders_paused").notNull().default(false), // c81
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("invoices_tenant_number_key").on(t.tenantId, t.number),
  index("invoices_tenant_status_due_idx").on(t.tenantId, t.status, t.dueDate),
  check("invoices_status_check", sql`${t.status} in ('draft','approved','sent','partially_paid','paid','void')`),
]);

export const invoiceLines = pgTable("invoice_lines", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  invoiceId: uuid("invoice_id").notNull().references(() => invoices.id),
  kind: text("kind").notNull(),
  sourceId: uuid("source_id"),
  description: text("description").notNull(),
  quantity: numeric("quantity", { precision: 10, scale: 2 }).notNull(),
  unitCents: money("unit_cents").notNull(),
  amountCents: money("amount_cents").notNull(),
});

/** Gap-free per-tenant invoice sequence; the row is locked FOR UPDATE when a number is taken. */
export const invoiceNumberCounters = pgTable("invoice_number_counters", {
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  year: integer("year").notNull(),
  lastSeq: integer("last_seq").notNull().default(0),
}, (t) => [unique("invoice_number_counters_key").on(t.tenantId, t.year)]);

// c82 ---------------------------------------------------------------------

export const trustHolds = pgTable("trust_holds", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  matterId: uuid("matter_id").notNull().references(() => matters.id),
  amountCents: money("amount_cents").notNull(),
  reason: text("reason").notNull(),
  recordedByUserId: uuid("recorded_by_user_id").notNull().references(() => users.id),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  releasedAt: timestamp("released_at", { withTimezone: true }),
});

export const refundProposals = pgTable("refund_proposals", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => firms.id),
  matterId: uuid("matter_id").notNull().references(() => matters.id),
  clientPartyId: uuid("client_party_id").notNull().references(() => parties.id),
  amountCents: money("amount_cents").notNull(),
  status: text("status").notNull().default("proposed"),
  calculation: jsonb("calculation").notNull(), // the CloseoutPlan snapshot
  approvedByUserId: uuid("approved_by_user_id").references(() => users.id),
  letterDocumentId: uuid("letter_document_id").references(() => documents.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [check("refund_proposals_status_check", sql`${t.status} in ('proposed','lawyer_approved','issued','cancelled')`)]);
