// HTTP helpers for the calendar-alerts API routes (src/app/api/calendar-alerts).
// Pure: no database. The route wrapper lives in the app folder.

import { PendingApprovalError } from "@/compliance/approvals";
import { AlertRuleError } from "./common";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    return { status: 423, body: { error: "pending_approval", gate: err.gateKey, pendingReviewers: err.pendingReviewers, message: err.placeholder } };
  }
  if (err instanceof AlertRuleError) return { status: err.status, body: { error: err.message } };
  return null;
}

export type Body = Record<string, unknown>;

export async function readBody(req: Request): Promise<Body> {
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    throw new AlertRuleError("The request body must be JSON.", 400);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new AlertRuleError("The request body must be a JSON object.", 400);
  return parsed as Body;
}

export function reqString(body: Body, key: string, max = 20_000): string {
  const v = body[key];
  if (typeof v !== "string" || !v.trim()) throw new AlertRuleError(`'${key}' is required.`);
  if (v.length > max) throw new AlertRuleError(`'${key}' is too long.`);
  return v.trim();
}

export function optString(body: Body, key: string, max = 20_000): string | null {
  const v = body[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new AlertRuleError(`'${key}' must be a string.`);
  if (v.length > max) throw new AlertRuleError(`'${key}' is too long.`);
  return v.trim() || null;
}

export function reqUuid(body: Body, key: string): string {
  const v = body[key];
  if (!isUuid(v)) throw new AlertRuleError(`'${key}' must be an id.`);
  return v;
}

export function optUuid(body: Body, key: string): string | null {
  const v = body[key];
  if (v === undefined || v === null) return null;
  if (!isUuid(v)) throw new AlertRuleError(`'${key}' must be an id.`);
  return v;
}

export function uuidList(body: Body, key: string): string[] {
  const v = body[key];
  if (!Array.isArray(v) || !v.every(isUuid)) throw new AlertRuleError(`'${key}' must be a list of ids.`);
  return v as string[];
}

export function optBool(body: Body, key: string): boolean | undefined {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") throw new AlertRuleError(`'${key}' must be true or false.`);
  return v;
}

export function optInt(body: Body, key: string): number | null {
  const v = body[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== "number" || !Number.isInteger(v)) throw new AlertRuleError(`'${key}' must be a whole number.`);
  return v;
}

export function reqDateTime(body: Body, key: string): Date {
  const d = optDateTime(body, key);
  if (!d) throw new AlertRuleError(`'${key}' is required (ISO date-time).`);
  return d;
}

export function optDateTime(body: Body, key: string): Date | null {
  const v = body[key];
  if (v === undefined || v === null) return null;
  const d = typeof v === "string" ? new Date(v) : null;
  if (!d || Number.isNaN(d.getTime())) throw new AlertRuleError(`'${key}' must be an ISO date-time.`);
  return d;
}

export function oneOf<T extends string>(body: Body, key: string, allowed: readonly T[]): T {
  const v = body[key];
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) throw new AlertRuleError(`'${key}' must be one of: ${allowed.join(", ")}.`);
  return v as T;
}

export function assertUuidParam(id: string, what = "id"): string {
  if (!isUuid(id)) throw new AlertRuleError(`Invalid ${what}.`, 404);
  return id;
}

export function queryUuid(url: URL, key: string): string | undefined {
  const v = url.searchParams.get(key);
  if (v === null || v === "") return undefined;
  if (!isUuid(v)) throw new AlertRuleError(`'${key}' must be an id.`);
  return v;
}

/** Parse an inbound court email pushed by an adapter (shape only; classification happens in the service). */
export function parseInboundCourtEmail(body: Body) {
  const auth = (body.auth ?? {}) as Record<string, unknown>;
  const verdict = (k: string) => {
    const v = auth[k];
    return typeof v === "string" ? (v.toLowerCase() as "pass") : null;
  };
  const attachments = Array.isArray(body.attachments) ? body.attachments : [];
  if (attachments.length > 50) throw new AlertRuleError("Too many attachments.");
  return {
    externalId: reqString(body, "externalId", 500),
    sourceAccount: optString(body, "sourceAccount", 500),
    fromAddress: reqString(body, "fromAddress", 500),
    fromDisplayName: optString(body, "fromDisplayName", 500),
    subject: reqString(body, "subject", 2000),
    bodyText: optString(body, "bodyText", 500_000) ?? "",
    receivedAt: reqDateTime(body, "receivedAt"),
    auth: { spf: verdict("spf"), dkim: verdict("dkim"), dmarc: verdict("dmarc"), dkimDomain: typeof auth.dkimDomain === "string" ? auth.dkimDomain : null },
    attachments: attachments.map((a, i) => {
      const o = (a ?? {}) as Record<string, unknown>;
      if (typeof o.filename !== "string" || !o.filename) throw new AlertRuleError(`Attachment ${i + 1} needs a filename.`);
      return {
        filename: o.filename.slice(0, 500),
        mimeType: typeof o.mimeType === "string" ? o.mimeType : null,
        sizeBytes: typeof o.sizeBytes === "number" ? o.sizeBytes : null,
        sha256: typeof o.sha256 === "string" ? o.sha256 : null,
      };
    }),
  };
}
