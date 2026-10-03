// Worker hooks of the Billing & trust engine (discovered automatically by
// src/worker/hooks.ts). Each hook runs once per active firm per tick in its
// own tenant transaction. Both only RAISE internal flags (deduplicated); they
// never move money and never decide anything for a lawyer.

import { and, eq, gt, isNotNull, or } from "drizzle-orm";
import type { EngineWorkerModule } from "@/worker/hooks";
import { raiseFlag } from "@/core/flags";
import { getFirmSettings } from "@/core/firmSettings";
import { matters } from "@/db/schema";
import { trustAccounts, trustPeriodCloses, trustSubledgers } from "@/db/tables/billing-trust";
import type { TenantTx } from "@/tenancy/withTenant";
import { formatCents } from "./money";
import { reconciliationDueDate } from "./reconciliation";
import { overdueFlagKey, trustAlertRecipients } from "./reconciliationService";
import { readTrustSettings, trustRuleValues } from "./rules";
import { ENGINE, periodBounds, periodOf, previousPeriod, todayIn } from "./types";

/**
 * c75 §11.3: three-way reconciliation is a recurring, non-skippable workflow.
 * When last month is still not closed `reconciliationDueDays` after month end,
 * the owner and bookkeeper get a high-severity flag (one per account/month).
 */
export async function flagOverdueReconciliations(tx: TenantTx, tenantId: string, now: Date): Promise<{ flagged: number; skippedNoRecipients?: number }> {
  const firm = await getFirmSettings(tx, tenantId);
  const settings = readTrustSettings(firm);
  const today = todayIn(firm.timeZone, now);
  const period = previousPeriod(periodOf(today));
  const due = reconciliationDueDate(period, settings.reconciliationDueDays);
  if (today <= due) return { flagged: 0 };
  const { end } = periodBounds(period);
  const accounts = await tx
    .select()
    .from(trustAccounts)
    .where(and(eq(trustAccounts.tenantId, tenantId), eq(trustAccounts.status, "active")));
  const rules = trustRuleValues();
  const recipients = await trustAlertRecipients(tx, tenantId);
  if (recipients.length === 0) return { flagged: 0, skippedNoRecipients: accounts.length };
  let flagged = 0;
  for (const a of accounts) {
    if (a.openedOn > end) continue; // the account did not exist that month
    const [closed] = await tx
      .select({ id: trustPeriodCloses.id })
      .from(trustPeriodCloses)
      .where(and(eq(trustPeriodCloses.tenantId, tenantId), eq(trustPeriodCloses.trustAccountId, a.id), eq(trustPeriodCloses.period, period)))
      .limit(1);
    if (closed) continue;
    const { created } = await raiseFlag(
      tx,
      {
        tenantId,
        type: "billing-trust.reconciliation_overdue",
        severity: "high",
        audience: "internal",
        title: `Trust reconciliation for ${a.name} (${period}) is overdue`,
        summary:
          `The ${period} three-way reconciliation was due by ${due} and the month is not closed.` +
          (rules.approved ? "" : " (Monthly cadence is the proposed rule, pending attorney + CPA review.)"),
        details: { trustAccountId: a.id, period, dueDate: due },
        recipients: { userIds: recipients },
        dedupeKey: overdueFlagKey(a.id, period),
        sourceCard: "c76",
        engine: ENGINE,
      },
      { now }
    );
    if (created) flagged++;
  }
  return { flagged };
}

/**
 * c75 §9 / §11.8: a closed matter that still holds trust money is flagged for
 * the responsible lawyer's review (refunds themselves are c82, gated).
 */
export async function flagClosedMattersHoldingFunds(tx: TenantTx, tenantId: string, now: Date): Promise<{ flagged: number }> {
  const rows = await tx
    .select({
      subledgerId: trustSubledgers.id,
      matterId: trustSubledgers.matterId,
      balance: trustSubledgers.balanceCents,
      held: trustSubledgers.heldCents,
      assignedUserId: matters.assignedUserId,
    })
    .from(trustSubledgers)
    .innerJoin(matters, eq(matters.id, trustSubledgers.matterId))
    .where(
      and(
        eq(trustSubledgers.tenantId, tenantId),
        eq(trustSubledgers.kind, "client_matter"),
        gt(trustSubledgers.balanceCents, 0n),
        or(isNotNull(matters.closedAt), eq(matters.stage, "closed"))
      )
    );
  if (rows.length === 0) return { flagged: 0 };
  const owners = await trustAlertRecipients(tx, tenantId);
  let flagged = 0;
  for (const r of rows) {
    const recipients = [...new Set([...(r.assignedUserId ? [r.assignedUserId] : []), ...owners])];
    if (recipients.length === 0) continue;
    const { created } = await raiseFlag(
      tx,
      {
        tenantId,
        type: "billing-trust.closed_matter_holds_funds",
        severity: "warning",
        audience: "internal",
        matterId: r.matterId,
        title: "A closed matter still holds client money in trust",
        summary:
          `${formatCents(r.balance)} remains in trust for this closed matter` +
          (r.held > 0n ? ` (${formatCents(r.held)} held as disputed)` : "") +
          ". Review whether an unearned balance must be refunded. Nothing is paid out automatically.",
        details: { subledgerId: r.subledgerId, balanceCents: r.balance.toString(), heldCents: r.held.toString() },
        recipients: { userIds: recipients },
        dedupeKey: `billing-trust.closed_matter_funds:${r.subledgerId}`,
        sourceCard: "c76",
        engine: ENGINE,
      },
      { now }
    );
    if (created) flagged++;
  }
  return { flagged };
}

export const worker: EngineWorkerModule = {
  tickHooks: [
    {
      name: "billing-trust.reconciliation_overdue",
      engine: ENGINE,
      run: async ({ tx, tenantId, now }) => flagOverdueReconciliations(tx, tenantId, now),
    },
    {
      name: "billing-trust.closed_matter_funds",
      engine: ENGINE,
      run: async ({ tx, tenantId, now }) => flagClosedMattersHoldingFunds(tx, tenantId, now),
    },
  ],
};
