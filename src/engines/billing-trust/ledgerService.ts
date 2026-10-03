// c76 — trust ledger service: accounts, sub-ledgers, postings, holds.
//
// Every function takes a withTenant() transaction and filters by tenantId
// explicitly (defence in depth on top of RLS). Every movement of trust money
// goes through postTransaction(), which:
//   1. checks the acting user's trust role (local stand-in, ./access.ts);
//   2. calls requireApproval('rules.trust_accounting') — while pending it
//      audits the blocked attempt and throws (route → HTTP 423);
//   3. serialises on the account (advisory lock), loads the state and plans
//      the entry with the pure rules (./ledger.ts) — a refusal is audited;
//   4. inserts the hash-chained journal rows; the database triggers
//      independently re-check every rule and move the balances;
//   5. re-reads the balances and refuses (rolls back) if the triggers did not
//      produce exactly the planned result.

import { and, asc, eq, inArray, isNull, max, sql } from "drizzle-orm";
import { gateStatus, PendingApprovalError, requireApproval } from "@/compliance/approvals";
import { audit, auditBlocked } from "@/core/audit";
import { getFirmSettings } from "@/core/firmSettings";
import { matterParties, matters, parties } from "@/db/schema";
import {
  trustAccountBooks,
  trustAccounts,
  trustHoldReleases,
  trustHolds,
  trustLedgerEntries,
  trustPeriodCloses,
  trustSubledgers,
  trustTransactions,
} from "@/db/tables/billing-trust";
import type { TenantTx } from "@/tenancy/withTenant";
import { assertCan, loadTrustActor, type TrustAction, type TrustActor } from "./access";
import { RULE_GATES, TRUST_RULE_GATES } from "./gates";
import { transactionHash, type HashableTransaction } from "./hashChain";
import {
  planHold,
  planTransaction,
  type AccountState,
  type OriginalTransaction,
  type SubledgerState,
  type TransactionInput,
  type TransactionPlan,
} from "./ledger";
import { assertPositiveAmount, MoneyError, type Cents } from "./money";
import { ENGINE, TrustRuleError, isIsoDate, todayIn, type AccountType, type TransactionKind } from "./types";

export interface TrustServiceContext {
  tx: TenantTx;
  tenantId: string;
  /** The signed-in user acting. */
  actorUserId: string;
  now?: Date;
}

export type TrustAccountRow = typeof trustAccounts.$inferSelect;
export type TrustTransactionRow = typeof trustTransactions.$inferSelect;

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/** Load the actor and require a trust action; a refusal is audited before it is thrown. */
export async function requireTrustActor(ctx: TrustServiceContext, action: TrustAction, attempted: string): Promise<TrustActor> {
  const actor = await loadTrustActor(ctx.tx, ctx.tenantId, ctx.actorUserId);
  try {
    assertCan(actor, action);
  } catch (err) {
    await audit(ctx.tx, {
      tenantId: ctx.tenantId,
      engine: ENGINE,
      action: "trust.access_denied",
      entityType: "user",
      entityId: ctx.actorUserId,
      actor: { type: "user", userId: ctx.actorUserId },
      payload: { required: action, attempted, role: actor.role, roleLabel: actor.roleLabel },
    });
    throw err;
  }
  return actor;
}

/** requireApproval() for a gated trust action; the blocked attempt is audited (and committed by the route). */
export async function requireTrustGate(
  ctx: TrustServiceContext,
  gateKey: string,
  action: string,
  detail: Record<string, unknown>,
  entity: { entityType?: string; entityId?: string | null; matterId?: string | null } = {}
): Promise<void> {
  try {
    requireApproval(gateKey, { action, tenantId: ctx.tenantId, detail });
  } catch (err) {
    if (err instanceof PendingApprovalError) {
      await auditBlocked(ctx.tx, err, {
        tenantId: ctx.tenantId,
        engine: ENGINE,
        entityType: entity.entityType ?? "trust_account",
        entityId: entity.entityId ?? null,
        matterId: entity.matterId ?? null,
        actor: { type: "user", userId: ctx.actorUserId },
        payload: detail,
      });
    }
    throw err;
  }
}

