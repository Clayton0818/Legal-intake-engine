// c76 — bank statements and monthly three-way reconciliation (DB side).
//
//   importStatement / importStatementCsv   entered or CSV statements (owner/bookkeeper; not gated)
//   pullStatementFromFeed                  gated on 'vendor.billing-trust.bank_feed' (stub adapter)
//   prepareReconciliation                  owner/bookkeeper; NOT gated (preparation works while
//                                          rules are pending); stored append-only; any
//                                          difference raises a critical flag to the owner
//   signOffReconciliation                  gated on 'rules.trust_accounting'; closes the month
//                                          when every required sign-off is in
//   exportReconciliation                   CSV / JSON of any stored reconciliation

import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { raiseFlag, resolveFlag } from "@/core/flags";
import { audit } from "@/core/audit";
import { getFirmSettings } from "@/core/firmSettings";
import { firms, users } from "@/db/schema";
import { flags } from "@/db/tables/foundation";
import {
  trustAccountBooks,
  trustBankStatementLines,
  trustBankStatements,
  trustLedgerEntries,
  trustPeriodCloses,
  trustReconciliationSignoffs,
  trustReconciliations,
  trustTransactions,
} from "@/db/tables/billing-trust";
import type { TenantTx } from "@/tenancy/withTenant";
import { gateStatus } from "@/compliance/approvals";
import { signoffAction } from "./access";
import { getBankFeedAdapter } from "./bankFeed";
import { RULE_GATES, TRUST_RULE_GATES } from "./gates";
import { canonicalJson, sha256Hex, verifyChain, type HashableTransaction } from "./hashChain";
import {
  getTrustAccount,
  latestClose,
  listSubledgers,
  requireTrustActor,
  requireTrustGate,
  type TrustServiceContext,
} from "./ledgerService";
import { jsonSafe, type Cents } from "./money";
import {
  reconcile,
  reportHash,
  statementProblems,
  validateCloseOrder,
  validateSignoff,
  type BookTransaction,
  type ManualMatch,
  type ReconciliationReport,
  type StatementData,
} from "./reconciliation";
import { readTrustSettings, trustRecordsRetainUntil, trustRuleValues } from "./rules";
import { parseStatementCsv, reconciliationCsv, reconciliationJson, type ExportMeta, type StatementLineInput } from "./statementIo";
import { ENGINE, TrustRuleError, periodBounds, previousPeriod, type SignoffRole, type StatementLineKind, type StatementSource } from "./types";

export type StatementRow = typeof trustBankStatements.$inferSelect;
export type ReconciliationRow = typeof trustReconciliations.$inferSelect;

export function unbalancedFlagKey(trustAccountId: string, period: string): string {
  return `billing-trust.recon_unbalanced:${trustAccountId}:${period}`;
}
export function overdueFlagKey(trustAccountId: string, period: string): string {
  return `billing-trust.recon_overdue:${trustAccountId}:${period}`;
}

/**
 * Firm users alerted about trust problems: owners (firm_admin / 'owner') and
 * bookkeepers; if a firm has none, its lawyers. A flag must never go nowhere.
 */
export async function trustAlertRecipients(tx: TenantTx, tenantId: string, alsoUserId?: string): Promise<string[]> {
  const rows = await tx
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.tenantId, tenantId),
        eq(users.status, "active"),
        or(eq(users.role, "firm_admin"), sql`lower(coalesce(${users.roleLabel}, '')) in ('owner','bookkeeper')`)
      )
    );
  let ids = rows.map((r) => r.id);
  if (ids.length === 0) {
    const lawyers = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.tenantId, tenantId), eq(users.status, "active"), eq(users.role, "attorney")));
    ids = lawyers.map((r) => r.id);
  }
  return [...new Set([...ids, ...(alsoUserId ? [alsoUserId] : [])])];
}

async function isPeriodClosed(tx: TenantTx, tenantId: string, trustAccountId: string, period: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: trustPeriodCloses.id })
    .from(trustPeriodCloses)
    .where(and(eq(trustPeriodCloses.tenantId, tenantId), eq(trustPeriodCloses.trustAccountId, trustAccountId), eq(trustPeriodCloses.period, period)))
    .limit(1);
  return Boolean(row);
}

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

