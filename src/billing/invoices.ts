// c79 — Invoices built from approved time (c77), costs (c78) and fixed-fee
// installments (c52). Every invoice starts as a DRAFT BILL that the
// responsible lawyer reviews, edits or writes down before it is sent.
// Numbered, never deleted (voids are recorded). Every step is audited (c6).

import { addDays, type IsoDate } from "./calendar";
import { assertNonNegativeCents, type Cents } from "./money";
import { entryAmountCents, type TimeEntry } from "./timeEntries";
import { billedAmountCents, type Expense } from "./expenses";
import type { PayScheduleLine } from "./feeArrangements";
import type { TrustPaymentPlan } from "./retainerFloor";
import { InvalidTransitionError, type Actor } from "./timeEntries";

export type InvoiceStatus = "draft" | "approved" | "sent" | "partially_paid" | "paid" | "void";
export type BillingMode = "hourly" | "fixed_fee" | "retainer" | "mixed";

export type InvoiceLineKind = "time" | "expense" | "installment" | "adjustment";

export interface InvoiceLine {
  kind: InvoiceLineKind;
  sourceId: string | null; // time entry / expense / schedule line id
  description: string;
  quantity: number; // hours for time, 1 otherwise
  unitCents: Cents;
  amountCents: Cents; // negative only for adjustments (write-downs)
  nonBillable?: boolean; // shown at $0 for transparency
}

export interface Invoice {
  id: string;
  tenantId: string;
  matterId: string;
  clientId: string;
  number: string | null; // assigned on approval so drafts never burn numbers
  status: InvoiceStatus;
  billingMode: BillingMode;
  issueDate: IsoDate | null;
  dueDate: IsoDate | null;
  lines: InvoiceLine[];
  subtotalCents: Cents;
  writeDownCents: Cents; // positive number shown as a reduction
  totalCents: Cents;
  paidCents: Cents;
  /** From the c50 plan: applied from trust, balance remaining (shown on the bill). */
  trustAppliedCents: Cents;
  trustBalanceAfterCents: Cents | null;
  responsibleLawyerId: string;
  approvedByUserId: string | null;
  voidReason: string | null;
}

export function buildDraftInvoice(params: {
  id: string;
  tenantId: string;
  matterId: string;
  clientId: string;
  billingMode: BillingMode;
  responsibleLawyerId: string;
  timeEntries: TimeEntry[];
  expenses: Expense[];
  installments: PayScheduleLine[];
}): Invoice {
  const lines: InvoiceLine[] = [];
  for (const t of params.timeEntries) {
    if (t.status !== "approved" || t.invoiceId !== null) {
      throw new Error(`Time entry ${t.id} is not approved-and-unbilled; only lawyer-approved time can be invoiced.`);
    }
    if (t.matterId !== params.matterId) throw new Error(`Time entry ${t.id} belongs to another matter`);
    lines.push({
      kind: "time",
      sourceId: t.id,
      description: `${t.workDate} ${t.activityCode}: ${t.description}`,
      quantity: Math.round((t.billedMinutes / 60) * 100) / 100,
      unitCents: t.rateCents,
      amountCents: entryAmountCents(t),
      nonBillable: !t.billable || undefined,
    });
  }
  for (const e of params.expenses) {
    if (e.status !== "approved" || e.invoiceId !== null) throw new Error(`Expense ${e.id} is not approved-and-unbilled`);
    if (e.matterId !== params.matterId) throw new Error(`Expense ${e.id} belongs to another matter`);
    const amt = billedAmountCents(e);
    lines.push({ kind: "expense", sourceId: e.id, description: `${e.incurredOn} ${e.category}: ${e.description}`, quantity: 1, unitCents: amt, amountCents: amt });
  }
  for (const i of params.installments) {
    lines.push({
      kind: "installment",
      sourceId: String(i.seq),
      description: i.kind === "upfront" ? "Fixed fee: upfront payment" : `Fixed fee: installment ${i.seq} (due ${i.dueDate})`,
      quantity: 1,
      unitCents: i.amountCents,
      amountCents: i.amountCents,
    });
  }
  const inv: Invoice = {
    id: params.id,
    tenantId: params.tenantId,
    matterId: params.matterId,
    clientId: params.clientId,
    number: null,
    status: "draft",
    billingMode: params.billingMode,
    issueDate: null,
    dueDate: null,
    lines,
    subtotalCents: 0,
    writeDownCents: 0,
    totalCents: 0,
    paidCents: 0,
    trustAppliedCents: 0,
    trustBalanceAfterCents: null,
    responsibleLawyerId: params.responsibleLawyerId,
    approvedByUserId: null,
    voidReason: null,
  };
  return recalc(inv);
}

export function recalc(inv: Invoice): Invoice {
  const subtotal = inv.lines.filter((l) => l.kind !== "adjustment").reduce((a, l) => a + l.amountCents, 0);
  const writeDown = -inv.lines.filter((l) => l.kind === "adjustment").reduce((a, l) => a + l.amountCents, 0);
  const total = subtotal - writeDown;
  if (total < 0) throw new Error("Write-downs cannot take an invoice below zero");
  return { ...inv, subtotalCents: subtotal, writeDownCents: writeDown, totalCents: total };
}

