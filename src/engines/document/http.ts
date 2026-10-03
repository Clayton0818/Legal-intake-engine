// HTTP helpers for the Document API (src/app/api/document). Pure: no
// database. The route wrapper lives in the app folder; the parts worth
// testing live here.

import { PendingApprovalError } from "@/compliance/approvals";
import { DocumentError } from "./errors";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID.test(v);
}

export function assertUuidParam(v: string, what: string): string {
  if (!isUuid(v)) throw new DocumentError(`Invalid ${what}.`, 400);
  return v;
}

export interface MappedError {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Errors a route answers itself INSIDE the transaction, so the access-log /
 * audit rows written for a denied or blocked attempt are committed. Anything
 * else is a 500 (and rolls back).
 */
export function mapHandledError(err: unknown): MappedError | null {
  if (err instanceof PendingApprovalError) {
    return { status: 423, body: { error: "pending_approval", gate: err.gateKey, pendingReviewers: err.pendingReviewers, message: err.placeholder } };
  }
  if (err instanceof DocumentError) {
    // Never reveal WHY access was refused (a screen's existence can itself be confidential).
    const details = err.status === 403 ? undefined : err.details;
    return { status: err.status, body: { error: err.message, ...(details ? { details } : {}) } };
  }
  return null;
}

export type Body = Record<string, unknown>;

export async function readJson(req: Request): Promise<Body> {
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    throw new DocumentError("The request body must be JSON.", 400);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new DocumentError("The request body must be a JSON object.", 400);
  return parsed as Body;
}

export function str(body: Body, key: string, opts: { required?: boolean; max?: number } = {}): string | null {
  const v = body[key];
  if (v === undefined || v === null || v === "") {
    if (opts.required) throw new DocumentError(`'${key}' is required.`, 422);
    return null;
  }
  if (typeof v !== "string") throw new DocumentError(`'${key}' must be text.`, 422);
  if (opts.max && v.length > opts.max) throw new DocumentError(`'${key}' is too long.`, 422);
  return v;
}

export function uuidOrNull(body: Body, key: string): string | null {
  const v = body[key];
  if (v === undefined || v === null || v === "") return null;
  if (!isUuid(v)) throw new DocumentError(`'${key}' must be an id.`, 422);
  return v;
}

export function bool(body: Body, key: string): boolean | undefined {
  const v = body[key];
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") throw new DocumentError(`'${key}' must be true or false.`, 422);
  return v;
}

export interface ParsedUpload {
  bytes: Uint8Array;
  filename: string | null;
  declaredMimeType: string | null;
  fields: Record<string, string>;
}

/**
 * Read a multipart upload: one `file` part plus optional text fields.
 * `maxBytes` is checked against Content-Length first so an oversize body is
 * refused before it is buffered.
 */
export async function readUpload(req: Request, maxBytes: number): Promise<ParsedUpload> {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len && len > maxBytes + 64 * 1024) throw new DocumentError("The file is larger than the firm's upload limit.", 413);
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data")) {
    throw new DocumentError("Upload as multipart/form-data with a 'file' field.", 415);
  }
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new DocumentError("Could not read the upload.", 400);
  }
  const file = form.get("file");
  if (!file || typeof file === "string") throw new DocumentError("A 'file' field is required.", 422);
  const fields: Record<string, string> = {};
  for (const [k, v] of form.entries()) if (typeof v === "string" && k !== "file") fields[k] = v;
  const bytes = new Uint8Array(await file.arrayBuffer());
  return { bytes, filename: file.name || null, declaredMimeType: file.type || null, fields };
}

/** RFC 6266 Content-Disposition with an ASCII fallback and a UTF-8 filename*. */
export function contentDisposition(filename: string, inline = false): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