/** The current (not superseded) statement for a period, with lines. */
export async function currentStatement(tx: TenantTx, tenantId: string, trustAccountId: string, period: string): Promise<StatementData | null> {
  const rows = await tx
    .select()
    .from(trustBankStatements)
    .where(and(eq(trustBankStatements.tenantId, tenantId), eq(trustBankStatements.trustAccountId, trustAccountId), eq(trustBankStatements.period, period)));
  const superseded = new Set(rows.map((r) => r.supersedesStatementId).filter(Boolean));
  const current = rows.filter((r) => !superseded.has(r.id)).sort((a, b) => b.enteredAt.getTime() - a.enteredAt.getTime())[0];
  return current ? loadStatement(tx, tenantId, current) : null;
}

async function loadStatement(tx: TenantTx, tenantId: string, row: StatementRow): Promise<StatementData> {
  const lines = await tx
    .select()
    .from(trustBankStatementLines)
    .where(and(eq(trustBankStatementLines.tenantId, tenantId), eq(trustBankStatementLines.statementId, row.id)))
    .orderBy(asc(trustBankStatementLines.lineNo));
  return {
    id: row.id,
    period: row.period,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    openingBalance: row.openingBalanceCents,
    closingBalance: row.closingBalanceCents,
    lines: lines.map((l) => ({
      id: l.id,
      lineNo: l.lineNo,
      postedOn: l.postedOn,
      amount: l.amountCents,
      description: l.description,
      reference: l.reference,
      kind: l.kind as StatementLineKind,
    })),
  };
}

export interface StatementInput {
  trustAccountId: string;
  period: string;
  openingBalance: Cents;
  closingBalance: Cents;
  lines: StatementLineInput[];
  source: StatementSource;
  sourceSha256?: string | null;
  note?: string | null;
  /** Required when a statement for this period already exists: the one being corrected. */
  supersedesStatementId?: string | null;
}

/** Record a bank statement (append-only). It must foot and cover exactly the calendar month. */
export async function importStatement(ctx: TrustServiceContext, input: StatementInput): Promise<StatementRow> {
  await requireTrustActor(ctx, "reconcile", "trust.statement.import");
  await getTrustAccount(ctx.tx, ctx.tenantId, input.trustAccountId);
  const { start, end } = periodBounds(input.period);
  if (await isPeriodClosed(ctx.tx, ctx.tenantId, input.trustAccountId, input.period)) {
    throw new TrustRuleError("PERIOD_CLOSED", "This month is already reconciled and closed; its statement cannot be replaced.");
  }
  const draft: StatementData = {
    id: "new",
    period: input.period,
    periodStart: start,
    periodEnd: end,
    openingBalance: input.openingBalance,
    closingBalance: input.closingBalance,
    lines: input.lines.map((l, i) => ({ ...l, id: `l${i + 1}`, lineNo: i + 1 })),
  };
  const problems = statementProblems(draft);
  if (problems.length > 0) {
    throw new TrustRuleError("STATEMENT_INVALID", problems.map((p) => p.message).join(" "), { problems: jsonSafe(problems) });
  }
  const existing = await currentStatement(ctx.tx, ctx.tenantId, input.trustAccountId, input.period);
  if (existing && existing.id !== input.supersedesStatementId) {
    throw new TrustRuleError("STATEMENT_INVALID", "A statement for this month already exists. To correct it, enter the new one as superseding it.", {
      currentStatementId: existing.id,
    });
  }
  if (!existing && input.supersedesStatementId) throw new TrustRuleError("STATEMENT_INVALID", "There is no statement for this month to supersede.");

  const [row] = await ctx.tx
    .insert(trustBankStatements)
    .values({
      tenantId: ctx.tenantId,
      trustAccountId: input.trustAccountId,
      period: input.period,
      periodStart: start,
      periodEnd: end,
      openingBalanceCents: input.openingBalance,
      closingBalanceCents: input.closingBalance,
      source: input.source,
      sourceSha256: input.sourceSha256 ?? null,
      supersedesStatementId: input.supersedesStatementId ?? null,
      note: input.note?.trim() || null,
      enteredByUserId: ctx.actorUserId,
    })
    .returning();
  if (input.lines.length > 0) {
    await ctx.tx.insert(trustBankStatementLines).values(
      input.lines.map((l, i) => ({
        tenantId: ctx.tenantId,
        statementId: row!.id,
        lineNo: i + 1,
        postedOn: l.postedOn,
        amountCents: l.amount,
        description: l.description,
        reference: l.reference,
        kind: l.kind,
      }))
    );
  }
  await audit(ctx.tx, {
    tenantId: ctx.tenantId,
    engine: ENGINE,
    action: "trust.statement.recorded",
    entityType: "trust_bank_statement",
    entityId: row!.id,
    actor: { type: "user", userId: ctx.actorUserId },
    payload: {
      trustAccountId: input.trustAccountId,
      period: input.period,
      source: input.source,
      lines: input.lines.length,
      closingBalanceCents: input.closingBalance.toString(),
      supersedes: input.supersedesStatementId ?? null,
    },
  });
  return row!;
}