function assertDraft(inv: Invoice, action: string) {
  if (inv.status !== "draft") throw new InvalidTransitionError(inv.status, action, "only draft bills can be edited");
}

/** Lawyer write-down, recorded as a negative adjustment line with a reason. */
export function writeDown(inv: Invoice, amountCents: Cents, reason: string, actor: Actor): Invoice {
  assertDraft(inv, "write-down");
  if (actor.role !== "attorney") throw new InvalidTransitionError(inv.status, "write-down", "only a lawyer can write down a bill");
  assertNonNegativeCents(amountCents, "write-down");
  if (!reason.trim()) throw new Error("A write-down needs a reason");
  return recalc({
    ...inv,
    lines: [...inv.lines, { kind: "adjustment", sourceId: null, description: `Write-down: ${reason}`, quantity: 1, unitCents: -amountCents, amountCents: -amountCents }],
  });
}

/** Remove a line from the draft (its time entry/expense returns to the unbilled pool). */
export function removeLine(inv: Invoice, index: number): Invoice {
  assertDraft(inv, "remove line");
  if (index < 0 || index >= inv.lines.length) throw new Error("No such line");
  return recalc({ ...inv, lines: inv.lines.filter((_, i) => i !== index) });
}

export function formatInvoiceNumber(format: string, year: number, seq: number, pad: number): string {
  return format.replace("{YYYY}", String(year)).replace("{SEQ}", String(seq).padStart(pad, "0"));
}

/**
 * Responsible lawyer approves the draft. Assigns the next number from the
 * firm's gap-free sequence (the caller supplies it from a per-tenant counter
 * row locked FOR UPDATE), sets issue and due dates, and records the trust
 * preview from c50 so the bill shows what trust will pay and what is left.
 */
export function approveInvoice(
  inv: Invoice,
  actor: Actor,
  ctx: {
    nextSeq: number;
    numberFormat: string;
    numberPad: number;
    issueDate: IsoDate;
    netDays: number;
    trustPlan: TrustPaymentPlan | null;
  }
): Invoice {
  assertDraft(inv, "approved");
  if (actor.role !== "attorney") throw new InvalidTransitionError("draft", "approved", "only a lawyer can approve a bill");
  if (actor.userId !== inv.responsibleLawyerId) {
    throw new InvalidTransitionError("draft", "approved", "the responsible lawyer on the matter approves the bill");
  }
  if (inv.lines.length === 0) throw new Error("Cannot approve an empty invoice");
  const year = Number(ctx.issueDate.slice(0, 4));
  return {
    ...inv,
    status: "approved",
    approvedByUserId: actor.userId,
    number: formatInvoiceNumber(ctx.numberFormat, year, ctx.nextSeq, ctx.numberPad),
    issueDate: ctx.issueDate,
    dueDate: addDays(ctx.issueDate, ctx.netDays),
    trustAppliedCents: ctx.trustPlan?.trustDrawCents ?? 0,
    trustBalanceAfterCents: ctx.trustPlan?.balanceAfterCents ?? null,
  };
}

export function markSent(inv: Invoice): Invoice {
  if (inv.status !== "approved") throw new InvalidTransitionError(inv.status, "sent", "a bill must be lawyer-approved before it is sent");
  return { ...inv, status: "sent" };
}

export function amountOpen(inv: Invoice): Cents {
  return inv.totalCents - inv.paidCents;
}

export function recordPayment(inv: Invoice, amountCents: Cents): Invoice {
  if (inv.status !== "sent" && inv.status !== "partially_paid" && inv.status !== "approved") {
    throw new InvalidTransitionError(inv.status, "paid");
  }
  assertNonNegativeCents(amountCents, "payment");
  if (amountCents === 0) throw new Error("Payment must be greater than zero");
  if (amountCents > amountOpen(inv)) throw new Error("Payment exceeds the open amount; overpayments go to the lawyer for review");
  const paid = inv.paidCents + amountCents;
  return { ...inv, paidCents: paid, status: paid === inv.totalCents ? "paid" : "partially_paid" };
}

/**
 * Void, never delete. A void keeps the number and the record, with who and
 * why. Paid or part-paid invoices cannot be voided here: payments must be
 * reversed first (a trust or operating refund decision for the lawyer).
 */
export function voidInvoice(inv: Invoice, reason: string, actor: Actor): Invoice {
  if (actor.role !== "attorney" && actor.role !== "firm_admin") throw new InvalidTransitionError(inv.status, "void", "not permitted");
  if (!reason.trim()) throw new Error("A void needs a reason");
  if (inv.status === "void") throw new InvalidTransitionError(inv.status, "void");
  if (inv.paidCents > 0) throw new InvalidTransitionError(inv.status, "void", "reverse payments before voiding");
  return { ...inv, status: "void", voidReason: reason };
}
