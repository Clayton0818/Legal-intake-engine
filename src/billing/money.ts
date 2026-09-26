// Money is always an integer number of US cents. Never floats, never strings
// with decimals inside business logic. Converting to/from display strings
// happens only at the edges.

export type Cents = number;

export function assertCents(value: number, label = "amount"): asserts value is Cents {
  if (!Number.isInteger(value)) {
    throw new Error(`${label} must be an integer number of cents, got ${value}`);
  }
}

export function assertNonNegativeCents(value: number, label = "amount"): asserts value is Cents {
  assertCents(value, label);
  if (value < 0) throw new Error(`${label} must not be negative, got ${value}`);
}

export function dollars(amount: number): Cents {
  return Math.round(amount * 100);
}

export function formatUsd(cents: Cents): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100).toLocaleString("en-US");
  const frac = String(abs % 100).padStart(2, "0");
  return `${sign}$${whole}.${frac}`;
}

/** Split `total` into `parts` near-equal integer amounts; the remainder goes on the last part. */
export function splitEvenly(total: Cents, parts: number): Cents[] {
  assertNonNegativeCents(total, "total");
  if (!Number.isInteger(parts) || parts < 1) throw new Error(`parts must be a positive integer, got ${parts}`);
  const base = Math.floor(total / parts);
  const out = Array.from({ length: parts }, () => base);
  out[parts - 1] = base + (total - base * parts);
  return out;
}

/** Apply a percentage in basis points (1% = 100 bp), rounding half up to the cent. */
export function applyBasisPoints(amount: Cents, basisPoints: number): Cents {
  assertCents(amount);
  if (!Number.isInteger(basisPoints)) throw new Error("basisPoints must be an integer");
  return Math.round((amount * basisPoints) / 10_000);
}