export async function importStatementCsv(
  ctx: TrustServiceContext,
  input: Omit<StatementInput, "lines" | "source" | "sourceSha256"> & { csv: string }
): Promise<StatementRow> {
  const lines = parseStatementCsv(input.csv);
  return importStatement(ctx, { ...input, lines, source: "csv_import", sourceSha256: sha256Hex(input.csv) });
}

/** Pull a statement from the bank-feed vendor. Gated; the shipped adapter is a stub that returns nothing. */
export async function pullStatementFromFeed(ctx: TrustServiceContext, trustAccountId: string, period: string) {
  await requireTrustActor(ctx, "reconcile", "trust.statement.bank_feed");
  const account = await getTrustAccount(ctx.tx, ctx.tenantId, trustAccountId);
  await requireTrustGate(ctx, TRUST_RULE_GATES.bankFeed.key, "trust.statement.bank_feed", { trustAccountId, period }, { entityId: trustAccountId });
  const result = await getBankFeedAdapter().fetchStatement({
    tenantId: ctx.tenantId,
    trustAccountId,
    bankName: account.bankName,
    accountNumberLast4: account.accountNumberLast4,
    period,
  });
  if (result.status !== "ok") return { imported: false as const, message: result.message, provider: result.provider };
  const statement = await importStatement(ctx, {
    trustAccountId,
    period,
    openingBalance: result.openingBalance,
    closingBalance: result.closingBalance,
    lines: result.lines,
    source: "bank_feed",
    sourceSha256: result.payloadSha256,
    note: `Imported from ${result.provider}`,
  });
  return { imported: true as const, statementId: statement.id };
}

