// HTTP helpers for the Billing & trust API routes (src/app/api/billing-trust).
// Pure: no database. The route wrapper lives in the app folder; the parts
// worth testing live here.

import { PendingApprovalError } from "@/compliance/approvals";
import { MoneyError, jsonSafe, parseCents, type Cents } from "./money";
import type { ManualMatch } from "./reconciliation";
import type { TransactionInput } from "./ledger";
import {
  ACCOUNT_TYPES,
  TrustRuleError,
  isFundsSource,
  isIsoDate,
  isPeriod,
  isSignoffRole,
  isTransactionKind,
  type AccountType,
  type SignoffRole,
} from "./types";

export interface MappedError {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Errors a route handles itself, returned INSIDE the tenant transaction so the
 * audit row for a blocked / refused / denied attempt is committed. Anything
 * else is a 500 and rolls back.
 */
export function mapHandledError(err: unknown): MappedError | null {
  if (err instanceof PendingApprovalError) {
    return {
      status: 423,
      body: { error: "pending_approval", gate: err.gateKey, pendingReviewers: err.pendingReviewers, message: err.placeholder },
    };
  }
  if (err instanceof TrustRuleError) {
    return { status: err.status, body: { error: err.message, code: err.code, details: jsonSafe(err.details) } };
  }
  if (err instanceof MoneyError) return { status: 422, body: { error: err.message, code: "INVALID_AMOUNT" } };
  return null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID.test(v);
}

export type Body = Record<string, unknown>;

function bad(message: string): TrustRuleError {
  return new TrustRuleError("BAD_REQUEST", message);
}

export async function readBody(req: Request): Promise<Body> {
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    throw bad("The request body must be JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw bad("The request body must be a JSON object.");
  return parsed as Body;
}

export function reqString(body: Body, key: string): string {
  const v = body[key];
  if (typeof v !== "string" || !v.trim()) throw bad(`'${key}' is required.`);
  return v;
}

export function optString(body: Body, key: string): string | null {
  const v = body[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw bad(`'${key}' must be text.`);
  return v;
}

export function reqUuid(body: Body, key: string): string {
  const v = body[key];
  if (!isUuid(v)) throw bad(`'${key}' must be an id.`);
  return v;
}

export function optUuid(body: Body, key: string): string | null {
  const v = body[key];
  if (v === undefined || v === null || v === "") return null;
  if (!isUuid(v)) throw bad(`'${key}' must be an id.`);
  return v;
}

export function reqCents(body: Body, key: string): Cents {
  return parseCents(body[key], key);
}

export function optCents(body: Body, key: string): Cents | null {
  const v = body[key];
  if (v === undefined || v === null || v === "") return null;
  return parseCents(v, key);
}

export function reqDate(body: Body, key: string): string {
  const v = body[key];
  if (!isIsoDate(v)) throw bad(`'${key}' must be a date (YYYY-MM-DD).`);
  return v;
}

export function reqPeriod(body: Body, key: string): string {
  const v = body[key];
  if (!isPeriod(v)) throw bad(`'${key}' must be a month (YYYY-MM).`);
  return v;
}

export function reqSignoffRole(body: Body, key: string): SignoffRole {
  const v = body[key];
  if (!isSignoffRole(v)) throw bad(`'${key}' must be 'bookkeeper' or 'lawyer'.`);
  return v;
}

export function optAccountType(body: Body, key: string): AccountType {
  const v = body[key];
  if (v === undefined || v === null) return "iolta";
  if (typeof v !== "string" || !(ACCOUNT_TYPES as readonly string[]).includes(v)) throw bad(`'${key}' must be 'iolta' or 'trust'.`);
  return v as AccountType;
}

/** Parse a posting request. Amounts are whole cents (number or string). */
export function parseTransactionInput(body: Body, trustAccountId: string): TransactionInput {
  const kind = body.kind;
  if (!isTransactionKind(kind)) throw bad("'kind' is not a known entry kind.");
  const fundsSource = body.fundsSource;
  if (fundsSource !== undefined && fundsSource !== null && !isFundsSource(fundsSource)) {
    throw bad("'fundsSource' must be 'client', 'third_party' or 'firm_operating'.");
  }
  return {
    kind,
    trustAccountId,
    effectiveDate: reqDate(body, "effectiveDate"),
    reason: typeof body.reason === "string" ? body.reason : "",
    memo: optString(body, "memo"),
    counterparty: optString(body, "counterparty"),
    reference: optString(body, "reference"),
    invoiceId: optUuid(body, "invoiceId"),
    earnedBasis: optString(body, "earnedBasis"),
    fundsSource: (fundsSource as TransactionInput["fundsSource"]) ?? null,
    processorFeeCents: optCents(body, "processorFeeCents"),
    amount: optCents(body, "amountCents"),
    subledgerId: optUuid(body, "subledgerId"),
    toSubledgerId: optUuid(body, "toSubledgerId"),
    reversesTransactionId: optUuid(body, "reversesTransactionId"),
  };
}

export function parseManualMatches(v: unknown): ManualMatch[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw bad("'manualMatches' must be a list.");
  return v.map((m, i) => {
    if (!m || typeof m !== "object") throw bad(`manualMatches[${i}] must be an object.`);
    const o = m as Body;
    const ids = o.transactionIds;
    if (!isUuid(o.statementLineId) || !Array.isArray(ids) || !ids.every(isUuid)) {
      throw bad(`manualMatches[${i}] needs a statementLineId and a list of transactionIds.`);
    }
    return { statementLineId: o.statementLineId, transactionIds: ids as string[] };
  });
}
