// HTTP helpers for the calendar-core API routes (src/app/api/calendar-core).
// Pure: no database. The route wrapper lives in the app folder.

import { PendingApprovalError } from "@/compliance/approvals";
import { CalendarCoreError } from "./errors";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID.test(v);
}

export interface MappedError {
  status: number;
  body: Record<string, unknown>;
}

/** Errors a route answers itself (inside the transaction, so audit rows for blocked attempts are kept). */
export function mapHandledError(err: unknown): MappedError | null {
  if (err instanceof PendingApprovalError) {
    return {
      status: 423,
      body: { error: "pending_approval", gate: err.gateKey, pendingReviewers: err.pendingReviewers, message: err.placeholder },
    };
  }
  if (err instanceof CalendarCoreError) {
    return { status: err.status, body: { error: err.message, ...(err.details.length > 0 ? { details: err.details } : {}) } };
  }
  return null;
}

export type Body = Record<string, unknown>;

export async function readBody(req: Request): Promise<Body> {
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    throw new CalendarCoreError("The request body must be JSON.", 400);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CalendarCoreError("The request body must be a JSON object.", 400);
  }
  return parsed as Body;
}

export function reqString(body: Body, key: string): string {
  const v = body[key];
  if (typeof v !== "string" || !v.trim()) throw new CalendarCoreError(`'${key}' is required.`, 422);
  return v.trim();
}

export function optString(body: Body, key: string): string | null {
  const v = body[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new CalendarCoreError(`'${key}' must be a string.`, 422);
  return v.trim() || null;
}

export function reqUuid(body: Body, key: string): string {
  const v = body[key];
  if (!isUuid(v)) throw new CalendarCoreError(`'${key}' must be an id.`, 422);
  return v;
}

export function optUuid(body: Body, key: string): string | null {
  const v = body[key];
  if (v === undefined || v === null) return null;
  if (!isUuid(v)) throw new CalendarCoreError(`'${key}' must be an id.`, 422);
  return v;
}

export function uuidList(body: Body, key: string): string[] {
  const v = body[key];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || !v.every(isUuid)) throw new CalendarCoreError(`'${key}' must be a list of ids.`, 422);
  return v as string[];
}

export function optBool(body: Body, key: string): boolean | undefined {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") throw new CalendarCoreError(`'${key}' must be true or false.`, 422);
  return v;
}

export function reqDateTime(body: Body, key: string): Date {
  const d = optDateTime(body, key);
  if (!d) throw new CalendarCoreError(`'${key}' is required (ISO date-time).`, 422);
  return d;
}

export function optDateTime(body: Body, key: string): Date | null {
  const v = body[key];
  if (v === undefined || v === null) return null;
  const d = typeof v === "string" ? new Date(v) : null;
  if (!d || Number.isNaN(d.getTime())) throw new CalendarCoreError(`'${key}' must be an ISO date-time.`, 422);
  return d;
}

/** A calendar date 'YYYY-MM-DD' (legal dates are never converted through a time zone). */
export function reqIsoDate(body: Body, key: string): string {
  const v = body[key];
  if (typeof v !== "string" || !isIsoDate(v)) throw new CalendarCoreError(`'${key}' must be a date 'YYYY-MM-DD'.`, 422);
  return v;
}

export function optIsoDate(body: Body, key: string): string | null {
  const v = body[key];
  if (v === undefined || v === null) return null;
  return reqIsoDate(body, key);
}

export function isIsoDate(v: string): boolean {
  if (!ISO_DATE.test(v)) return false;
  const [y, m, d] = v.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

export function oneOf<T extends string>(body: Body, key: string, allowed: readonly T[]): T {
  const v = body[key];
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) {
    throw new CalendarCoreError(`'${key}' must be one of: ${allowed.join(", ")}.`, 422);
  }
  return v as T;
}

export function assertUuidParam(id: string, what = "id"): string {
  if (!isUuid(id)) throw new CalendarCoreError(`Invalid ${what}.`, 404);
  return id;
}

/** Query-string helpers for GET routes. */
export function queryDate(url: URL, key: string): Date | null {
  const v = url.searchParams.get(key);
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new CalendarCoreError(`'${key}' must be an ISO date-time.`, 422);
  return d;
}

export function queryUuid(url: URL, key: string): string | null {
  const v = url.searchParams.get(key);
  if (!v) return null;
  if (!isUuid(v)) throw new CalendarCoreError(`'${key}' must be an id.`, 422);
  return v;
}
