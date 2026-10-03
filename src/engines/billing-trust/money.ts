// Money for the trust ledger: integer cents as JavaScript `bigint`, never
// floats. Pure; no database.
//
// Every amount that reaches the ledger goes through parseCents(), which
// accepts only whole cents (a bigint, a safe integer number, or a string of
// digits) or an exact decimal-dollar string ("1234.50"). Anything that could
// carry float rounding (1234.505, 0.1 + 0.2, 1e21 …) is rejected.

export type Cents = bigint;

/** Upper bound for a single amount: $1 trillion. Far beyond any trust deposit; well inside bigint(64). */
export const MAX_AMOUNT_CENTS: Cents = 100_000_000_000_000n;
/** Postgres bigint range (balances and amounts are stored as int8). */
export const PG_BIGINT_MAX: Cents = 9_223_372_036_854_775_807n;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

/**
 * Parse an amount in CENTS. Accepts a bigint, a safe-integer number, or a
 * string of digits (optionally signed). Throws MoneyError otherwise.
 */
export function parseCents(value: unknown, field = "amount"): Cents {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new MoneyError(`${field} must be a whole number of cents.`);
    return BigInt(value);
  }
  if (typeof value === "string") {
    const s = value.trim();
    if (!/^-?\d{1,18}$/.test(s)) throw new MoneyError(`${field} must be a whole number of cents.`);
    return BigInt(s);
  }
  throw new MoneyError(`${field} must be a whole number of cents.`);
}

/**
 * Parse a dollar string with at most two decimals ("1,234.50", "-12", "$7.05")
 * into cents, exactly (string arithmetic, no floats). Used for bank CSVs.
 */
export function parseDollars(value: string, field = "amount"): Cents {
  let s = value.trim().replace(/[$,\s]/g, "");
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true; // accounting style (12.00)
    s = s.slice(1, -1);
  }
  if (s.startsWith("-")) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.startsWith("+")) {
    s = s.slice(1);
  }
  const m = /^(\d{1,16})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) throw new MoneyError(`${field} '${value}' is not a dollar amount with at most two decimals.`);
  const whole = BigInt(m[1]!);
  const frac = BigInt((m[2] ?? "").padEnd(2, "0"));
  const cents = whole * 100n + frac;
  return negative ? -cents : cents;
}

/** A strictly positive amount within MAX_AMOUNT_CENTS. */
export function assertPositiveAmount(amount: Cents, field = "amount"): Cents {
  if (amount <= 0n) throw new MoneyError(`${field} must be more than zero.`);
  if (amount > MAX_AMOUNT_CENTS) throw new MoneyError(`${field} is larger than the maximum allowed.`);
  return amount;
}

export function sumCents(values: Iterable<Cents>): Cents {
  let total = 0n;
  for (const v of values) total += v;
  return total;
}

export function absCents(v: Cents): Cents {
  return v < 0n ? -v : v;
}

export function minCents(a: Cents, b: Cents): Cents {
  return a < b ? a : b;
}

export function maxCents(a: Cents, b: Cents): Cents {
  return a > b ? a : b;
}

/** "$1,234.56" / "-$0.05". Exact (no floats). */
export function formatCents(v: Cents): string {
  const negative = v < 0n;
  const abs = negative ? -v : v;
  const dollars = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const cents = (abs % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}$${dollars}.${cents}`;
}

/** Plain "1234.56" (CSV exports). */
export function centsToDecimalString(v: Cents): string {
  const negative = v < 0n;
  const abs = negative ? -v : v;
  return `${negative ? "-" : ""}${(abs / 100n).toString()}.${(abs % 100n).toString().padStart(2, "0")}`;
}

/**
 * Make a value JSON-safe: every bigint becomes its decimal string (route
 * responses and jsonb columns cannot carry bigint). Dates become ISO strings.
 */
export function jsonSafe<T>(value: T): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((v) => jsonSafe(v));
  if (value instanceof Map) return Object.fromEntries([...value.entries()].map(([k, v]) => [String(k), jsonSafe(v)]));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) out[k] = jsonSafe(v);
    }
    return out;
  }
  return value;
}
