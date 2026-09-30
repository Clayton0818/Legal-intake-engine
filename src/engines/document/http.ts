// HTTP helpers for the Document engine's API routes (src/app/api/document).
// Pure: no database. The route wrapper lives in the app folder.

import { PendingApprovalError } from "@/compliance/approvals";
import { DocumentError } from "./common";

export const DEV_USER_HEADER = "x-user-id";
export const DEV_PARTY_HEADER = "x-party-id";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID.test(v);
}

type Env = { NODE_ENV?: string; ALLOW_DEV_USER_HEADER?: string };

/**
 * LOCAL ADAPTER until real sign-in (c34) exists: the acting staff user comes
 * from `x-user-id` and the acting client (portal) from `x-party-id`. Accepted
 * outside production, or when an operator sets ALLOW_DEV_USER_HEADER=1.
 */
export function resolveActor(
  headers: Pick<Headers, "get">,
  kind: "user" | "party",
  env: Env = process.env as Env
): { ok: true; id: string } | { ok: false; status: number; error: string } {
  const allowed = env.NODE_ENV !== "production" || env.ALLOW_DEV_USER_HEADER === "1";
  if (!allowed) return { ok: false, status: 401, error: "Sign-in is required." };
  const header = kind === "user" ? DEV_USER_HEADER : DEV_PARTY_HEADER;
  const raw = headers.get(header)?.trim();
  if (!raw) return { ok: false, status: 401, error: `Sign-in is required (${header} header until c34).` };
  if (!isUuid(raw)) return { ok: false, status: 400, error: "Invalid id." };
  return { ok: true, id: raw };
}

export interface MappedError {
  status: number;
  body: Record<string, unknown>;
}

/** Errors a route answers itself (so audit rows for blocked/denied attempts commit). */
export function mapHandledError(err: unknown): MappedError | null {
  if (err instanceof PendingApprovalError) {
    return { status: 423, body: { error: "pending_approval", gate: err.gateKey, pendingReviewers: err.pendingReviewers, message: err.placeholder } };
  }
  if (err instanceof DocumentError) return { status: err.status, body: { error: err.message, ...(err.details ? { details: err.details } : {}) } };
  return null;
}

export type Body = Record<string, unknown>;

export async function readBody(req: Request): Promise<Body> {
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    throw new DocumentError("The request body must be JSON.", 400);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new DocumentError("The request body must be a JSON object.", 400);
  return parsed as Body;
}

export function reqString(body: Body, key: string): string {
  const v = body[key];
  if (typeof v !== "string" || !v.trim()) throw new DocumentError(`'${key}' is required.`, 422);
  return v.trim();
}

export function optString(body: Body, key: string): string | undefined {
  const v = body[key];
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string") throw new DocumentError(`'${key}' must be a string.`, 422);
  return v.trim();
}

export function reqUuid(body: Body, key: string): string {
  const v = body[key];
  if (!isUuid(v)) throw new DocumentError(`'${key}' must be an id.`, 422);
  return v;
}

export function optUuid(body: Body, key: string): string | undefined {
  const v = body[key];
  if (v === undefined || v === null || v === "") return undefined;
  if (!isUuid(v)) throw new DocumentError(`'${key}' must be an id.`, 422);
  return v;
}

export function uuidList(body: Body, key: string): string[] {
  const v = body[key];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || !v.every(isUuid)) throw new DocumentError(`'${key}' must be a list of ids.`, 422);
  return v as string[];
}

export function oneOf<T extends string>(body: Body, key: string, values: readonly T[]): T {
  const v = body[key];
  if (typeof v !== "string" || !(values as readonly string[]).includes(v)) {
    throw new DocumentError(`'${key}' must be one of: ${values.join(", ")}.`, 422);
  }
  return v as T;
}

export function optBool(body: Body, key: string): boolean | undefined {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") throw new DocumentError(`'${key}' must be true or false.`, 422);
  return v;
}

export function optInt(body: Body, key: string): number | undefined {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v)) throw new DocumentError(`'${key}' must be a whole number.`, 422);
  return v;
}

export function optDate(body: Body, key: string): Date | undefined {
  const v = body[key];
  if (v === undefined || v === null || v === "") return undefined;
  const d = typeof v === "string" ? new Date(v) : null;
  if (!d || Number.isNaN(d.getTime())) throw new DocumentError(`'${key}' must be an ISO date-time.`, 422);
  return d;
}

/** Base64 file content in a JSON body (v1 upload transport; multipart can come later). */
export function reqBase64(body: Body, key: string, maxBytes: number): Uint8Array {
  const v = reqString(body, key);
  if (!/^[A-Za-z0-9+/=\s]+$/.test(v)) throw new DocumentError(`'${key}' must be base64.`, 422);
  const bytes = Buffer.from(v, "base64");
  if (bytes.byteLength === 0) throw new DocumentError("The file is empty.", 422);
  if (bytes.byteLength > maxBytes) throw new DocumentError(`The file is larger than ${Math.round(maxBytes / 1024 / 1024)} MB.`, 413);
  return new Uint8Array(bytes);
}