/** Serialise all balance-changing work on one trust account (no UPDATE grant needed). */
export async function lockAccount(tx: TenantTx, trustAccountId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`billing-trust:${trustAccountId}`}, 0))`);
}

function notFound(what: string): TrustRuleError {
  return new TrustRuleError("NOT_FOUND", `${what} was not found.`);
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

export interface NewTrustAccount {
  name: string;
  bankName: string;
  accountNumberLast4: string;
  accountType: AccountType;
  openedOn: string;
  bankFeeCushionCapCents?: Cents | null;
}

function validateCushionCap(v: Cents | null | undefined): Cents {
  if (v === null || v === undefined || v === 0n) return 0n;
  try {
    return assertPositiveAmount(v, "bankFeeCushionCapCents");
  } catch (err) {
    if (err instanceof MoneyError) throw new TrustRuleError("INVALID_AMOUNT", err.message);
    throw err;
  }
}

/** Register a firm trust bank account (owner/bookkeeper). Not a movement of money, so not gated; audited. */
export async function createTrustAccount(ctx: TrustServiceContext, input: NewTrustAccount): Promise<TrustAccountRow> {
  await requireTrustActor(ctx, "post", "trust.account.create");
  const name = input.name.trim();
  const bankName = input.bankName.trim();
  if (!name || !bankName) throw new TrustRuleError("BAD_REQUEST", "Give the account a name and the bank's name.");
  if (!/^[0-9]{4}$/.test(input.accountNumberLast4)) {
    throw new TrustRuleError("BAD_REQUEST", "Enter only the last four digits of the account number.");
  }
  if (!isIsoDate(input.openedOn)) throw new TrustRuleError("INVALID_DATE", "The opening date must be YYYY-MM-DD.");
  const cap = validateCushionCap(input.bankFeeCushionCapCents);
  const [row] = await ctx.tx
    .insert(trustAccounts)
    .values({
      tenantId: ctx.tenantId,
      name,
      bankName,
      accountNumberLast4: input.accountNumberLast4,
      accountType: input.accountType,
      openedOn: input.openedOn,
      bankFeeCushionCapCents: cap,
      createdByUserId: ctx.actorUserId,
    })
    .returning();
  await insertBookRow(ctx.tx, ctx.tenantId, row!.id);
  await audit(ctx.tx, {
    tenantId: ctx.tenantId,
    engine: ENGINE,
    action: "trust.account.created",
    entityType: "trust_account",
    entityId: row!.id,
    actor: { type: "user", userId: ctx.actorUserId },
    payload: { name, bankName, accountType: input.accountType, cushionCapCents: cap.toString() },
  });
  return row!;
}

/** Rename an account or change its (gated-use) bank-fee cushion cap. Audited. */
export async function updateTrustAccount(
  ctx: TrustServiceContext,
  trustAccountId: string,
  patch: { name?: string | null; bankFeeCushionCapCents?: Cents | null }
): Promise<TrustAccountRow> {
  await requireTrustActor(ctx, "post", "trust.account.update");
  const current = await getTrustAccount(ctx.tx, ctx.tenantId, trustAccountId);
  const set: Partial<typeof trustAccounts.$inferInsert> = { updatedAt: ctx.now ?? new Date() };
  if (patch.name !== undefined && patch.name !== null) {
    if (!patch.name.trim()) throw new TrustRuleError("BAD_REQUEST", "The name cannot be empty.");
    set.name = patch.name.trim();
  }
  if (patch.bankFeeCushionCapCents !== undefined) set.bankFeeCushionCapCents = validateCushionCap(patch.bankFeeCushionCapCents);
  const [row] = await ctx.tx
    .update(trustAccounts)
    .set(set)
    .where(and(eq(trustAccounts.tenantId, ctx.tenantId), eq(trustAccounts.id, trustAccountId)))
    .returning();
  await audit(ctx.tx, {
    tenantId: ctx.tenantId,
    engine: ENGINE,
    action: "trust.account.updated",
    entityType: "trust_account",
    entityId: trustAccountId,
    actor: { type: "user", userId: ctx.actorUserId },
    payload: {
      name: set.name ?? null,
      cushionCapCents: { from: current.bankFeeCushionCapCents.toString(), to: (set.bankFeeCushionCapCents ?? current.bankFeeCushionCapCents).toString() },
    },
  });
  return row!;
}

export async function getTrustAccount(tx: TenantTx, tenantId: string, trustAccountId: string): Promise<TrustAccountRow> {
  const [row] = await tx
    .select()
    .from(trustAccounts)
    .where(and(eq(trustAccounts.tenantId, tenantId), eq(trustAccounts.id, trustAccountId)))
    .limit(1);
  if (!row) throw notFound("The trust account");
  return row;
}

// ---------------------------------------------------------------------------
// Sub-ledgers
// ---------------------------------------------------------------------------

// app_runtime may INSERT only the identity columns of the two balance tables
// (balances are written by the ledger triggers alone — MIGRATION NOTES in
// src/db/tables/billing-trust.ts). Drizzle's insert() names every column
// (DEFAULT for the omitted ones), which that column grant refuses, so these
// two inserts name their columns explicitly.

async function insertBookRow(tx: TenantTx, tenantId: string, trustAccountId: string): Promise<void> {
  await tx.execute(sql`insert into ${trustAccountBooks} (trust_account_id, tenant_id) values (${trustAccountId}, ${tenantId})`);
}

async function insertSubledgerRow(
  tx: TenantTx,
  v: { tenantId: string; trustAccountId: string; kind: "client_matter" | "firm_cushion"; clientPartyId: string | null; matterId: string | null; createdByUserId: string }
): Promise<typeof trustSubledgers.$inferSelect> {
  const id = crypto.randomUUID();
  await tx.execute(
    sql`insert into ${trustSubledgers} (id, tenant_id, trust_account_id, kind, client_party_id, matter_id, created_by_user_id)
        values (${id}, ${v.tenantId}, ${v.trustAccountId}, ${v.kind}, ${v.clientPartyId}, ${v.matterId}, ${v.createdByUserId})`
  );
  const [row] = await tx
    .select()
    .from(trustSubledgers)
    .where(and(eq(trustSubledgers.tenantId, v.tenantId), eq(trustSubledgers.id, id)))
    .limit(1);
  return row!;
}

/** True when the party is the matter's client (primary party, or a 'client' matter party). */
export async function isClientOfMatter(tx: TenantTx, tenantId: string, matterId: string, partyId: string): Promise<boolean> {
  const [m] = await tx
    .select({ primaryPartyId: matters.primaryPartyId })
    .from(matters)
    .where(and(eq(matters.tenantId, tenantId), eq(matters.id, matterId)))
    .limit(1);
  if (!m) throw notFound("The matter");
  if (m.primaryPartyId === partyId) return true;
  const [mp] = await tx
    .select({ id: matterParties.id })
    .from(matterParties)
    .where(
      and(
        eq(matterParties.tenantId, tenantId),
        eq(matterParties.matterId, matterId),
        eq(matterParties.partyId, partyId),
        eq(matterParties.role, "client"),
        isNull(matterParties.endedAt)
      )
    )
    .limit(1);
  return Boolean(mp);
}

/** Open (or return the existing) client-matter sub-ledger. */
export async function openClientSubledger(
  ctx: TrustServiceContext,
  input: { trustAccountId: string; clientPartyId: string; matterId: string }
): Promise<typeof trustSubledgers.$inferSelect> {
  await requireTrustActor(ctx, "post", "trust.subledger.open");
  const account = await getTrustAccount(ctx.tx, ctx.tenantId, input.trustAccountId);
  if (account.status !== "active") throw new TrustRuleError("ACCOUNT_CLOSED", "This trust account is closed.");
  if (!(await isClientOfMatter(ctx.tx, ctx.tenantId, input.matterId, input.clientPartyId))) {
    throw new TrustRuleError("MATTER_CLIENT_MISMATCH", "That person is not the client on that matter.");
  }
  const [existing] = await ctx.tx
    .select()
    .from(trustSubledgers)
    .where(
      and(
        eq(trustSubledgers.tenantId, ctx.tenantId),
        eq(trustSubledgers.trustAccountId, input.trustAccountId),
        eq(trustSubledgers.kind, "client_matter"),
        eq(trustSubledgers.clientPartyId, input.clientPartyId),
        eq(trustSubledgers.matterId, input.matterId)
      )
    )
    .limit(1);
  if (existing) return existing;
  const row = await insertSubledgerRow(ctx.tx, {
    tenantId: ctx.tenantId,
    trustAccountId: input.trustAccountId,
    kind: "client_matter",
    clientPartyId: input.clientPartyId,
    matterId: input.matterId,
    createdByUserId: ctx.actorUserId,
  });
  await audit(ctx.tx, {
    tenantId: ctx.tenantId,
    engine: ENGINE,
    action: "trust.subledger.opened",
    entityType: "trust_subledger",
    entityId: row!.id,
    matterId: input.matterId,
    actor: { type: "user", userId: ctx.actorUserId },
    payload: { trustAccountId: input.trustAccountId, clientPartyId: input.clientPartyId },
  });
  return row!;
}

/** Open (or return) the firm's bank-fee cushion sub-ledger for an account. */
export async function openCushionSubledger(ctx: TrustServiceContext, trustAccountId: string): Promise<typeof trustSubledgers.$inferSelect> {
  await requireTrustActor(ctx, "post", "trust.subledger.open_cushion");
  await getTrustAccount(ctx.tx, ctx.tenantId, trustAccountId);
  const [existing] = await ctx.tx
    .select()
    .from(trustSubledgers)
    .where(and(eq(trustSubledgers.tenantId, ctx.tenantId), eq(trustSubledgers.trustAccountId, trustAccountId), eq(trustSubledgers.kind, "firm_cushion")))
    .limit(1);
  if (existing) return existing;
  const row = await insertSubledgerRow(ctx.tx, {
    tenantId: ctx.tenantId,
    trustAccountId,
    kind: "firm_cushion",
    clientPartyId: null,
    matterId: null,
    createdByUserId: ctx.actorUserId,
  });
  await audit(ctx.tx, {
    tenantId: ctx.tenantId,
    engine: ENGINE,
    action: "trust.subledger.opened",
    entityType: "trust_subledger",
    entityId: row!.id,
    actor: { type: "user", userId: ctx.actorUserId },
    payload: { trustAccountId, kind: "firm_cushion" },
  });
  return row!;
}

// ---------------------------------------------------------------------------
// State loading
// ---------------------------------------------------------------------------

export async function latestClose(tx: TenantTx, tenantId: string, trustAccountId: string): Promise<{ period: string; periodEnd: string } | null> {
  const [row] = await tx
    .select({ period: trustPeriodCloses.period, periodEnd: trustPeriodCloses.periodEnd })
    .from(trustPeriodCloses)
    .where(and(eq(trustPeriodCloses.tenantId, tenantId), eq(trustPeriodCloses.trustAccountId, trustAccountId)))
    .orderBy(sql`${trustPeriodCloses.periodEnd} desc`)
    .limit(1);
  return row ?? null;
}

/** The account's current state for planning. Call after lockAccount() when the result will be written. */
export async function loadAccountState(tx: TenantTx, tenantId: string, trustAccountId: string): Promise<AccountState> {
  const account = await getTrustAccount(tx, tenantId, trustAccountId);
  const [book] = await tx
    .select()
    .from(trustAccountBooks)
    .where(and(eq(trustAccountBooks.tenantId, tenantId), eq(trustAccountBooks.trustAccountId, trustAccountId)))
    .limit(1);
  if (!book) throw new Error(`billing-trust: account ${trustAccountId} has no book row.`);
  const subs = await tx
    .select()
    .from(trustSubledgers)
    .where(and(eq(trustSubledgers.tenantId, tenantId), eq(trustSubledgers.trustAccountId, trustAccountId)));
  const close = await latestClose(tx, tenantId, trustAccountId);
  const subledgers = new Map<string, SubledgerState>(
    subs.map((s) => [
      s.id,
      {
        id: s.id,
        trustAccountId: s.trustAccountId,
        kind: s.kind as SubledgerState["kind"],
        clientPartyId: s.clientPartyId,
        matterId: s.matterId,
        balance: s.balanceCents,
        held: s.heldCents,
      },
    ])
  );
  return {
    id: account.id,
    status: account.status as AccountState["status"],
    bookBalance: book.balanceCents,
    lastSequence: book.lastSequence,
    lastHash: book.lastHash,
    closedThrough: close?.periodEnd ?? null,
    cushionCap: account.bankFeeCushionCapCents,
    subledgers,
  };
}

async function loadOriginal(tx: TenantTx, tenantId: string, transactionId: string): Promise<OriginalTransaction | null> {
  const [t] = await tx
    .select()
    .from(trustTransactions)
    .where(and(eq(trustTransactions.tenantId, tenantId), eq(trustTransactions.id, transactionId)))
    .limit(1);
  if (!t) return null;
  const lines = await tx
    .select({ subledgerId: trustLedgerEntries.subledgerId, amount: trustLedgerEntries.amountCents, lineNo: trustLedgerEntries.lineNo })
    .from(trustLedgerEntries)
    .where(and(eq(trustLedgerEntries.tenantId, tenantId), eq(trustLedgerEntries.transactionId, transactionId)))
    .orderBy(asc(trustLedgerEntries.lineNo));
  const [rev] = await tx
    .select({ id: trustTransactions.id })
    .from(trustTransactions)
    .where(and(eq(trustTransactions.tenantId, tenantId), eq(trustTransactions.reversesTransactionId, transactionId)))
    .limit(1);
  return {
    id: t.id,
    trustAccountId: t.trustAccountId,
    kind: t.kind as TransactionKind,
    lines: lines.map((l) => ({ subledgerId: l.subledgerId, amount: l.amount })),
    reversedById: rev?.id ?? null,
  };
}

async function planFor(ctx: TrustServiceContext, input: TransactionInput, state: AccountState): Promise<TransactionPlan> {
  const settings = await getFirmSettings(ctx.tx, ctx.tenantId);
  const original = input.kind === "reversal" && input.reversesTransactionId ? await loadOriginal(ctx.tx, ctx.tenantId, input.reversesTransactionId) : null;
  return planTransaction(state, input, {
    today: todayIn(settings.timeZone, ctx.now ?? new Date()),
    cushionRuleApproved: gateStatus(TRUST_RULE_GATES.bankFeeCushion.key).approved,
    original,
    // c50 extension point: per-matter retainer floors are wired in when the
    // fee arrangement (c52) and evergreen term (c39) exist. None apply yet.
    retainerFloors: undefined,
  });
}

function matterOf(state: AccountState, plan: Pick<TransactionPlan, "lines">): string | null {
  const ids = new Set(plan.lines.map((l) => state.subledgers.get(l.subledgerId)?.matterId).filter((x): x is string => Boolean(x)));
  return ids.size === 1 ? [...ids][0]! : null;
}

// ---------------------------------------------------------------------------
// Posting
// ---------------------------------------------------------------------------

/** Dry run: what would be posted, and whether posting is currently allowed. Read-only, ungated. */
export async function previewTransaction(ctx: TrustServiceContext, input: TransactionInput) {
  await requireTrustActor(ctx, "read", `trust.preview.${input.kind}`);
  const state = await loadAccountState(ctx.tx, ctx.tenantId, input.trustAccountId);
  const plan = await planFor(ctx, input, state);
  const gate = gateStatus(RULE_GATES.trustAccounting.key);
  return { plan, postingAllowed: gate.approved, pendingReviewers: gate.pendingReviewers };
}

export interface PostedTransaction {
  transaction: TrustTransactionRow;
  lines: (typeof trustLedgerEntries.$inferSelect)[];
}

/** Post one movement of trust money. See the module comment for the full sequence. */
export async function postTransaction(ctx: TrustServiceContext, input: TransactionInput): Promise<PostedTransaction> {
  const action = `trust.${input.kind}`;
  await requireTrustActor(ctx, "post", action);
  const detail = {
    kind: input.kind,
    trustAccountId: input.trustAccountId,
    subledgerId: input.subledgerId ?? null,
    amountCents: input.amount?.toString() ?? null,
    reversesTransactionId: input.reversesTransactionId ?? null,
  };
  await requireTrustGate(ctx, RULE_GATES.trustAccounting.key, action, detail, { entityId: input.trustAccountId });
  if (input.kind === "cushion_deposit") {
    await requireTrustGate(ctx, TRUST_RULE_GATES.bankFeeCushion.key, action, detail, { entityId: input.trustAccountId });
  }

  await lockAccount(ctx.tx, input.trustAccountId);
  const state = await loadAccountState(ctx.tx, ctx.tenantId, input.trustAccountId);
  let plan: TransactionPlan;
  try {
    plan = await planFor(ctx, input, state);
  } catch (err) {
    if (err instanceof TrustRuleError) {
      await audit(ctx.tx, {
        tenantId: ctx.tenantId,
        engine: ENGINE,
        action: "trust.transaction.refused",
        entityType: "trust_account",
        entityId: input.trustAccountId,
        actor: { type: "user", userId: ctx.actorUserId },
        reason: err.message,
        payload: { ...detail, code: err.code },
      });
    }
    throw err;
  }

  const postedAt = ctx.now ?? new Date();
  const hashable: HashableTransaction = {
    tenantId: ctx.tenantId,
    trustAccountId: plan.trustAccountId,
    sequence: plan.sequence,
    kind: plan.kind,
    effectiveDate: plan.effectiveDate,
    netAmount: plan.netAmount,
    reason: plan.reason,
    memo: plan.memo,
    counterparty: plan.counterparty,
    reference: plan.reference,
    invoiceId: plan.invoiceId,
    earnedBasis: plan.earnedBasis,
    fundsSource: plan.fundsSource,
    reversesTransactionId: plan.reversesTransactionId,
    postedByUserId: ctx.actorUserId,
    postedAt,
    prevHash: plan.prevHash,
    lines: plan.lines,
  };
  const hash = transactionHash(hashable);
  const evidence = gateStatus(RULE_GATES.trustAccounting.key).approvals.map((a) => ({
    reviewerKind: a.reviewerKind,
    approvedByName: a.approvedByName,
    approvedAt: a.approvedAt.toISOString(),
  }));

  const [transaction] = await ctx.tx
    .insert(trustTransactions)
    .values({
      tenantId: ctx.tenantId,
      trustAccountId: plan.trustAccountId,
      sequence: plan.sequence,
      kind: plan.kind,
      effectiveDate: plan.effectiveDate,
      netAmountCents: plan.netAmount,
      reason: plan.reason,
      memo: plan.memo,
      counterparty: plan.counterparty,
      reference: plan.reference,
      fundsSource: plan.fundsSource,
      invoiceId: plan.invoiceId,
      earnedBasis: plan.earnedBasis,
      reversesTransactionId: plan.reversesTransactionId,
      postedByUserId: ctx.actorUserId,
      postedAt,
      approvalEvidence: evidence,
      prevHash: plan.prevHash,
      hash,
    })
    .returning();
  const lines = await ctx.tx
    .insert(trustLedgerEntries)
    .values(
      plan.lines.map((l) => ({
        tenantId: ctx.tenantId,
        transactionId: transaction!.id,
        trustAccountId: plan.trustAccountId,
        subledgerId: l.subledgerId,
        lineNo: l.lineNo,
        amountCents: l.amount,
        balanceAfterCents: l.balanceAfter,
        bookBalanceAfterCents: l.bookBalanceAfter,
      }))
    )
    .returning();

  await verifyPosted(ctx.tx, ctx.tenantId, plan, hash);

  await audit(ctx.tx, {
    tenantId: ctx.tenantId,
    engine: ENGINE,
    action: "trust.transaction.posted",
    entityType: "trust_transaction",
    entityId: transaction!.id,
    matterId: matterOf(state, plan),
    actor: { type: "user", userId: ctx.actorUserId },
    reason: plan.reason,
    payload: {
      kind: plan.kind,
      sequence: plan.sequence,
      netAmountCents: plan.netAmount.toString(),
      invoiceId: plan.invoiceId,
      reversesTransactionId: plan.reversesTransactionId,
      lines: plan.lines.map((l) => ({ subledgerId: l.subledgerId, amountCents: l.amount.toString() })),
    },
  });
  return { transaction: transaction!, lines };
}

/**
 * Post-condition: the database triggers must have moved the balances exactly
 * as planned. If they did not (e.g. the MIGRATION NOTES triggers are missing),
 * throw so the whole transaction rolls back — nothing posts unverified.
 */
async function verifyPosted(tx: TenantTx, tenantId: string, plan: TransactionPlan, hash: string): Promise<void> {
  const [book] = await tx
    .select()
    .from(trustAccountBooks)
    .where(and(eq(trustAccountBooks.tenantId, tenantId), eq(trustAccountBooks.trustAccountId, plan.trustAccountId)))
    .limit(1);
  const subs = await tx
    .select({ id: trustSubledgers.id, balance: trustSubledgers.balanceCents })
    .from(trustSubledgers)
    .where(and(eq(trustSubledgers.tenantId, tenantId), inArray(trustSubledgers.id, plan.lines.map((l) => l.subledgerId))));
  const byId = new Map(subs.map((s) => [s.id, s.balance]));
  const ok =
    book &&
    book.balanceCents === plan.bookBalanceAfter &&
    book.lastSequence === plan.sequence &&
    book.lastHash === hash &&
    plan.lines.every((l) => byId.get(l.subledgerId) === l.balanceAfter);
  if (!ok) {
    throw new Error(
      "billing-trust: the trust-ledger database triggers did not apply this entry as planned (are the MIGRATION NOTES triggers installed?). Nothing was posted."
    );
  }
}

// ---------------------------------------------------------------------------
// Disputed-funds holds (protective: not a movement of money, so not gated; audited)
// ---------------------------------------------------------------------------

export async function placeHold(
  ctx: TrustServiceContext,
  input: { trustAccountId: string; subledgerId: string; amount: Cents; reason: string }
): Promise<typeof trustHolds.$inferSelect> {
  await requireTrustActor(ctx, "post", "trust.hold.place");
  await lockAccount(ctx.tx, input.trustAccountId);
  const state = await loadAccountState(ctx.tx, ctx.tenantId, input.trustAccountId);
  const plan = planHold(state, input);
  const [hold] = await ctx.tx
    .insert(trustHolds)
    .values({
      tenantId: ctx.tenantId,
      trustAccountId: input.trustAccountId,
      subledgerId: plan.subledgerId,
      amountCents: plan.amount,
      reason: plan.reason,
      placedByUserId: ctx.actorUserId,
      ...(ctx.now ? { placedAt: ctx.now } : {}),
    })
    .returning();
  await verifyHeld(ctx.tx, ctx.tenantId, plan.subledgerId, plan.heldAfter);
  await audit(ctx.tx, {
    tenantId: ctx.tenantId,
    engine: ENGINE,
    action: "trust.hold.placed",
    entityType: "trust_hold",
    entityId: hold!.id,
    matterId: state.subledgers.get(plan.subledgerId)?.matterId ?? null,
    actor: { type: "user", userId: ctx.actorUserId },
    reason: plan.reason,
    payload: { subledgerId: plan.subledgerId, amountCents: plan.amount.toString() },
  });
  return hold!;
}

export async function releaseHold(ctx: TrustServiceContext, holdId: string, reason: string): Promise<typeof trustHoldReleases.$inferSelect> {
  await requireTrustActor(ctx, "post", "trust.hold.release");
  const why = reason.trim();
  if (why.length < 3) throw new TrustRuleError("REASON_REQUIRED", "Say how the dispute was resolved.");
  const [hold] = await ctx.tx
    .select()
    .from(trustHolds)
    .where(and(eq(trustHolds.tenantId, ctx.tenantId), eq(trustHolds.id, holdId)))
    .limit(1);
  if (!hold) throw notFound("The hold");
  await lockAccount(ctx.tx, hold.trustAccountId);
  const [already] = await ctx.tx
    .select({ id: trustHoldReleases.id })
    .from(trustHoldReleases)
    .where(and(eq(trustHoldReleases.tenantId, ctx.tenantId), eq(trustHoldReleases.holdId, holdId)))
    .limit(1);
  if (already) throw new TrustRuleError("HOLD_INVALID", "That hold has already been released.");
  const state = await loadAccountState(ctx.tx, ctx.tenantId, hold.trustAccountId);
  const sub = state.subledgers.get(hold.subledgerId)!;
  const [release] = await ctx.tx
    .insert(trustHoldReleases)
    .values({ tenantId: ctx.tenantId, holdId, reason: why, releasedByUserId: ctx.actorUserId, ...(ctx.now ? { releasedAt: ctx.now } : {}) })
    .returning();
  await verifyHeld(ctx.tx, ctx.tenantId, hold.subledgerId, sub.held - hold.amountCents);
  await audit(ctx.tx, {
    tenantId: ctx.tenantId,
    engine: ENGINE,
    action: "trust.hold.released",
    entityType: "trust_hold",
    entityId: holdId,
    matterId: sub.matterId,
    actor: { type: "user", userId: ctx.actorUserId },
    reason: why,
    payload: { subledgerId: hold.subledgerId, amountCents: hold.amountCents.toString() },
  });
  return release!;
}

async function verifyHeld(tx: TenantTx, tenantId: string, subledgerId: string, expected: Cents): Promise<void> {
  const [s] = await tx
    .select({ held: trustSubledgers.heldCents })
    .from(trustSubledgers)
    .where(and(eq(trustSubledgers.tenantId, tenantId), eq(trustSubledgers.id, subledgerId)))
    .limit(1);
  if (!s || s.held !== expected) {
    throw new Error("billing-trust: the hold triggers did not apply this hold as planned (are the MIGRATION NOTES triggers installed?).");
  }
}

// ---------------------------------------------------------------------------
// Read-only views (work while every gate is pending)
// ---------------------------------------------------------------------------

export interface SubledgerView {
  id: string;
  trustAccountId: string;
  kind: string;
  label: string;
  clientPartyId: string | null;
  clientName: string | null;
  matterId: string | null;
  practiceArea: string | null;
  matterClosedAt: Date | null;
  balance: Cents;
  held: Cents;
  available: Cents;
}

export function subledgerLabel(row: { kind: string; clientName: string | null; practiceArea: string | null; matterId: string | null }): string {
  if (row.kind === "firm_cushion") return "Firm bank-fee cushion";
  const matter = `${row.practiceArea ?? "Matter"} ${row.matterId ? row.matterId.slice(0, 8) : ""}`.trim();
  return `${row.clientName ?? "Client"} — ${matter}`;
}

export async function listSubledgers(tx: TenantTx, tenantId: string, trustAccountId: string): Promise<SubledgerView[]> {
  const rows = await tx
    .select({
      id: trustSubledgers.id,
      trustAccountId: trustSubledgers.trustAccountId,
      kind: trustSubledgers.kind,
      clientPartyId: trustSubledgers.clientPartyId,
      clientName: parties.fullName,
      matterId: trustSubledgers.matterId,
      practiceArea: matters.practiceArea,
      matterClosedAt: matters.closedAt,
      balance: trustSubledgers.balanceCents,
      held: trustSubledgers.heldCents,
    })
    .from(trustSubledgers)
    .leftJoin(parties, eq(parties.id, trustSubledgers.clientPartyId))
    .leftJoin(matters, eq(matters.id, trustSubledgers.matterId))
    .where(and(eq(trustSubledgers.tenantId, tenantId), eq(trustSubledgers.trustAccountId, trustAccountId)));
  return rows
    .map((r) => ({ ...r, label: subledgerLabel(r), available: r.balance - r.held }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export interface AccountSummary {
  account: TrustAccountRow;
  bookBalance: Cents;
  clientLedgerTotal: Cents;
  lastSequence: number;
  closedThrough: string | null;
  closedPeriod: string | null;
}

export async function listTrustAccounts(tx: TenantTx, tenantId: string): Promise<AccountSummary[]> {
  const accounts = await tx.select().from(trustAccounts).where(eq(trustAccounts.tenantId, tenantId)).orderBy(asc(trustAccounts.name));
  const out: AccountSummary[] = [];
  for (const account of accounts) {
    const [book] = await tx
      .select()
      .from(trustAccountBooks)
      .where(and(eq(trustAccountBooks.tenantId, tenantId), eq(trustAccountBooks.trustAccountId, account.id)))
      .limit(1);
    const [sum] = await tx
      .select({ total: sql<string>`coalesce(sum(${trustSubledgers.balanceCents}), 0)::text` })
      .from(trustSubledgers)
      .where(and(eq(trustSubledgers.tenantId, tenantId), eq(trustSubledgers.trustAccountId, account.id)));
    const close = await latestClose(tx, tenantId, account.id);
    out.push({
      account,
      bookBalance: book?.balanceCents ?? 0n,
      clientLedgerTotal: BigInt(sum?.total ?? "0"),
      lastSequence: book?.lastSequence ?? 0,
      closedThrough: close?.periodEnd ?? null,
      closedPeriod: close?.period ?? null,
    });
  }
  return out;
}

export interface RegisterRow {
  id: string;
  sequence: number;
  kind: string;
  effectiveDate: string;
  netAmount: Cents;
  runningBalance: Cents;
  reason: string;
  counterparty: string | null;
  reference: string | null;
  invoiceId: string | null;
  reversesTransactionId: string | null;
  reversedById: string | null;
  postedByUserId: string;
  postedAt: Date;
}

/** The account book (check register), oldest first, with running balance in posting order. */
export async function getAccountRegister(tx: TenantTx, tenantId: string, trustAccountId: string): Promise<RegisterRow[]> {
  await getTrustAccount(tx, tenantId, trustAccountId);
  const rows = await tx
    .select()
    .from(trustTransactions)
    .where(and(eq(trustTransactions.tenantId, tenantId), eq(trustTransactions.trustAccountId, trustAccountId)))
    .orderBy(asc(trustTransactions.sequence));
  const reversedBy = new Map(rows.filter((r) => r.reversesTransactionId).map((r) => [r.reversesTransactionId!, r.id]));
  let running = 0n;
  return rows.map((r) => {
    running += r.netAmountCents;
    return {
      id: r.id,
      sequence: r.sequence,
      kind: r.kind,
      effectiveDate: r.effectiveDate,
      netAmount: r.netAmountCents,
      runningBalance: running,
      reason: r.reason,
      counterparty: r.counterparty,
      reference: r.reference,
      invoiceId: r.invoiceId,
      reversesTransactionId: r.reversesTransactionId,
      reversedById: reversedBy.get(r.id) ?? null,
      postedByUserId: r.postedByUserId,
      postedAt: r.postedAt,
    };
  });
}

/** One client-matter ledger: every line with who/when/why, the running balance, and its holds. */
export async function getSubledgerLedger(tx: TenantTx, tenantId: string, subledgerId: string) {
  const [sub] = await tx
    .select({
      id: trustSubledgers.id,
      trustAccountId: trustSubledgers.trustAccountId,
      kind: trustSubledgers.kind,
      clientPartyId: trustSubledgers.clientPartyId,
      clientName: parties.fullName,
      matterId: trustSubledgers.matterId,
      practiceArea: matters.practiceArea,
      matterClosedAt: matters.closedAt,
      balance: trustSubledgers.balanceCents,
      held: trustSubledgers.heldCents,
    })
    .from(trustSubledgers)
    .leftJoin(parties, eq(parties.id, trustSubledgers.clientPartyId))
    .leftJoin(matters, eq(matters.id, trustSubledgers.matterId))
    .where(and(eq(trustSubledgers.tenantId, tenantId), eq(trustSubledgers.id, subledgerId)))
    .limit(1);
  if (!sub) throw notFound("The ledger");
  const lines = await tx
    .select({
      entryId: trustLedgerEntries.id,
      transactionId: trustTransactions.id,
      sequence: trustTransactions.sequence,
      kind: trustTransactions.kind,
      effectiveDate: trustTransactions.effectiveDate,
      amount: trustLedgerEntries.amountCents,
      balanceAfter: trustLedgerEntries.balanceAfterCents,
      reason: trustTransactions.reason,
      memo: trustTransactions.memo,
      counterparty: trustTransactions.counterparty,
      reference: trustTransactions.reference,
      invoiceId: trustTransactions.invoiceId,
      earnedBasis: trustTransactions.earnedBasis,
      reversesTransactionId: trustTransactions.reversesTransactionId,
      postedByUserId: trustTransactions.postedByUserId,
      postedAt: trustTransactions.postedAt,
    })
    .from(trustLedgerEntries)
    .innerJoin(trustTransactions, eq(trustTransactions.id, trustLedgerEntries.transactionId))
    .where(and(eq(trustLedgerEntries.tenantId, tenantId), eq(trustLedgerEntries.subledgerId, subledgerId)))
    .orderBy(asc(trustTransactions.sequence));
  const holds = await tx
    .select({
      id: trustHolds.id,
      amount: trustHolds.amountCents,
      reason: trustHolds.reason,
      placedByUserId: trustHolds.placedByUserId,
      placedAt: trustHolds.placedAt,
      releasedAt: trustHoldReleases.releasedAt,
      releaseReason: trustHoldReleases.reason,
    })
    .from(trustHolds)
    .leftJoin(trustHoldReleases, eq(trustHoldReleases.holdId, trustHolds.id))
    .where(and(eq(trustHolds.tenantId, tenantId), eq(trustHolds.subledgerId, subledgerId)))
    .orderBy(asc(trustHolds.placedAt));
  return { subledger: { ...sub, label: subledgerLabel(sub), available: sub.balance - sub.held }, lines, holds };
}

/** Highest sequence posted (for quick integrity displays). */
export async function maxSequence(tx: TenantTx, tenantId: string, trustAccountId: string): Promise<number> {
  const [row] = await tx
    .select({ m: max(trustTransactions.sequence) })
    .from(trustTransactions)
    .where(and(eq(trustTransactions.tenantId, tenantId), eq(trustTransactions.trustAccountId, trustAccountId)));
  return row?.m ?? 0;
}