export async function listStatements(tx: TenantTx, tenantId: string, trustAccountId: string): Promise<StatementRow[]> {
  return tx
    .select()
    .from(trustBankStatements)
    .where(and(eq(trustBankStatements.tenantId, tenantId), eq(trustBankStatements.trustAccountId, trustAccountId)))
    .orderBy(desc(trustBankStatements.period), desc(trustBankStatements.enteredAt));
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

/** Everything the pure reconcile() needs, loaded from the database. */
async function loadBook(tx: TenantTx, tenantId: string, trustAccountId: string) {
  const txRows = await tx
    .select()
    .from(trustTransactions)
    .where(and(eq(trustTransactions.tenantId, tenantId), eq(trustTransactions.trustAccountId, trustAccountId)))
    .orderBy(asc(trustTransactions.sequence));
  const lineRows = txRows.length
    ? await tx
        .select()
        .from(trustLedgerEntries)
        .where(and(eq(trustLedgerEntries.tenantId, tenantId), eq(trustLedgerEntries.trustAccountId, trustAccountId)))
    : [];
  const linesByTx = new Map<string, typeof lineRows>();
  for (const l of lineRows) linesByTx.set(l.transactionId, [...(linesByTx.get(l.transactionId) ?? []), l]);

  const transactions: BookTransaction[] = txRows.map((t) => ({
    id: t.id,
    sequence: t.sequence,
    kind: t.kind as BookTransaction["kind"],
    effectiveDate: t.effectiveDate,
    netAmount: t.netAmountCents,
    reference: t.reference,
    counterparty: t.counterparty,
    reason: t.reason,
    reversesTransactionId: t.reversesTransactionId,
    lines: (linesByTx.get(t.id) ?? []).map((l) => ({ subledgerId: l.subledgerId, amount: l.amountCents })),
  }));
  const hashable: (HashableTransaction & { hash: string })[] = txRows.map((t) => ({
    tenantId: t.tenantId,
    trustAccountId: t.trustAccountId,
    sequence: t.sequence,
    kind: t.kind,
    effectiveDate: t.effectiveDate,
    netAmount: t.netAmountCents,
    reason: t.reason,
    memo: t.memo,
    counterparty: t.counterparty,
    reference: t.reference,
    invoiceId: t.invoiceId,
    earnedBasis: t.earnedBasis,
    fundsSource: t.fundsSource,
    reversesTransactionId: t.reversesTransactionId,
    postedByUserId: t.postedByUserId,
    postedAt: t.postedAt,
    prevHash: t.prevHash,
    hash: t.hash,
    lines: (linesByTx.get(t.id) ?? []).map((l) => ({ lineNo: l.lineNo, subledgerId: l.subledgerId, amount: l.amountCents })),
  }));
  const [book] = await tx
    .select()
    .from(trustAccountBooks)
    .where(and(eq(trustAccountBooks.tenantId, tenantId), eq(trustAccountBooks.trustAccountId, trustAccountId)))
    .limit(1);
  return { transactions, chain: verifyChain(hashable), cachedBookBalance: book?.balanceCents ?? 0n };
}

/** Transactions the bank already cleared in an earlier CLOSED reconciliation. */
async function previouslyCleared(tx: TenantTx, tenantId: string, trustAccountId: string): Promise<Set<string>> {
  const rows = await tx
    .select({ worksheet: trustReconciliations.worksheet })
    .from(trustPeriodCloses)
    .innerJoin(trustReconciliations, eq(trustReconciliations.id, trustPeriodCloses.reconciliationId))
    .where(and(eq(trustPeriodCloses.tenantId, tenantId), eq(trustPeriodCloses.trustAccountId, trustAccountId)));
  const out = new Set<string>();
  for (const r of rows) {
    const matches = (r.worksheet as { matches?: { transactionIds?: string[] }[] }).matches ?? [];
    for (const m of matches) for (const id of m.transactionIds ?? []) out.add(id);
  }
  return out;
}

async function latestReconciliation(tx: TenantTx, tenantId: string, trustAccountId: string, period: string): Promise<ReconciliationRow | null> {
  const rows = await tx
    .select()
    .from(trustReconciliations)
    .where(and(eq(trustReconciliations.tenantId, tenantId), eq(trustReconciliations.trustAccountId, trustAccountId), eq(trustReconciliations.period, period)));
  const superseded = new Set(rows.map((r) => r.supersedesReconciliationId).filter(Boolean));
  return rows.find((r) => !superseded.has(r.id)) ?? null;
}

/**
 * Prepare (or re-prepare) the month's three-way reconciliation and store it
 * append-only. Works while trust rules are pending (it moves no money).
 */
export async function prepareReconciliation(
  ctx: TrustServiceContext,
  input: { trustAccountId: string; period: string; manualMatches?: ManualMatch[] }
): Promise<{ reconciliation: ReconciliationRow; report: ReconciliationReport }> {
  await requireTrustActor(ctx, "reconcile", "trust.reconciliation.prepare");
  const account = await getTrustAccount(ctx.tx, ctx.tenantId, input.trustAccountId);
  const { end } = periodBounds(input.period);
  if (await isPeriodClosed(ctx.tx, ctx.tenantId, input.trustAccountId, input.period)) {
    throw new TrustRuleError("RECONCILIATION_INVALID", "This month is already reconciled and closed.");
  }
  const statement = await currentStatement(ctx.tx, ctx.tenantId, input.trustAccountId, input.period);
  if (!statement) throw new TrustRuleError("RECONCILIATION_INVALID", "Enter or import the bank statement for this month first.");
  const prev = await currentStatement(ctx.tx, ctx.tenantId, input.trustAccountId, previousPeriod(input.period));
  const settings = readTrustSettings(await getFirmSettings(ctx.tx, ctx.tenantId));
  const book = await loadBook(ctx.tx, ctx.tenantId, input.trustAccountId);
  const ledgers = await listSubledgers(ctx.tx, ctx.tenantId, input.trustAccountId);

  const report = reconcile({
    trustAccountId: input.trustAccountId,
    period: input.period,
    statement,
    previousClosingBalance: prev?.closingBalance ?? null,
    transactions: book.transactions,
    ledgers: ledgers.map((l) => ({
      id: l.id,
      kind: l.kind as "client_matter" | "firm_cushion",
      label: l.label,
      clientPartyId: l.clientPartyId,
      matterId: l.matterId,
      cachedBalance: l.balance,
      cachedHeld: l.held,
    })),
    cachedBookBalance: book.cachedBookBalance,
    previouslyCleared: await previouslyCleared(ctx.tx, ctx.tenantId, input.trustAccountId),
    manualMatches: input.manualMatches,
    chain: book.chain,
    depositToleranceDays: settings.depositToleranceDays,
    withdrawalClearDays: settings.withdrawalClearDays,
    staleOutstandingDays: settings.staleOutstandingDays,
  });
  const hash = reportHash(report);
  const previous = await latestReconciliation(ctx.tx, ctx.tenantId, input.trustAccountId, input.period);
  const worksheet = jsonSafe(report) as Record<string, unknown>;

  const [row] = await ctx.tx
    .insert(trustReconciliations)
    .values({
      tenantId: ctx.tenantId,
      trustAccountId: input.trustAccountId,
      period: input.period,
      periodEnd: end,
      statementId: statement.id,
      status: report.balanced ? "balanced" : "unbalanced",
      bankClosingBalanceCents: report.bank.closingBalance,
      adjustedBankBalanceCents: report.bank.adjustedBalance,
      bookBalanceCents: report.bookBalance,
      clientLedgerTotalCents: report.clientLedgerTotal,
      depositsInTransitCents: report.bank.depositsInTransit,
      outstandingWithdrawalsCents: report.bank.outstandingWithdrawals,
      differences: worksheet.differences as Record<string, unknown>[],
      worksheet,
      reportHash: hash,
      throughSequence: report.throughSequence,
      supersedesReconciliationId: previous?.id ?? null,
      rulesApproved: gateStatus(RULE_GATES.trustAccounting.key).approved,
      preparedByUserId: ctx.actorUserId,
      ...(ctx.now ? { preparedAt: ctx.now } : {}),
    })
    .returning();

  await audit(ctx.tx, {
    tenantId: ctx.tenantId,
    engine: ENGINE,
    action: "trust.reconciliation.prepared",
    entityType: "trust_reconciliation",
    entityId: row!.id,
    actor: { type: "user", userId: ctx.actorUserId },
    payload: {
      trustAccountId: input.trustAccountId,
      period: input.period,
      status: row!.status,
      differences: report.differences.map((d) => d.code),
      reportHash: hash,
    },
  });

  // Any mismatch blocks the month and alerts the owner (c76).
  if (!report.balanced) {
    await raiseFlag(
      ctx.tx,
      {
        tenantId: ctx.tenantId,
        type: "billing-trust.reconciliation_unbalanced",
        severity: "critical",
        audience: "internal",
        title: `Trust reconciliation for ${account.name} (${input.period}) does not balance`,
        summary: report.differences
          .filter((d) => d.blocking)
          .map((d) => d.message)
          .slice(0, 10)
          .join(" "),
        details: { trustAccountId: input.trustAccountId, period: input.period, reconciliationId: row!.id, codes: report.differences.map((d) => d.code) },
        recipients: { userIds: await trustAlertRecipients(ctx.tx, ctx.tenantId, ctx.actorUserId) },
        dedupeKey: unbalancedFlagKey(input.trustAccountId, input.period),
        urgent: true,
        raisedBy: { type: "user", userId: ctx.actorUserId },
        sourceCard: "c76",
        engine: ENGINE,
      },
      { now: ctx.now }
    );
  }
  return { reconciliation: row!, report };
}

async function openFlagByKey(tx: TenantTx, tenantId: string, key: string) {
  const [row] = await tx
    .select({ id: flags.id })
    .from(flags)
    .where(and(eq(flags.tenantId, tenantId), eq(flags.dedupeKey, key), isNull(flags.resolvedAt)))
    .limit(1);
  return row ?? null;
}

/**
 * Sign off a balanced reconciliation. Closing a trust month applies the
 * trust-accounting rules, so this is gated on 'rules.trust_accounting'. When
 * every required sign-off is in, the month closes (no further entries may be
 * dated in it) and the month's alert flags are resolved with a reason.
 */
export async function signOffReconciliation(
  ctx: TrustServiceContext,
  input: { reconciliationId: string; role: SignoffRole; note?: string | null }
) {
  await requireTrustActor(ctx, signoffAction(input.role), "trust.reconciliation.signoff");
  const [recon] = await ctx.tx
    .select()
    .from(trustReconciliations)
    .where(and(eq(trustReconciliations.tenantId, ctx.tenantId), eq(trustReconciliations.id, input.reconciliationId)))
    .limit(1);
  if (!recon) throw new TrustRuleError("NOT_FOUND", "The reconciliation was not found.");
  await requireTrustGate(
    ctx,
    RULE_GATES.trustAccounting.key,
    "trust.reconciliation.signoff",
    { reconciliationId: recon.id, period: recon.period, role: input.role },
    { entityType: "trust_reconciliation", entityId: recon.id }
  );

  const [superseder] = await ctx.tx
    .select({ id: trustReconciliations.id })
    .from(trustReconciliations)
    .where(and(eq(trustReconciliations.tenantId, ctx.tenantId), eq(trustReconciliations.supersedesReconciliationId, recon.id)))
    .limit(1);
  const existing = await ctx.tx
    .select({ role: trustReconciliationSignoffs.signoffRole, userId: trustReconciliationSignoffs.userId })
    .from(trustReconciliationSignoffs)
    .where(and(eq(trustReconciliationSignoffs.tenantId, ctx.tenantId), eq(trustReconciliationSignoffs.reconciliationId, recon.id)));
  const settings = readTrustSettings(await getFirmSettings(ctx.tx, ctx.tenantId));
  const { closesPeriod } = validateSignoff({
    reconciliation: {
      status: recon.status as "balanced" | "unbalanced",
      superseded: Boolean(superseder),
      periodClosed: await isPeriodClosed(ctx.tx, ctx.tenantId, recon.trustAccountId, recon.period),
    },
    role: input.role,
    signerUserId: ctx.actorUserId,
    existing: existing.map((e) => ({ role: e.role as SignoffRole, userId: e.userId })),
    requiredRoles: settings.signoffRoles,
  });
  if (closesPeriod) {
    const last = await latestClose(ctx.tx, ctx.tenantId, recon.trustAccountId);
    validateCloseOrder(recon.period, last?.period ?? null);
    // The books must not have moved inside the month since this was prepared.
    const [late] = await ctx.tx
      .select({ id: trustTransactions.id })
      .from(trustTransactions)
      .where(
        and(
          eq(trustTransactions.tenantId, ctx.tenantId),
          eq(trustTransactions.trustAccountId, recon.trustAccountId),
          sql`${trustTransactions.sequence} > ${recon.throughSequence}`,
          sql`${trustTransactions.effectiveDate} <= ${recon.periodEnd}`
        )
      )
      .limit(1);
    if (late) {
      throw new TrustRuleError("SIGNOFF_INVALID", "Entries dated in this month were posted after the reconciliation was prepared. Prepare it again.");
    }
  }

  const [signoff] = await ctx.tx
    .insert(trustReconciliationSignoffs)
    .values({
      tenantId: ctx.tenantId,
      reconciliationId: recon.id,
      signoffRole: input.role,
      userId: ctx.actorUserId,
      reportHash: recon.reportHash,
      note: input.note?.trim() || null,
      ...(ctx.now ? { signedAt: ctx.now } : {}),
    })
    .returning();
  await audit(ctx.tx, {
    tenantId: ctx.tenantId,
    engine: ENGINE,
    action: "trust.reconciliation.signed",
    entityType: "trust_reconciliation",
    entityId: recon.id,
    actor: { type: "user", userId: ctx.actorUserId },
    payload: { role: input.role, period: recon.period, reportHash: recon.reportHash, closesPeriod },
  });

  let close: typeof trustPeriodCloses.$inferSelect | null = null;
  if (closesPeriod) {
    const [inserted] = await ctx.tx
      .insert(trustPeriodCloses)
      .values({
        tenantId: ctx.tenantId,
        trustAccountId: recon.trustAccountId,
        period: recon.period,
        periodEnd: recon.periodEnd,
        reconciliationId: recon.id,
        closedByUserId: ctx.actorUserId,
        ...(ctx.now ? { closedAt: ctx.now } : {}),
      })
      .returning();
    close = inserted ?? null;
    await audit(ctx.tx, {
      tenantId: ctx.tenantId,
      engine: ENGINE,
      action: "trust.period.closed",
      entityType: "trust_account",
      entityId: recon.trustAccountId,
      actor: { type: "user", userId: ctx.actorUserId },
      payload: { period: recon.period, reconciliationId: recon.id },
    });
    for (const key of [unbalancedFlagKey(recon.trustAccountId, recon.period), overdueFlagKey(recon.trustAccountId, recon.period)]) {
      const open = await openFlagByKey(ctx.tx, ctx.tenantId, key);
      if (open) {
        await resolveFlag(ctx.tx, {
          tenantId: ctx.tenantId,
          flagId: open.id,
          by: { type: "user", userId: ctx.actorUserId },
          reason: `Month ${recon.period} reconciled (balanced) and signed off; reconciliation ${recon.id}.`,
          engine: ENGINE,
          at: ctx.now,
        });
      }
    }
  }
  return { signoff: signoff!, closed: close };
}

export async function listReconciliations(tx: TenantTx, tenantId: string, trustAccountId: string) {
  const rows = await tx
    .select()
    .from(trustReconciliations)
    .where(and(eq(trustReconciliations.tenantId, tenantId), eq(trustReconciliations.trustAccountId, trustAccountId)))
    .orderBy(desc(trustReconciliations.period), desc(trustReconciliations.preparedAt));
  const superseded = new Set(rows.map((r) => r.supersedesReconciliationId).filter(Boolean));
  const closes = await tx
    .select({ reconciliationId: trustPeriodCloses.reconciliationId })
    .from(trustPeriodCloses)
    .where(and(eq(trustPeriodCloses.tenantId, tenantId), eq(trustPeriodCloses.trustAccountId, trustAccountId)));
  const closedBy = new Set(closes.map((c) => c.reconciliationId));
  return rows.map((r) => ({
    id: r.id,
    period: r.period,
    status: r.status,
    adjustedBankBalance: r.adjustedBankBalanceCents,
    bookBalance: r.bookBalanceCents,
    clientLedgerTotal: r.clientLedgerTotalCents,
    differences: r.differences.length,
    preparedAt: r.preparedAt,
    preparedByUserId: r.preparedByUserId,
    superseded: superseded.has(r.id),
    closedMonth: closedBy.has(r.id),
    rulesApproved: r.rulesApproved,
  }));
}

export async function getReconciliation(tx: TenantTx, tenantId: string, reconciliationId: string) {
  const [row] = await tx
    .select()
    .from(trustReconciliations)
    .where(and(eq(trustReconciliations.tenantId, tenantId), eq(trustReconciliations.id, reconciliationId)))
    .limit(1);
  if (!row) throw new TrustRuleError("NOT_FOUND", "The reconciliation was not found.");
  const signoffs = await tx
    .select({
      role: trustReconciliationSignoffs.signoffRole,
      userId: trustReconciliationSignoffs.userId,
      name: users.displayName,
      signedAt: trustReconciliationSignoffs.signedAt,
      reportHash: trustReconciliationSignoffs.reportHash,
      note: trustReconciliationSignoffs.note,
    })
    .from(trustReconciliationSignoffs)
    .leftJoin(users, eq(users.id, trustReconciliationSignoffs.userId))
    .where(and(eq(trustReconciliationSignoffs.tenantId, tenantId), eq(trustReconciliationSignoffs.reconciliationId, reconciliationId)));
  const [superseder] = await tx
    .select({ id: trustReconciliations.id })
    .from(trustReconciliations)
    .where(and(eq(trustReconciliations.tenantId, tenantId), eq(trustReconciliations.supersedesReconciliationId, reconciliationId)))
    .limit(1);
  const [close] = await tx
    .select()
    .from(trustPeriodCloses)
    .where(and(eq(trustPeriodCloses.tenantId, tenantId), eq(trustPeriodCloses.reconciliationId, reconciliationId)))
    .limit(1);
  const [preparer] = await tx.select({ name: users.displayName }).from(users).where(eq(users.id, row.preparedByUserId)).limit(1);
  // The stored worksheet must still hash to what was signed (tamper evidence for retained records).
  const intact = reportHashOfStored(row.worksheet) === row.reportHash;
  return {
    reconciliation: row,
    signoffs,
    supersededBy: superseder?.id ?? null,
    closed: close ?? null,
    preparedByName: preparer?.name ?? null,
    worksheetIntact: intact,
  };
}

/** Hash of a stored (JSON-safe) worksheet — equal to reportHash() of the original report. */
export function reportHashOfStored(worksheet: Record<string, unknown>): string {
  return sha256Hex(canonicalJson(worksheet));
}

/** Export a stored reconciliation as CSV or JSON. Reconciliations are never deleted (retained ≥ the gated retention value). */
export async function exportReconciliation(tx: TenantTx, tenantId: string, reconciliationId: string, format: "csv" | "json") {
  const detail = await getReconciliation(tx, tenantId, reconciliationId);
  const r = detail.reconciliation;
  const account = await getTrustAccount(tx, tenantId, r.trustAccountId);
  const [firm] = await tx.select({ name: firms.name }).from(firms).where(eq(firms.id, tenantId)).limit(1);
  const rules = trustRuleValues();
  const settings = readTrustSettings(await getFirmSettings(tx, tenantId));
  const retainUntil = trustRecordsRetainUntil(r.periodEnd, rules.values.retentionYearsAfterRepresentationEnds, settings.retentionYears);
  const meta: ExportMeta = {
    firmName: firm?.name ?? "",
    accountName: `${account.name} (${account.bankName} ••${account.accountNumberLast4})`,
    status: detail.closed ? "closed (balanced, signed off)" : detail.supersededBy ? "superseded" : r.status,
    preparedAt: r.preparedAt.toISOString(),
    preparedBy: detail.preparedByName ?? r.preparedByUserId,
    signoffs: detail.signoffs.map((s) => ({ role: s.role, name: s.name ?? s.userId, signedAt: s.signedAt.toISOString() })),
    reportHash: r.reportHash,
    // At least N years from the period end — the matter-level clock (after the representation ends) can only be later.
    retainUntil: retainUntil ? `${retainUntil} or later${rules.approved ? "" : " (proposed — pending attorney + CPA review)"}` : null,
    rulesApproved: r.rulesApproved,
  };
  const report = reviveReport(r.worksheet);
  const filename = `trust-reconciliation-${r.period}-${account.accountNumberLast4}.${format}`;
  return { filename, format, content: format === "csv" ? reconciliationCsv(report, meta) : reconciliationJson(report, meta) };
}

/** Rebuild the bigint fields of a stored worksheet for export. */
export function reviveReport(w: Record<string, unknown>): ReconciliationReport {
  const big = (v: unknown): Cents => BigInt(String(v ?? "0"));
  const o = w as unknown as ReconciliationReport & Record<string, unknown>;
  const bank = w.bank as Record<string, unknown>;
  return {
    ...o,
    bank: {
      openingBalance: big(bank.openingBalance),
      closingBalance: big(bank.closingBalance),
      depositsInTransit: big(bank.depositsInTransit),
      outstandingWithdrawals: big(bank.outstandingWithdrawals),
      adjustedBalance: big(bank.adjustedBalance),
    },
    bookBalance: big(w.bookBalance),
    clientLedgerTotal: big(w.clientLedgerTotal),
    threeWay: { ...(w.threeWay as ReconciliationReport["threeWay"]), bank: big((w.threeWay as Record<string, unknown>).bank), book: big((w.threeWay as Record<string, unknown>).book), clients: big((w.threeWay as Record<string, unknown>).clients) },
    ledgers: ((w.ledgers as Record<string, unknown>[]) ?? []).map((l) => ({
      ...(l as unknown as ReconciliationReport["ledgers"][number]),
      balanceAtPeriodEnd: big(l.balanceAtPeriodEnd),
      cachedBalance: big(l.cachedBalance),
      recomputedBalance: big(l.recomputedBalance),
      held: big(l.held),
    })),
    outstanding: ((w.outstanding as Record<string, unknown>[]) ?? []).map((x) => ({
      ...(x as unknown as ReconciliationReport["outstanding"][number]),
      amount: big(x.amount),
    })),
    differences: ((w.differences as Record<string, unknown>[]) ?? []).map((d) => ({
      ...(d as unknown as ReconciliationReport["differences"][number]),
      ...(d.amount === undefined ? {} : { amount: big(d.amount) }),
    })),
  };
}

/** Ids of the users named on reconciliations (for display). */
export async function userNames(tx: TenantTx, tenantId: string, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({ id: users.id, name: users.displayName })
    .from(users)
    .where(and(eq(users.tenantId, tenantId), inArray(users.id, [...new Set(ids)])));
  return new Map(rows.map((r) => [r.id, r.name]));
}
