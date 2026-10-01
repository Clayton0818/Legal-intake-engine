// HTTP helpers for the Conflict-check API routes (src/app/api/conflict-check).
// Pure: no database. The route wrapper lives in the app folder; the parts
// worth testing live here.

import { PendingApprovalError } from "@/compliance/approvals";
import { AccessDeniedError } from "./access";
import { LetterNotNeutralError } from "./letters";
import type { InquiryPartyInput } from "./sync";
import { INDEX_ROLES, NAME_TYPES, type IndexRole, type NameType } from "./types";
import { ConflictError } from "./util";

export const DEV_USER_HEADER = "x-user-id";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID.test(v);
}

/**
 * LOCAL ADAPTER until real sign-in (c34) exists: the acting user comes from
 * the `x-user-id` header. Accepted outside production, or when an operator
 * explicitly sets ALLOW_DEV_USER_HEADER=1 for a staging pilot. The user must
 * still exist in the firm with the right role/grant (loadAccess), so an
 * unknown id simply has no access.
 */
export function resolveActingUserId(
  headers: Pick<Headers, "get">,
  env: { NODE_ENV?: string; ALLOW_DEV_USER_HEADER?: string } = process.env
): { ok: true; userId: string } | { ok: false; status: number; error: string } {
  const allowed = env.NODE_ENV !== "production" || env.ALLOW_DEV_USER_HEADER === "1";
  if (!allowed) return { ok: false, status: 401, error: "Sign-in is required." };
  const raw = headers.get(DEV_USER_HEADER)?.trim();
  if (!raw) return { ok: false, status: 401, error: `Sign-in is required (${DEV_USER_HEADER} header until c34).` };
  if (!isUuid(raw)) return { ok: false, status: 400, error: "Invalid user id." };
  return { ok: true, userId: raw };
}

export interface MappedError {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Errors a route handles itself (so the transaction commits and the audit
 * row for the blocked or denied attempt is kept). Anything else is a 500.
 */
export function mapHandledError(err: unknown): MappedError | null {
  if (err instanceof PendingApprovalError) {
    return { status: 423, body: { error: "pending_approval", gate: err.gateKey, pendingReviewers: err.pendingReviewers, message: err.placeholder } };
  }
  if (err instanceof AccessDeniedError) return { status: 403, body: { error: "Not allowed: this needs the conflicts role." } };
  if (err instanceof LetterNotNeutralError) return { status: 422, body: { error: "The letter is not neutral.", details: err.problems } };
  if (err instanceof ConflictError) return { status: err.status, body: { error: err.message, ...(err.details ? { details: err.details } : {}) } };
  return null;
}

// ---------------------------------------------------------------------------
// Tiny body readers (throw a 400/422 ConflictError on bad input)
// ---------------------------------------------------------------------------

export type Body = Record<string, unknown>;

export async function readBody(req: Request): Promise<Body> {
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    throw new ConflictError("The request body must be JSON.", 400);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ConflictError("The request body must be a JSON object.", 400);
  return parsed as Body;
}

export function reqString(body: Body, key: string): string {
  const v = body[key];
  if (typeof v !== "string" || !v.trim()) throw new ConflictError(`'${key}' is required.`, 422);
  return v;
}

export function optString(body: Body, key: string): string | null {
  const v = body[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new ConflictError(`'${key}' must be a string.`, 422);
  return v;
}

export function reqUuid(body: Body, key: string): string {
  const v = body[key];
  if (!isUuid(v)) throw new ConflictError(`'${key}' must be an id.`, 422);
  return v;
}

export function optUuid(body: Body, key: string): string | null {
  const v = body[key];
  if (v === undefined || v === null) return null;
  if (!isUuid(v)) throw new ConflictError(`'${key}' must be an id.`, 422);
  return v;
}

export function uuidList(body: Body, key: string): string[] {
  const v = body[key];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || !v.every(isUuid)) throw new ConflictError(`'${key}' must be a list of ids.`, 422);
  return v as string[];
}

export function optBool(body: Body, key: string): boolean | undefined {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") throw new ConflictError(`'${key}' must be true or false.`, 422);
  return v;
}

export function optDate(body: Body, key: string): Date | null {
  const v = body[key];
  if (v === undefined || v === null) return null;
  const d = typeof v === "string" ? new Date(v) : null;
  if (!d || Number.isNaN(d.getTime())) throw new ConflictError(`'${key}' must be an ISO date-time.`, 422);
  return d;
}

export function oneOf<T extends string>(body: Body, key: string, allowed: readonly T[]): T {
  const v = body[key];
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) {
    throw new ConflictError(`'${key}' must be one of: ${allowed.join(", ")}.`, 422);
  }
  return v as T;
}

export function assertUuidParam(id: string, what = "id"): string {
  if (!isUuid(id)) throw new ConflictError(`Invalid ${what}.`, 404);
  return id;
}

// ---------------------------------------------------------------------------
// Structured inputs
// ---------------------------------------------------------------------------


function optStr(o: Record<string, unknown>, key: string, i: number): string | null {
  const v = o[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new ConflictError(`Party ${i + 1}: '${key}' must be a string.`, 422);
  return v;
}

/** Parse the `parties` list of an inquiry check request (shape only; rules are in validateInquiryParties). */
export function parseInquiryParties(raw: unknown): InquiryPartyInput[] {
  if (!Array.isArray(raw)) throw new ConflictError("'parties' must be a list.", 422);
  if (raw.length > 50) throw new ConflictError("Too many parties in one check.", 422);
  return raw.map((item, i) => {
    if (!item || typeof item !== "object") throw new ConflictError(`Party ${i + 1} must be an object.`, 422);
    const o = item as Record<string, unknown>;
    const role = o.role;
    if (typeof role !== "string" || !(INDEX_ROLES as readonly string[]).includes(role)) {
      throw new ConflictError(`Party ${i + 1}: role must be one of ${INDEX_ROLES.join(", ")}.`, 422);
    }
    const variants = o.variants === undefined || o.variants === null ? [] : o.variants;
    if (!Array.isArray(variants)) throw new ConflictError(`Party ${i + 1}: 'variants' must be a list.`, 422);
    const kind = o.kind === "organization" ? "organization" : "person";
    const completeness = o.completeness === "partial" ? "partial" : "full";
    const reuse = o.reusePartyId;
    if (reuse !== undefined && reuse !== null && !isUuid(reuse)) throw new ConflictError(`Party ${i + 1}: 'reusePartyId' must be an id.`, 422);
    return {
      name: optStr(o, "name", i),
      role: role as IndexRole,
      relationship: optStr(o, "relationship", i),
      kind,
      dateOfBirth: optStr(o, "dateOfBirth", i),
      email: optStr(o, "email", i),
      phone: optStr(o, "phone", i),
      nameUnknown: o.nameUnknown === true,
      completeness,
      reusePartyId: (reuse as string | undefined) ?? null,
      variants: variants.map((v, j) => {
        const vo = (v ?? {}) as Record<string, unknown>;
        if (typeof vo.name !== "string" || typeof vo.type !== "string" || !(NAME_TYPES as readonly string[]).includes(vo.type)) {
          throw new ConflictError(`Party ${i + 1}, name ${j + 1}: give a name and a type (${NAME_TYPES.join(", ")}).`, 422);
        }
        return { name: vo.name, type: vo.type as NameType };
      }),
    };
  });
}
