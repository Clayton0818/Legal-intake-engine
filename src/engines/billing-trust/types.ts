// Shared vocabulary of the trust ledger (c76). Pure; no database.

export const ENGINE = "billing-trust" as const;

/**
 * Every kind of movement the ledger records. Each transaction is one journal
 * entry with one line per sub-ledger it touches:
 *
 *   deposit              +  client money in (client / third party). Never firm money.
 *   disbursement         −  paid out to a third party on the client's behalf (payee required).
 *   earned_fee_transfer  −  earned fees moved to the firm's operating account (invoice id or earning basis required).
 *   refund               −  unearned / unused money returned to the client.
 *   transfer             ±  between two matters of the SAME client (net zero; never client to client).
 *   cushion_deposit      +  firm money into the firm's bank-fee cushion sub-ledger (gated; capped).
 *   cushion_withdrawal   −  firm cushion money back to operating.
 *   bank_fee             −  a bank charge, taken ONLY from the firm cushion — never from a client.
 *   reversal             ±  exact negation of an earlier transaction (corrections; entries are never edited).
 */
export const TRANSACTION_KINDS = [
  "deposit",
  "disbursement",
  "earned_fee_transfer",
  "refund",
  "transfer",
  "cushion_deposit",
  "cushion_withdrawal",
  "bank_fee",
  "reversal",
] as const;
export type TransactionKind = (typeof TRANSACTION_KINDS)[number];

/** Kinds that take money OUT of a sub-ledger (single negative line). */
export const OUTFLOW_KINDS: readonly TransactionKind[] = [
  "disbursement",
  "earned_fee_transfer",
  "refund",
  "cushion_withdrawal",
  "bank_fee",
];
/** Kinds that put money IN (single positive line). */
export const INFLOW_KINDS: readonly TransactionKind[] = ["deposit", "cushion_deposit"];

export const SUBLEDGER_KINDS = ["client_matter", "firm_cushion"] as const;
export type SubledgerKind = (typeof SUBLEDGER_KINDS)[number];

/** Where deposited money came from. 'firm_operating' is only ever valid for the cushion. */
export const FUNDS_SOURCES = ["client", "third_party", "firm_operating"] as const;
export type FundsSource = (typeof FUNDS_SOURCES)[number];

export const ACCOUNT_TYPES = ["iolta", "trust"] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export const STATEMENT_SOURCES = ["manual", "csv_import", "bank_feed"] as const;
export type StatementSource = (typeof STATEMENT_SOURCES)[number];

export const STATEMENT_LINE_KINDS = ["deposit", "withdrawal", "fee", "iolta_interest", "iolta_remittance", "other"] as const;
export type StatementLineKind = (typeof STATEMENT_LINE_KINDS)[number];

export const SIGNOFF_ROLES = ["bookkeeper", "lawyer"] as const;
export type SignoffRole = (typeof SIGNOFF_ROLES)[number];

export function isTransactionKind(v: unknown): v is TransactionKind {
  return typeof v === "string" && (TRANSACTION_KINDS as readonly string[]).includes(v);
}
export function isFundsSource(v: unknown): v is FundsSource {
  return typeof v === "string" && (FUNDS_SOURCES as readonly string[]).includes(v);
}
export function isStatementLineKind(v: unknown): v is StatementLineKind {
  return typeof v === "string" && (STATEMENT_LINE_KINDS as readonly string[]).includes(v);
}
export function isSignoffRole(v: unknown): v is SignoffRole {
  return typeof v === "string" && (SIGNOFF_ROLES as readonly string[]).includes(v);
}

/** Machine-readable reasons a trust action was refused. Shown to staff and recorded in the audit trail. */
export type TrustRuleCode =
  | "INVALID_AMOUNT"
  | "REASON_REQUIRED"
  | "INVALID_DATE"
  | "FUTURE_DATE"
  | "PERIOD_CLOSED"
  | "ACCOUNT_CLOSED"
  | "UNKNOWN_SUBLEDGER"
  | "WRONG_ACCOUNT"
  | "WRONG_SUBLEDGER_KIND"
  | "SAME_SUBLEDGER"
  | "INSUFFICIENT_FUNDS"
  | "FUNDS_ON_HOLD"
  | "CROSS_CLIENT"
  | "COMMINGLING"
  | "PROCESSOR_FEE_NETTED"
  | "EARNED_BASIS_REQUIRED"
  | "PAYEE_REQUIRED"
  | "FUNDS_SOURCE_REQUIRED"
  | "CUSHION_NOT_ALLOWED"
  | "CUSHION_CAP_EXCEEDED"
  | "BELOW_RETAINER_FLOOR"
  | "REVERSAL_INVALID"
  | "ALREADY_REVERSED"
  | "UNEXPECTED_FIELD"
  | "HOLD_INVALID"
  | "MATTER_CLIENT_MISMATCH"
  | "STATEMENT_INVALID"
  | "RECONCILIATION_INVALID"
  | "SIGNOFF_INVALID"
  | "NOT_ALLOWED"
  | "NOT_FOUND"
  | "BAD_REQUEST";

const STATUS_BY_CODE: Partial<Record<TrustRuleCode, number>> = {
  NOT_ALLOWED: 403,
  NOT_FOUND: 404,
  BAD_REQUEST: 400,
};

/** A refused trust action. Never swallowed: routes return it as a 4xx and the attempt is audited. */
export class TrustRuleError extends Error {
  readonly status: number;
  constructor(
    readonly code: TrustRuleCode,
    message: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "TrustRuleError";
    this.status = STATUS_BY_CODE[code] ?? 422;
  }
}

// ---------------------------------------------------------------------------
// Calendar dates ('YYYY-MM-DD') and periods ('YYYY-MM'). Pure string maths in
// UTC so a ledger date never shifts with the server's time zone.
// ---------------------------------------------------------------------------

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const PERIOD_RE = /^(\d{4})-(\d{2})$/;

export function isIsoDate(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const m = DATE_RE.exec(v);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

export function isPeriod(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const m = PERIOD_RE.exec(v);
  return Boolean(m) && Number(m![2]) >= 1 && Number(m![2]) <= 12 && Number(m![1]) >= 1900;
}

/** First and last calendar day of a 'YYYY-MM' period. */
export function periodBounds(period: string): { start: string; end: string } {
  if (!isPeriod(period)) throw new TrustRuleError("BAD_REQUEST", `'${period}' is not a period (YYYY-MM).`);
  const [y, m] = period.split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: `${period}-01`, end: `${period}-${String(last).padStart(2, "0")}` };
}

export function periodOf(date: string): string {
  return date.slice(0, 7);
}

export function nextPeriod(period: string): string {
  const [y, m] = period.split("-").map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

export function previousPeriod(period: string): string {
  const [y, m] = period.split("-").map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Whole days from a to b (b − a). */
export function daysBetween(a: string, b: string): number {
  const ta = Date.parse(`${a}T00:00:00Z`);
  const tb = Date.parse(`${b}T00:00:00Z`);
  return Math.round((tb - ta) / 86_400_000);
}

/** Today's calendar date in an IANA time zone (the firm's), as 'YYYY-MM-DD'. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")}`;
  } catch {
    return now.toISOString().slice(0, 10);
  }
}
