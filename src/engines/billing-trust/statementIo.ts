// Bank statement input (manual JSON lines / CSV) and reconciliation export
// (CSV). Pure; no database, no floats.

import { centsToDecimalString, jsonSafe, MoneyError, parseCents, parseDollars, type Cents } from "./money";
import type { ReconciliationReport } from "./reconciliation";
import { TrustRuleError, isIsoDate, isStatementLineKind, type StatementLineKind } from "./types";

export interface StatementLineInput {
  postedOn: string;
  amount: Cents;
  description: string;
  reference: string | null;
  kind: StatementLineKind;
}

function inferKind(amount: Cents): StatementLineKind {
  return amount > 0n ? "deposit" : "withdrawal";
}

/** Lines given as JSON objects ({ postedOn, amountCents, description, reference?, kind? }). */
export function parseStatementLines(v: unknown): StatementLineInput[] {
  if (!Array.isArray(v)) throw new TrustRuleError("STATEMENT_INVALID", "'lines' must be a list.");
  if (v.length > 5000) throw new TrustRuleError("STATEMENT_INVALID", "A statement can have at most 5,000 lines.");
  return v.map((raw, i) => {
    const o = (raw ?? {}) as Record<string, unknown>;
    const n = i + 1;
    if (!isIsoDate(o.postedOn)) throw new TrustRuleError("STATEMENT_INVALID", `Line ${n}: 'postedOn' must be a date (YYYY-MM-DD).`);
    let amount: Cents;
    try {
      amount = parseCents(o.amountCents, `line ${n} amountCents`);
    } catch (err) {
      if (err instanceof MoneyError) throw new TrustRuleError("STATEMENT_INVALID", err.message);
      throw err;
    }
    if (amount === 0n) throw new TrustRuleError("STATEMENT_INVALID", `Line ${n}: amount cannot be zero.`);
    const description = typeof o.description === "string" ? o.description.trim() : "";
    if (!description) throw new TrustRuleError("STATEMENT_INVALID", `Line ${n}: a description is required.`);
    if (o.kind !== undefined && o.kind !== null && !isStatementLineKind(o.kind)) {
      throw new TrustRuleError("STATEMENT_INVALID", `Line ${n}: unknown kind.`);
    }
    return {
      postedOn: o.postedOn,
      amount,
      description: description.slice(0, 500),
      reference: typeof o.reference === "string" && o.reference.trim() ? o.reference.trim().slice(0, 100) : null,
      kind: (o.kind as StatementLineKind | undefined) ?? inferKind(amount),
    };
  });
}

/** Split one CSV record, honouring double quotes ("" = literal quote). */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/**
 * Parse a bank CSV. Header required; recognised columns (case-insensitive):
 * date, amount (signed dollars) OR debit + credit, description, reference, kind.
 */
export function parseStatementCsv(text: string): StatementLineInput[] {
  const rows = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (rows.length < 2) throw new TrustRuleError("STATEMENT_INVALID", "The CSV needs a header row and at least one line.");
  const header = splitCsvLine(rows[0]!).map((h) => h.toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const iDate = col("date");
  const iAmount = col("amount");
  const iDebit = col("debit");
  const iCredit = col("credit");
  const iDesc = col("description");
  const iRef = col("reference");
  const iKind = col("kind");
  if (iDate < 0 || iDesc < 0 || (iAmount < 0 && (iDebit < 0 || iCredit < 0))) {
    throw new TrustRuleError("STATEMENT_INVALID", "The CSV needs columns: date, description, and amount (or debit and credit).");
  }
  return rows.slice(1).map((row, i) => {
    const n = i + 2;
    const cells = splitCsvLine(row);
    const date = cells[iDate] ?? "";
    if (!isIsoDate(date)) throw new TrustRuleError("STATEMENT_INVALID", `CSV line ${n}: the date must be YYYY-MM-DD.`);
    let amount: Cents;
    try {
      if (iAmount >= 0) amount = parseDollars(cells[iAmount] ?? "", `CSV line ${n} amount`);
      else {
        const debit = (cells[iDebit] ?? "").trim();
        const credit = (cells[iCredit] ?? "").trim();
        if (debit && credit) throw new TrustRuleError("STATEMENT_INVALID", `CSV line ${n}: both debit and credit are filled in.`);
        amount = debit ? -parseDollars(debit, `CSV line ${n} debit`) : parseDollars(credit, `CSV line ${n} credit`);
        if (debit && amount > 0n) amount = -amount;
      }
    } catch (err) {
      if (err instanceof MoneyError) throw new TrustRuleError("STATEMENT_INVALID", err.message);
      throw err;
    }
    if (amount === 0n) throw new TrustRuleError("STATEMENT_INVALID", `CSV line ${n}: amount cannot be zero.`);
    const kindCell = iKind >= 0 ? (cells[iKind] ?? "").toLowerCase() : "";
    if (kindCell && !isStatementLineKind(kindCell)) throw new TrustRuleError("STATEMENT_INVALID", `CSV line ${n}: unknown kind '${kindCell}'.`);
    const description = (cells[iDesc] ?? "").trim();
    if (!description) throw new TrustRuleError("STATEMENT_INVALID", `CSV line ${n}: a description is required.`);
    const ref = iRef >= 0 ? (cells[iRef] ?? "").trim() : "";
    return {
      postedOn: date,
      amount,
      description: description.slice(0, 500),
      reference: ref ? ref.slice(0, 100) : null,
      kind: (kindCell as StatementLineKind) || inferKind(amount),
    };
  });
}

function csvCell(v: string | number | bigint | null | undefined): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  // Neutralise spreadsheet formula injection, then quote.
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export interface ExportMeta {
  firmName: string;
  accountName: string;
  status: string;
  preparedAt: string;
  preparedBy: string;
  signoffs: Array<{ role: string; name: string; signedAt: string }>;
  reportHash: string;
  retainUntil: string | null;
  rulesApproved: boolean;
}

/** The reconciliation worksheet as CSV (sections separated by blank lines). */
export function reconciliationCsv(report: ReconciliationReport, meta: ExportMeta): string {
  const rows: (string | number | bigint | null)[][] = [];
  const money = (c: Cents) => centsToDecimalString(c);
  rows.push(["Three-way trust reconciliation"]);
  rows.push(["Firm", meta.firmName], ["Trust account", meta.accountName], ["Period", report.period], ["Period end", report.periodEnd]);
  rows.push(["Status", meta.status], ["Prepared at", meta.preparedAt], ["Prepared by", meta.preparedBy], ["Report hash", meta.reportHash]);
  rows.push(["Retain until", meta.retainUntil ?? "(5 years after the representation ends — proposed, pending review)"]);
  if (!meta.rulesApproved) rows.push(["Note", "Trust-accounting rules were pending attorney + CPA review when this was prepared."]);
  for (const s of meta.signoffs) rows.push([`Signed off (${s.role})`, s.name, s.signedAt]);
  rows.push([]);
  rows.push(["Figure", "Amount (USD)"]);
  rows.push(["Bank statement closing balance", money(report.bank.closingBalance)]);
  rows.push(["Plus: deposits in transit", money(report.bank.depositsInTransit)]);
  rows.push(["Less: outstanding checks / withdrawals", money(report.bank.outstandingWithdrawals)]);
  rows.push(["Adjusted bank balance", money(report.bank.adjustedBalance)]);
  rows.push(["Trust book balance", money(report.bookBalance)]);
  rows.push(["Sum of client ledgers", money(report.clientLedgerTotal)]);
  rows.push(["Three figures agree", report.threeWay.agree ? "yes" : "NO"]);
  rows.push([]);
  rows.push(["Client ledger", "Balance at period end", "Held (disputed)"]);
  for (const l of report.ledgers) rows.push([l.label, money(l.balanceAtPeriodEnd), money(l.held)]);
  rows.push([]);
  rows.push(["Outstanding item", "Date", "Kind", "Counterparty", "Reference", "Amount", "Age (days)"]);
  for (const o of report.outstanding) rows.push([`#${o.sequence}`, o.effectiveDate, o.kind, o.counterparty, o.reference, money(o.amount), o.ageDays]);
  rows.push([]);
  rows.push(["Difference", "Blocking", "Amount", "Explanation"]);
  for (const d of report.differences) rows.push([d.code, d.blocking ? "yes" : "no", d.amount === undefined ? "" : money(d.amount), d.message]);
  if (report.differences.length === 0) rows.push(["(none)"]);
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

export function reconciliationJson(report: ReconciliationReport, meta: ExportMeta): string {
  return JSON.stringify(jsonSafe({ meta, report }), null, 2);
}
